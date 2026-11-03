import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickDiffRef } from './diff-base.mjs';

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
