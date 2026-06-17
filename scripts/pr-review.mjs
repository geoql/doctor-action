// @ts-check
//
// Pure logic + orchestrator for the doctor-action PR review step.
//
// This file is intentionally dependency-light: the pure functions
// (parseDiffPositions, mapFindingsToComments, selectStickyComment,
// filterAlreadyPosted, buildSummary) have ZERO imports and are unit-tested in
// pr-review.test.mjs. The default-exported run() wires them to an authenticated
// octokit (passed in by actions/github-script@v7) and performs the network I/O.
//
// GitHub only allows review comments on diff positions, so any finding whose
// file+line is not on an added line in the PR diff is skipped (rolled into the
// summary) rather than crashing the step.

export const STICKY_MARKER = '<!-- geoql-doctor-report -->';
const DOCS_BASE = 'https://docs.the-doctor.report/rules/';

/** @param {string} ruleId */
function docsUrl(ruleId) {
  return `${DOCS_BASE}${ruleId}`;
}

/**
 * Normalize a path: strip a leading "./", collapse backslashes to forward
 * slashes, and drop a redundant leading slash. Keeps diff paths and finding
 * paths comparable.
 * @param {string} p
 */
function normalizePath(p) {
  return String(p ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/**
 * Parse a unified diff into a per-file map of {newLineNumber -> diffPosition}
 * for ADDED lines only.
 *
 * `position` is the GitHub review-comment coordinate: it starts at 1 on the
 * line immediately after the FIRST `@@` hunk header for a file and increments
 * for every subsequent line in the diff body — including later `@@` headers and
 * context/removed lines — until the next file. Only added (`+`) lines are
 * recorded as commentable targets, because inline comments must land on
 * added/changed lines.
 *
 * @param {string | undefined | null} diff
 * @returns {Map<string, Map<number, number>>}
 */
export function parseDiffPositions(diff) {
  /** @type {Map<string, Map<number, number>>} */
  const byFile = new Map();
  if (!diff || typeof diff !== 'string') return byFile;

  const lines = diff.split('\n');
  /** @type {Map<number, number> | null} */
  let current = null;
  let position = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = null;
      inHunk = false;
      continue;
    }
    // The "+++ b/path" line names the new-side file. Use it to key the map and
    // reset the per-file position counter.
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      if (raw === '/dev/null') {
        current = null;
        continue;
      }
      const path = normalizePath(raw.replace(/^b\//, ''));
      current = new Map();
      byFile.set(path, current);
      position = 0;
      inHunk = false;
      continue;
    }
    if (line.startsWith('--- ')) continue;

    if (line.startsWith('@@')) {
      if (!current) continue;
      // @@ -old,oldCount +new,newCount @@
      const m = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) continue;
      newLine = Number(m[1]);
      // The first hunk header for a file does not consume a position; every
      // later header does (it appears as a body line in GitHub's counting).
      if (inHunk) position += 1;
      inHunk = true;
      continue;
    }

    if (!inHunk || !current) continue;

    const marker = line[0];
    if (marker === '+') {
      position += 1;
      current.set(newLine, position);
      newLine += 1;
    } else if (marker === '-') {
      position += 1;
      // removed line: advances position, not newLine
    } else if (marker === '\\') {
      // "\ No newline at end of file" — not a real diff line, ignore.
    } else {
      // context line (leading space) or blank line within the hunk
      position += 1;
      newLine += 1;
    }
  }

  return byFile;
}

/**
 * Hidden per-finding marker embedded in each inline comment body so a later run
 * can detect what it already posted (idempotency without an external store).
 * @param {{ file: string, line: number, ruleId: string }} f
 */
export function findingMarker(f) {
  return `<!-- geoql-doctor:${normalizePath(f.file)}:${f.line}:${f.ruleId} -->`;
}

const SEVERITY_ICON = { error: '🔴', warn: '🟡', info: '🔵' };

/**
 * @param {{ ruleId: string, severity: string, message: string, recommendation?: string }} d
 * @param {string} file
 * @param {number} line
 */
function inlineCommentBody(d, file, line) {
  const icon = SEVERITY_ICON[d.severity] ?? '⚪️';
  const parts = [
    `${icon} **${d.severity}** · \`${d.ruleId}\``,
    '',
    d.message,
  ];
  if (d.recommendation) {
    parts.push('', `**Fix:** ${d.recommendation}`);
  }
  parts.push('', `[Rule docs](${docsUrl(d.ruleId)})`);
  parts.push('', findingMarker({ file, line, ruleId: d.ruleId }));
  return parts.join('\n');
}

/**
 * Map raw diagnostics to GitHub review-comment objects, keeping only those that
 * fall on an added line in the diff. Findings outside the diff are returned in
 * `skipped` so the caller can fold them into the summary.
 *
 * @param {ReadonlyArray<{ file: string, line: number, column?: number, ruleId: string, severity: string, message: string, recommendation?: string }>} diagnostics
 * @param {Map<string, Map<number, number>>} positions
 * @param {{ prefix?: string }} [opts] - working-directory prefix to prepend to
 *   finding paths so they align with repo-rooted diff paths.
 * @returns {{ comments: Array<{ path: string, position: number, body: string }>, skipped: Array<object> }}
 */
export function mapFindingsToComments(diagnostics, positions, opts = {}) {
  const prefix = opts.prefix ? normalizePath(opts.prefix).replace(/\/+$/, '') : '';
  /** @type {Array<{ path: string, position: number, body: string }>} */
  const comments = [];
  /** @type {Array<object>} */
  const skipped = [];
  const seen = new Set();

  for (const d of diagnostics ?? []) {
    if (!d || typeof d.file !== 'string' || typeof d.line !== 'number') {
      if (d) skipped.push(d);
      continue;
    }
    const rel = normalizePath(d.file);
    const path = prefix ? `${prefix}/${rel}` : rel;
    const fileMap = positions.get(path);
    const position = fileMap?.get(d.line);
    if (!position) {
      skipped.push(d);
      continue;
    }
    const dedupeKey = `${path}:${position}:${d.ruleId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    comments.push({ path, position, body: inlineCommentBody(d, path, d.line) });
  }

  return { comments, skipped };
}

/**
 * Find the id of the existing sticky summary comment by its hidden marker.
 * @param {ReadonlyArray<{ id: number, body?: string }> | undefined | null} comments
 * @param {string} marker
 * @returns {number | null}
 */
export function selectStickyComment(comments, marker) {
  for (const c of comments ?? []) {
    if (typeof c?.body === 'string' && c.body.includes(marker)) return c.id;
  }
  return null;
}

/**
 * Drop inline comments whose finding marker already appears in an existing
 * review comment (so re-runs don't pile up duplicates).
 * @param {ReadonlyArray<{ path: string, position: number, body: string }>} comments
 * @param {ReadonlyArray<{ body?: string }> | undefined | null} existingReviewComments
 */
export function filterAlreadyPosted(comments, existingReviewComments) {
  const existingMarkers = new Set();
  for (const c of existingReviewComments ?? []) {
    const body = typeof c?.body === 'string' ? c.body : '';
    const m = body.match(/<!-- geoql-doctor:[^>]+ -->/g);
    if (m) for (const marker of m) existingMarkers.add(marker.trim());
  }
  if (existingMarkers.size === 0) return [...comments];
  return comments.filter((c) => {
    const m = c.body.match(/<!-- geoql-doctor:[^>]+ -->/);
    return !m || !existingMarkers.has(m[0].trim());
  });
}

/** @param {string} toolName */
function binName(toolName) {
  return String(toolName ?? '').replace('@geoql/', '');
}

const MAX_SUMMARY_FINDINGS = 10;

/**
 * Build the sticky summary markdown. Always starts with STICKY_MARKER so the
 * upsert can find it.
 *
 * @param {{
 *   toolName: string,
 *   score: number,
 *   bySeverity: { error: number, warn: number, info: number },
 *   diagnostics: ReadonlyArray<{ file: string, line: number, column?: number, ruleId: string, severity: string, message: string }>,
 *   serverUrl?: string,
 *   repository?: string,
 *   runId?: string,
 *   skippedCount?: number,
 * }} input
 */
export function buildSummary(input) {
  const {
    toolName,
    score,
    bySeverity,
    diagnostics = [],
    serverUrl = 'https://github.com',
    repository = '',
    runId = '',
  } = input;

  const errors = Number(bySeverity?.error ?? 0);
  const warns = Number(bySeverity?.warn ?? 0);
  const infos = Number(bySeverity?.info ?? 0);
  const total = diagnostics.length;

  const runLink =
    repository && runId
      ? `${serverUrl}/${repository}/actions/runs/${runId}`
      : `${serverUrl}`;

  /** @type {string[]} */
  const lines = [
    STICKY_MARKER,
    `## 🛡 ${toolName} — Score: **${score}**`,
    '',
    `**${errors} error${errors === 1 ? '' : 's'}**, **${warns} warn${warns === 1 ? '' : 's'}**, ${infos} info`,
  ];

  if (total === 0) {
    lines.push('', '✓ No actionable findings — the code is clean.');
  } else {
    const sorted = [...diagnostics].sort((a, b) => {
      const order = { error: 0, warn: 1, info: 2 };
      const sa = order[a.severity] ?? 3;
      const sb = order[b.severity] ?? 3;
      if (sa !== sb) return sa - sb;
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      return a.line - b.line;
    });
    lines.push('', '<details open>', `<summary>Top findings (${Math.min(total, MAX_SUMMARY_FINDINGS)} of ${total})</summary>`, '');
    lines.push('| Severity | Rule | Location | Message |', '| --- | --- | --- | --- |');
    for (const d of sorted.slice(0, MAX_SUMMARY_FINDINGS)) {
      const icon = SEVERITY_ICON[d.severity] ?? '⚪️';
      const loc = `\`${normalizePath(d.file)}:${d.line}\``;
      const rule = `[\`${d.ruleId}\`](${docsUrl(d.ruleId)})`;
      const msg = String(d.message ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
      lines.push(`| ${icon} ${d.severity} | ${rule} | ${loc} | ${msg} |`);
    }
    lines.push('', '</details>');
  }

  if (typeof input.skippedCount === 'number' && input.skippedCount > 0) {
    lines.push(
      '',
      `> ${input.skippedCount} finding${input.skippedCount === 1 ? '' : 's'} outside the PR diff are not shown inline.`,
    );
  }

  lines.push(
    '',
    '---',
    `[View all findings](${runLink}) · Run \`${binName(toolName)} explain <rule>\` locally for details.`,
  );

  return `${lines.join('\n')}\n`;
}

/**
 * Orchestrator invoked from actions/github-script@v7.
 *
 * @param {{
 *   github: any,
 *   context: any,
 *   core: any,
 *   report: { tool?: { name?: string }, score?: { value?: number, bySeverity?: any }, diagnostics?: any[] },
 *   mode: 'summary' | 'review' | 'both',
 *   workingDirectory?: string,
 * }} args
 */
export async function run({ github, context, core, report, mode, workingDirectory }) {
  const toolName = report?.tool?.name ?? '@geoql/doctor';
  const score = Number(report?.score?.value ?? 0);
  const bySeverity = report?.score?.bySeverity ?? { error: 0, warn: 0, info: 0 };
  const diagnostics = Array.isArray(report?.diagnostics) ? report.diagnostics : [];

  const isPr = context?.eventName === 'pull_request' || context?.eventName === 'pull_request_target';
  const prNumber = context?.payload?.pull_request?.number;

  if (!isPr || !prNumber) {
    core.info('Not a pull_request event — skipping PR comments.');
    return;
  }

  const { owner, repo } = context.repo;
  const wantsReview = mode === 'review' || mode === 'both';
  const wantsSummary = mode === 'summary' || mode === 'both';

  // Working-directory prefix: the CLI reports paths relative to where it ran,
  // but the diff is repo-rooted. e.g. working-directory "packages/app" → prefix.
  const wd = (workingDirectory ?? '.').replace(/^\.\/?/, '').replace(/\/+$/, '');
  const prefix = wd && wd !== '.' ? wd : '';

  let skippedCount = 0;

  if (wantsReview) {
    try {
      const { data: prFiles } = await github.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      // Reconstruct a per-file position map straight from the patch hunks the
      // API returns (avoids a second raw-diff fetch).
      /** @type {Map<string, Map<number, number>>} */
      const positions = new Map();
      for (const f of prFiles) {
        if (!f.patch) continue;
        const fakeDiff = `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`;
        const parsed = parseDiffPositions(fakeDiff);
        const m = parsed.get(normalizePath(f.filename));
        if (m) positions.set(normalizePath(f.filename), m);
      }

      const { comments, skipped } = mapFindingsToComments(diagnostics, positions, { prefix });
      skippedCount = skipped.length;

      // Pull existing review comments to avoid re-posting on re-runs.
      const existing = await github.paginate(github.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      const fresh = filterAlreadyPosted(comments, existing);

      if (fresh.length > 0) {
        // One batched review, not N individual comment calls.
        await github.rest.pulls.createReview({
          owner,
          repo,
          pull_number: prNumber,
          event: 'COMMENT',
          comments: fresh.map((c) => ({ path: c.path, position: c.position, body: c.body })),
        });
        core.info(`Posted ${fresh.length} inline review comment(s).`);
      } else {
        core.info('No new inline comments to post.');
      }
    } catch (err) {
      // Never crash the build over review-comment failures (e.g. position drift
      // when the head moved). Degrade to summary-only.
      core.warning(`Inline review failed, continuing with summary only: ${err?.message ?? err}`);
    }
  }

  if (wantsSummary) {
    const body = buildSummary({
      toolName,
      score,
      bySeverity,
      diagnostics,
      serverUrl: context.serverUrl ?? 'https://github.com',
      repository: `${owner}/${repo}`,
      runId: String(context.runId ?? ''),
      skippedCount,
    });

    const existingIssueComments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
    const stickyId = selectStickyComment(existingIssueComments, STICKY_MARKER);

    if (stickyId !== null) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: stickyId, body });
      core.info(`Updated sticky summary comment #${stickyId}.`);
    } else {
      await github.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
      core.info('Created sticky summary comment.');
    }
  }
}

export default run;
