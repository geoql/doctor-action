import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDiffPositions,
  mapFindingsToComments,
  selectStickyComment,
  filterAlreadyPosted,
  buildSummary,
  findingMarker,
  STICKY_MARKER,
} from './pr-review.mjs';

// A two-hunk unified diff for one file, plus a second file. Hand-computed
// positions are the contract GitHub's review API expects: the line just below
// the first `@@` is position 1, every subsequent line (incl. later `@@`
// headers) increments by 1, and removed (`-`) lines do not advance newLine.
const DIFF = [
  'diff --git a/src/Foo.vue b/src/Foo.vue',
  'index 1111111..2222222 100644',
  '--- a/src/Foo.vue',
  '+++ b/src/Foo.vue',
  '@@ -1,3 +1,4 @@',
  ' line1 context',
  ' line2 context',
  '+line3 added',
  ' line4 context',
  '@@ -10,2 +11,3 @@',
  ' line11 context',
  '+line12 added',
  ' line13 context',
  'diff --git a/src/Bar.ts b/src/Bar.ts',
  'index 3333333..4444444 100644',
  '--- a/src/Bar.ts',
  '+++ b/src/Bar.ts',
  '@@ -0,0 +1,2 @@',
  '+export const a = 1',
  '+export const b = 2',
  '',
].join('\n');

test('parseDiffPositions maps only ADDED right-side lines to diff positions across hunks', () => {
  const positions = parseDiffPositions(DIFF);

  const foo = positions.get('src/Foo.vue');
  assert.ok(foo, 'Foo.vue should be present');
  // Inline comments target added/changed lines only. Context lines are NOT
  // commentable targets here (they roll into the summary instead), but the
  // GitHub position counter still advances through them.
  // First hunk: context(p1) context(p2) +line3(p3) context(p4).
  assert.equal(foo.get(3), 3);
  assert.equal(foo.get(1), undefined); // context line, not a comment target
  assert.equal(foo.get(4), undefined); // context line, not a comment target
  // Second `@@` header consumes p5; context line11(p6) +line12(p7) context line13(p8).
  assert.equal(foo.get(12), 7);
  assert.equal(foo.get(11), undefined);
  assert.equal(foo.get(13), undefined);

  const bar = positions.get('src/Bar.ts');
  assert.ok(bar, 'Bar.ts should be present');
  assert.equal(bar.get(1), 1);
  assert.equal(bar.get(2), 2);
});

test('parseDiffPositions tolerates empty/garbage input without throwing', () => {
  assert.equal(parseDiffPositions('').size, 0);
  assert.equal(parseDiffPositions(undefined).size, 0);
  assert.equal(parseDiffPositions('not a diff at all').size, 0);
});

test('mapFindingsToComments: a finding on a changed line maps to a position', () => {
  const positions = parseDiffPositions(DIFF);
  const diagnostics = [
    {
      file: 'src/Foo.vue',
      line: 12,
      column: 3,
      ruleId: 'vue-doctor/template/v-for-has-key',
      severity: 'error',
      message: 'v-for without :key.',
      recommendation: 'Add :key.',
    },
  ];

  const { comments, skipped } = mapFindingsToComments(diagnostics, positions);

  assert.equal(skipped.length, 0);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].path, 'src/Foo.vue');
  assert.equal(comments[0].position, 7);
  assert.match(comments[0].body, /v-for-has-key/);
  assert.match(comments[0].body, /Add :key\./); // recommendation rendered
  assert.match(comments[0].body, /docs\.the-doctor\.report\/rules\//); // docs link derived
  assert.match(comments[0].body, /geoql-doctor:/); // per-finding hidden marker
});

test('mapFindingsToComments: a finding outside the diff is skipped, never crashes', () => {
  const positions = parseDiffPositions(DIFF);
  const diagnostics = [
    { file: 'src/Foo.vue', line: 999, column: 1, ruleId: 'r/x', severity: 'warn', message: 'm' },
    { file: 'src/Unchanged.vue', line: 5, column: 1, ruleId: 'r/y', severity: 'error', message: 'm' },
  ];

  const { comments, skipped } = mapFindingsToComments(diagnostics, positions);

  assert.equal(comments.length, 0);
  assert.equal(skipped.length, 2);
});

test('mapFindingsToComments: working-directory prefix aligns finding paths to diff paths', () => {
  const positions = parseDiffPositions(DIFF);
  // CLI ran inside src/, so it reports "Foo.vue"; the diff is repo-rooted "src/Foo.vue".
  const diagnostics = [
    { file: 'Foo.vue', line: 3, column: 1, ruleId: 'r/x', severity: 'error', message: 'm' },
  ];

  const { comments } = mapFindingsToComments(diagnostics, positions, { prefix: 'src' });

  assert.equal(comments.length, 1);
  assert.equal(comments[0].path, 'src/Foo.vue');
  assert.equal(comments[0].position, 3);
});

test('mapFindingsToComments dedupes identical path+position+rule', () => {
  const positions = parseDiffPositions(DIFF);
  const d = { file: 'src/Foo.vue', line: 3, column: 1, ruleId: 'r/x', severity: 'error', message: 'm' };
  const { comments } = mapFindingsToComments([d, { ...d }], positions);
  assert.equal(comments.length, 1);
});

test('selectStickyComment finds the existing bot comment by hidden marker', () => {
  const existing = [
    { id: 1, body: 'unrelated human comment' },
    { id: 2, body: `${STICKY_MARKER}\n## old report` },
    { id: 3, body: 'another' },
  ];
  assert.equal(selectStickyComment(existing, STICKY_MARKER), 2);
});

test('selectStickyComment returns null when no marked comment exists (create path)', () => {
  const existing = [{ id: 1, body: 'hello' }];
  assert.equal(selectStickyComment(existing, STICKY_MARKER), null);
  assert.equal(selectStickyComment([], STICKY_MARKER), null);
  assert.equal(selectStickyComment(undefined, STICKY_MARKER), null);
});

test('filterAlreadyPosted drops findings already commented in a prior run', () => {
  const positions = parseDiffPositions(DIFF);
  const diagnostics = [
    { file: 'src/Foo.vue', line: 3, column: 1, ruleId: 'r/x', severity: 'error', message: 'm' },
    { file: 'src/Foo.vue', line: 12, column: 1, ruleId: 'r/y', severity: 'warn', message: 'm2' },
  ];
  const { comments } = mapFindingsToComments(diagnostics, positions);

  // Simulate a prior review comment carrying the first finding's marker.
  const existingReviewComments = [
    { body: `something\n${findingMarker({ file: 'src/Foo.vue', line: 3, ruleId: 'r/x' })}` },
  ];

  const fresh = filterAlreadyPosted(comments, existingReviewComments);
  assert.equal(fresh.length, 1);
  assert.match(fresh[0].body, /r\/y/);
});

test('buildSummary embeds the sticky marker, score, counts and a link', () => {
  const md = buildSummary({
    toolName: '@geoql/vue-doctor',
    score: 90,
    bySeverity: { error: 2, warn: 1, info: 0 },
    diagnostics: [
      { file: 'src/Foo.vue', line: 3, column: 1, ruleId: 'r/x', severity: 'error', message: 'bad thing' },
    ],
    serverUrl: 'https://github.com',
    repository: 'geoql/app',
    runId: '123',
  });

  assert.ok(md.startsWith(STICKY_MARKER), 'summary must start with the hidden marker');
  assert.match(md, /Score: \*\*90\*\*|Score: 90|90/);
  assert.match(md, /2 error/);
  assert.match(md, /1 warn/);
  assert.match(md, /r\/x/);
  assert.match(md, /github\.com\/geoql\/app\/actions\/runs\/123/);
});

test('buildSummary handles the clean (no findings) case', () => {
  const md = buildSummary({
    toolName: '@geoql/nuxt-doctor',
    score: 100,
    bySeverity: { error: 0, warn: 0, info: 0 },
    diagnostics: [],
    serverUrl: 'https://github.com',
    repository: 'geoql/app',
    runId: '1',
  });
  assert.ok(md.startsWith(STICKY_MARKER));
  assert.match(md, /No actionable findings|✓|clean/i);
});
