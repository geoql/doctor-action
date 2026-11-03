// @ts-check
//
// Pick the git ref to pass to `--changed-files-from` on a pull request so the
// changed set is the PR head vs its base — never the synthetic merge ref vs the
// merge base (which folds in base-branch drift). The CLI diffs <ref> against
// the working tree, so the right ref depends on what was checked out:
//
// - merge ref (actions/checkout default): HEAD is a merge commit whose second
//   parent is the PR head. Its first parent is the base it was merged onto, so
//   `diff <first-parent> <worktree>` is exactly the head-vs-base change set.
// - PR head (`ref: head.sha`): diff against merge-base(base, head).
//
// Usage: node diff-base.mjs <base-sha> <head-sha> [files|merge-base]
// Writes `ref=` and `source=` to $GITHUB_OUTPUT (empty ref = keep plain --diff).
//
// `merge-base` mode is for `--scope <mode> --base <ref>`: the CLI computes
// merge-base(<ref>, HEAD) itself, which a depth-1 checkout cannot answer. The
// script deepens the history until it can, and leaves `ref` empty otherwise.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {{
 *   baseSha?: string,
 *   headSha?: string,
 *   worktreeSha?: string,
 *   worktreeParents?: string[],
 *   mergeBase?: string,
 * }} input
 * @returns {{ ref: string, source: 'merge-parent' | 'merge-base' | 'base' } | null}
 */
export function pickDiffRef({ baseSha, headSha, worktreeSha, worktreeParents = [], mergeBase }) {
  if (!baseSha || !headSha) return null;
  if (worktreeParents.length === 2 && worktreeParents[1] === headSha && worktreeParents[0]) {
    return { ref: worktreeParents[0], source: 'merge-parent' };
  }
  if (mergeBase) return { ref: mergeBase, source: 'merge-base' };
  return { ref: baseSha, source: 'base' };
}

/** @param {string[]} args */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function main() {
  const [baseSha = '', headSha = '', mode = 'files'] = process.argv.slice(2);
  if (baseSha && headSha) {
    // Best effort: a depth-1 checkout has neither the base nor the head
    // commit objects. Fetch both so they resolve as refs.
    git(['fetch', '--no-tags', '--depth=1', 'origin', baseSha, headSha]);
  }
  const worktreeSha = git(['rev-parse', 'HEAD']);
  // `cat-file` reads the raw parent lines, which survive a shallow checkout
  // (rev-list hides a shallow commit's parents).
  const worktreeParents = git(['cat-file', '-p', 'HEAD'])
    .split('\n')
    .filter((l) => l.startsWith('parent '))
    .map((l) => l.slice('parent '.length).trim());
  const mergeBase = baseSha && headSha ? git(['merge-base', baseSha, headSha]) : '';

  let picked = pickDiffRef({ baseSha, headSha, worktreeSha, worktreeParents, mergeBase });
  if (picked && mode === 'merge-base' && !git(['merge-base', picked.ref, 'HEAD'])) {
    // Merge ref: fetching HEAD at depth 2 un-shallows it onto its parents.
    // PR head: deepen both sides until they meet.
    if (picked.source === 'merge-parent') git(['fetch', '--no-tags', '--depth=2', 'origin', worktreeSha]);
    for (const depth of [50, 500]) {
      if (git(['merge-base', picked.ref, 'HEAD'])) break;
      git(['fetch', '--no-tags', `--deepen=${depth}`, 'origin', baseSha, headSha]);
    }
    if (picked.source !== 'merge-parent') {
      const deepened = git(['merge-base', baseSha, headSha]);
      if (deepened) picked = { ref: deepened, source: 'merge-base' };
    }
    if (!git(['merge-base', picked.ref, 'HEAD'])) {
      console.log(
        `::warning::doctor could not find a merge-base between ${picked.ref} and HEAD. Use fetch-depth: 0 on actions/checkout.`,
      );
      picked = null;
    }
  }
  // The chosen ref must exist locally or the CLI exits 2.
  const usable = picked && git(['rev-parse', '--verify', '--quiet', `${picked.ref}^{commit}`]) ? picked : null;
  if (picked && !usable) {
    console.log(
      `::warning::doctor could not resolve the PR base commit ${picked.ref}; falling back to --diff (changes vs HEAD). Use fetch-depth: 0 on actions/checkout.`,
    );
  } else if (usable) {
    console.log(`doctor diff base: ${usable.ref} (${usable.source})`);
  }

  const out = `ref=${usable?.ref ?? ''}\nsource=${usable?.source ?? ''}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, out);
  else process.stdout.write(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
