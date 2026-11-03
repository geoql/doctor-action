// @ts-check
//
// Derive the action outputs (score + counts) and the $GITHUB_STEP_SUMMARY
// markdown from the doctor JSON report. Pure helpers are unit-tested in
// report-summary.test.mjs; main() does the file I/O.
//
// Usage: node report-summary.mjs <doctor-report.json>

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const DOCS_BASE = 'https://docs.the-doctor.report/rules/';
const DEFAULT_TOP_RULES = 10;

/** @param {string} p */
function normalizePath(p) {
  return String(p ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/** @param {unknown} v */
function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/**
 * @param {any} report
 * @returns {{ score: number, findings: number, errors: number, warnings: number, infos: number, affectedFiles: number }}
 */
export function computeCounts(report) {
  const diagnostics = Array.isArray(report?.diagnostics) ? report.diagnostics : [];
  const bySeverity = report?.score?.bySeverity;

  const tally = { error: 0, warn: 0, info: 0 };
  for (const d of diagnostics) {
    if (d?.severity in tally) tally[/** @type {'error'|'warn'|'info'} */ (d.severity)] += 1;
  }

  const files = new Set();
  for (const d of diagnostics) {
    if (typeof d?.file === 'string' && d.file) files.add(normalizePath(d.file));
  }

  const hasBySeverity = bySeverity && typeof bySeverity === 'object';
  return {
    score: toCount(report?.score?.value),
    findings: diagnostics.length,
    errors: hasBySeverity ? toCount(bySeverity.error) : tally.error,
    warnings: hasBySeverity ? toCount(bySeverity.warn) : tally.warn,
    infos: hasBySeverity ? toCount(bySeverity.info) : tally.info,
    affectedFiles: files.size,
  };
}

/** @param {ReturnType<typeof computeCounts>} c */
export function renderOutputs(c) {
  return [
    `score=${c.score}`,
    `findings-count=${c.findings}`,
    `error-count=${c.errors}`,
    `warning-count=${c.warnings}`,
    `info-count=${c.infos}`,
    `affected-files=${c.affectedFiles}`,
    '',
  ].join('\n');
}

/**
 * @param {any} report
 * @param {{ topRules?: number }} [opts]
 */
export function buildStepSummary(report, opts = {}) {
  const topRules = opts.topRules ?? DEFAULT_TOP_RULES;
  const c = computeCounts(report);
  const toolName = report?.tool?.name ?? '@geoql/doctor';
  const version = report?.tool?.version ? ` v${report.tool.version}` : '';
  const diagnostics = Array.isArray(report?.diagnostics) ? report.diagnostics : [];

  const lines = [
    `## 🛡 ${toolName}${version} — Score: **${c.score}**`,
    '',
    '| Severity | Count |',
    '| --- | --- |',
    `| 🔴 Errors | ${c.errors} |`,
    `| 🟡 Warnings | ${c.warnings} |`,
    `| 🔵 Info | ${c.infos} |`,
    `| Affected files | ${c.affectedFiles} |`,
  ];

  if (diagnostics.length === 0) {
    lines.push('', '✓ No findings — the code is clean.');
    return `${lines.join('\n')}\n`;
  }

  /** @type {Map<string, { count: number, severity: string }>} */
  const byRule = new Map();
  for (const d of diagnostics) {
    if (typeof d?.ruleId !== 'string') continue;
    const entry = byRule.get(d.ruleId) ?? { count: 0, severity: d.severity };
    entry.count += 1;
    byRule.set(d.ruleId, entry);
  }
  const ranked = [...byRule.entries()].sort((a, b) =>
    b[1].count !== a[1].count ? b[1].count - a[1].count : a[0] < b[0] ? -1 : 1,
  );

  lines.push(
    '',
    `### Top rules (${Math.min(ranked.length, topRules)} of ${ranked.length})`,
    '',
    '| Rule | Severity | Findings |',
    '| --- | --- | --- |',
  );
  for (const [ruleId, { count, severity }] of ranked.slice(0, topRules)) {
    lines.push(`| \`${ruleId}\` ([docs](${DOCS_BASE}${ruleId})) | ${severity} | ${count} |`);
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const reportPath = process.argv[2] || 'doctor-report.json';
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (err) {
    console.log(`::warning::Could not read doctor report at ${reportPath}: ${/** @type {Error} */ (err).message}`);
  }
  const outputs = renderOutputs(computeCounts(report));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, outputs);
  else process.stdout.write(outputs);

  const summary = report ? buildStepSummary(report) : '## 🛡 doctor\n\nNo report was produced.\n';
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else process.stdout.write(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
