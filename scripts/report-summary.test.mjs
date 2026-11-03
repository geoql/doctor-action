import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeCounts, buildStepSummary, renderOutputs } from './report-summary.mjs';

const REPORT = {
  tool: { name: '@geoql/vue-doctor', version: '1.5.0' },
  score: { value: 82, bySeverity: { error: 2, warn: 3, info: 1 } },
  diagnostics: [
    { file: 'src/A.vue', line: 1, ruleId: 'r/a', severity: 'error', message: 'm' },
    { file: 'src/A.vue', line: 2, ruleId: 'r/a', severity: 'error', message: 'm' },
    { file: './src/B.vue', line: 3, ruleId: 'r/b', severity: 'warn', message: 'm' },
    { file: 'src/C.ts', line: 4, ruleId: 'r/b', severity: 'warn', message: 'm' },
    { file: 'src/C.ts', line: 5, ruleId: 'r/c', severity: 'warn', message: 'm' },
    { file: 'src/D.ts', line: 6, ruleId: 'r/d', severity: 'info', message: 'm' },
  ],
};

test('computeCounts reads score, severity counts and distinct affected files', () => {
  assert.deepEqual(computeCounts(REPORT), {
    score: 82,
    findings: 6,
    errors: 2,
    warnings: 3,
    infos: 1,
    affectedFiles: 4,
  });
});

test('computeCounts falls back to counting diagnostics when bySeverity is absent', () => {
  const counts = computeCounts({ score: { value: 50 }, diagnostics: REPORT.diagnostics });
  assert.equal(counts.errors, 2);
  assert.equal(counts.warnings, 3);
  assert.equal(counts.infos, 1);
});

test('computeCounts tolerates an empty / malformed report', () => {
  assert.deepEqual(computeCounts(undefined), {
    score: 0,
    findings: 0,
    errors: 0,
    warnings: 0,
    infos: 0,
    affectedFiles: 0,
  });
});

test('renderOutputs emits every action output key', () => {
  const out = renderOutputs(computeCounts(REPORT));
  assert.equal(
    out,
    [
      'score=82',
      'findings-count=6',
      'error-count=2',
      'warning-count=3',
      'info-count=1',
      'affected-files=4',
      '',
    ].join('\n'),
  );
});

test('buildStepSummary shows score, counts by severity and top rules by occurrence', () => {
  const md = buildStepSummary(REPORT);
  assert.match(md, /vue-doctor/);
  assert.match(md, /Score: \*\*82\*\*/);
  assert.match(md, /\| 🔴 Errors \| 2 \|/);
  assert.match(md, /\| 🟡 Warnings \| 3 \|/);
  assert.match(md, /\| 🔵 Info \| 1 \|/);
  assert.match(md, /\| Affected files \| 4 \|/);
  // r/a (2) and r/b (2) outrank r/c and r/d (1); ties broken by rule id.
  const ra = md.indexOf('`r/a`');
  const rb = md.indexOf('`r/b`');
  const rc = md.indexOf('`r/c`');
  assert.ok(ra > 0 && rb > ra && rc > rb, 'top rules must be ordered by count');
  assert.match(md, /docs\.the-doctor\.report\/rules\/r\/a/);
});

test('buildStepSummary caps the top-rules table', () => {
  const diagnostics = Array.from({ length: 30 }, (_, i) => ({
    file: `f${i}.vue`,
    line: 1,
    ruleId: `r/${String(i).padStart(2, '0')}`,
    severity: 'warn',
    message: 'm',
  }));
  const md = buildStepSummary({ score: { value: 1 }, diagnostics }, { topRules: 5 });
  assert.equal((md.match(/^\| `r\//gm) ?? []).length, 5);
});

test('buildStepSummary handles the clean case', () => {
  const md = buildStepSummary({ score: { value: 100 }, diagnostics: [] });
  assert.match(md, /No findings/);
  assert.doesNotMatch(md, /Top rules/);
});
