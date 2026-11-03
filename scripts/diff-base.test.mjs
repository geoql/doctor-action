import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pickDiffRef } from './diff-base.mjs';

const SCRIPT = fileURLToPath(new URL('./diff-base.mjs', import.meta.url));

const BASE = 'b'.repeat(40);
const HEAD = 'h'.repeat(40);
const MERGE = 'm'.repeat(40);
const MB = 'f'.repeat(40);
const NEW_BASE = 'n'.repeat(40);

test('non-PR runs return null (caller keeps plain --diff)', () => {
  assert.equal(pickDiffRef({ baseSha: '', headSha: '' }), null);
});

test('merge-ref checkout diffs against the merge commit base parent, not the merge base', () => {
  // HEAD is the synthetic merge (parents: base tip, PR head). Diffing its first
  // parent against the worktree yields exactly the head-vs-base change set,
  // with no base-branch drift.
  const r = pickDiffRef({
    baseSha: BASE,
    headSha: HEAD,
    worktreeSha: MERGE,
    worktreeParents: [NEW_BASE, HEAD],
    mergeBase: MB,
  });
  assert.deepEqual(r, { ref: NEW_BASE, source: 'merge-parent' });
});

test('head checkout diffs against merge-base(base, head)', () => {
  const r = pickDiffRef({
    baseSha: BASE,
    headSha: HEAD,
    worktreeSha: HEAD,
    worktreeParents: ['x'.repeat(40)],
    mergeBase: MB,
  });
  assert.deepEqual(r, { ref: MB, source: 'merge-base' });
});

test('head checkout with unreachable merge-base falls back to base sha', () => {
  const r = pickDiffRef({
    baseSha: BASE,
    headSha: HEAD,
    worktreeSha: HEAD,
    worktreeParents: [],
    mergeBase: '',
  });
  assert.deepEqual(r, { ref: BASE, source: 'base' });
});

test('unknown worktree prefers merge-base, then base sha', () => {
  assert.deepEqual(
    pickDiffRef({ baseSha: BASE, headSha: HEAD, worktreeSha: 'z'.repeat(40), worktreeParents: [], mergeBase: MB }),
    { ref: MB, source: 'merge-base' },
  );
  assert.deepEqual(
    pickDiffRef({ baseSha: BASE, headSha: HEAD, worktreeSha: 'z'.repeat(40), worktreeParents: [] }),
    { ref: BASE, source: 'base' },
  );
});

test('a merge commit whose second parent is NOT the PR head is not treated as the merge ref', () => {
  const r = pickDiffRef({
    baseSha: BASE,
    headSha: HEAD,
    worktreeSha: MERGE,
    worktreeParents: [NEW_BASE, 'o'.repeat(40)],
    mergeBase: MB,
  });
  assert.deepEqual(r, { ref: MB, source: 'merge-base' });
});

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

/**
 * An origin with main (3 commits) + a PR branch, plus GitHub's synthetic merge
 * commit at refs/pull/1/merge. Returns the shas.
 */
function makeOrigin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-base-origin-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(path.join(dir, `f${n}.ts`), `export const x${n} = ${n};\n`);
    git(dir, ['add', '.']);
    git(dir, ['commit', '-qm', `c${n}`]);
  }
  const fork = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['checkout', '-qb', 'pr']);
  fs.writeFileSync(path.join(dir, 'pr.ts'), 'export const pr = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'pr']);
  const head = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['checkout', '-q', 'main']);
  fs.writeFileSync(path.join(dir, 'f4.ts'), 'export const x4 = 4;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'c4']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['merge', '-q', '--no-ff', '-m', 'merge', head]);
  const merge = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['update-ref', 'refs/pull/1/merge', merge]);
  git(dir, ['reset', '-q', '--hard', base]);
  return { dir, fork, base, head, merge };
}

/** A depth-1 clone checked out at `sha`, like actions/checkout. */
function shallowCheckout(origin, sha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-base-work-'));
  git(dir, ['init', '-q']);
  git(dir, ['remote', 'add', 'origin', `file://${origin}`]);
  git(dir, ['fetch', '-q', '--no-tags', '--depth=1', 'origin', sha]);
  git(dir, ['checkout', '-q', '--detach', sha]);
  return dir;
}

/** @param {string} cwd @param {string[]} args */
function runScript(cwd, args) {
  const out = path.join(cwd, '.gh-output');
  fs.writeFileSync(out, '');
  execFileSync('node', [SCRIPT, ...args], { cwd, env: { ...process.env, GITHUB_OUTPUT: out }, stdio: 'pipe' });
  return Object.fromEntries(
    fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => l.split('=')),
  );
}

test('merge-base mode on a shallow merge-ref checkout deepens so the CLI can compute merge-base', () => {
  const o = makeOrigin();
  const work = shallowCheckout(o.dir, o.merge);
  const out = runScript(work, [o.base, o.head, 'merge-base']);
  assert.equal(out.ref, o.base);
  assert.equal(out.source, 'merge-parent');
  assert.equal(git(work, ['merge-base', out.ref, 'HEAD']), o.base);
});

test('merge-base mode on a shallow head checkout deepens to the real merge-base', () => {
  const o = makeOrigin();
  const work = shallowCheckout(o.dir, o.head);
  const out = runScript(work, [o.base, o.head, 'merge-base']);
  assert.ok(out.ref, 'a ref must resolve');
  assert.equal(git(work, ['merge-base', out.ref, 'HEAD']), o.fork);
});

test('files mode (legacy diff) keeps the shallow behavior and needs no merge-base', () => {
  const o = makeOrigin();
  const work = shallowCheckout(o.dir, o.merge);
  const out = runScript(work, [o.base, o.head]);
  assert.equal(out.ref, o.base);
  assert.equal(out.source, 'merge-parent');
});
