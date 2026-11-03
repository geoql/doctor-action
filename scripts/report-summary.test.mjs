import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeCounts, buildStepSummary, renderOutputs, describeComparison } from './report-summary.mjs';

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
    newCount: null,
    fixedCount: null,
  });
});

test('computeCounts counts reported diagnostics, not the scored subset in bySeverity', () => {
  // The CLI scores a subset (bySeverity) but reports every diagnostic; the
  // counts must agree with findings-count and the top-rules table.
  const counts = computeCounts({
    score: { value: 97, bySeverity: { error: 0, warn: 2, info: 0 } },
    diagnostics: [
      ...REPORT.diagnostics.filter((d) => d.severity === 'warn'),
      { file: 'src/E.ts', line: 1, ruleId: 'r/e', severity: 'warn', message: 'm' },
      { file: 'src/F.ts', line: 1, ruleId: 'r/e', severity: 'warn', message: 'm' },
    ],
  });
  assert.equal(counts.findings, 5);
  assert.equal(counts.warnings, 5);
  assert.equal(counts.errors, 0);
});

test('computeCounts counts diagnostics when bySeverity is absent', () => {
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
    newCount: null,
    fixedCount: null,
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
      'new-count=',
      'fixed-count=',
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

const SHA = 'c0ffee1234567890c0ffee1234567890c0ffee12';

test('computeCounts reads new/fixed from the baseline summary', () => {
  const c = computeCounts({ ...REPORT, baseline: { file: 'b.json', matchedCount: 4, newCount: 2, fixedCount: 5 } });
  assert.equal(c.newCount, 2);
  assert.equal(c.fixedCount, 5);
  assert.match(renderOutputs(c), /^new-count=2$/m);
  assert.match(renderOutputs(c), /^fixed-count=5$/m);
});

test('describeComparison is null for a plain full run', () => {
  assert.equal(describeComparison(REPORT), null);
  assert.equal(describeComparison({ ...REPORT, scope: { mode: 'full' } }), null);
  assert.equal(describeComparison(undefined), null);
});

test('describeComparison shows new / fixed against a saved baseline', () => {
  const s = describeComparison({ baseline: { file: 'reports/doctor-baseline.json', newCount: 1, fixedCount: 3 } });
  assert.match(s, /\*\*1 new\*\*/);
  assert.match(s, /\*\*3 fixed\*\*/);
  assert.match(s, /`doctor-baseline\.json`/);
});

test('describeComparison names the scope and shortens a sha base', () => {
  const s = describeComparison({
    scope: { mode: 'changed', base: SHA },
    baseline: { file: `git:${SHA}`, newCount: 0, fixedCount: 2 },
  });
  assert.match(s, /Scope: `changed`/);
  assert.match(s, /`c0ffee1`/);
  assert.doesNotMatch(s, /c0ffee12345/);
  assert.match(s, /\*\*0 new\*\*/);
  assert.match(s, /\*\*2 fixed\*\*/);
});

test('describeComparison shows a lines scope without baseline counts', () => {
  const s = describeComparison({ scope: { mode: 'lines', base: 'origin/main' } });
  assert.match(s, /Scope: `lines` vs `origin\/main`/);
  assert.doesNotMatch(s, /new/);
});

test('buildStepSummary includes the comparison line when present', () => {
  const md = buildStepSummary({ ...REPORT, scope: { mode: 'changed', base: SHA }, baseline: { file: `git:${SHA}`, newCount: 6, fixedCount: 1 } });
  assert.match(md, /\*\*6 new\*\*/);
  assert.match(md, /\*\*1 fixed\*\*/);
  assert.doesNotMatch(buildStepSummary(REPORT), /new\*\*/);
});
