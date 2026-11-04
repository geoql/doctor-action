import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planDoctorArgs, meetsMinimumVersion, MIN_SCOPE_VERSION, MIN_SARIF_OUTPUT_VERSION } from './doctor-args.mjs';

const BASE = { preset: 'recommended', threshold: '0', failOn: 'error' };
const REF = 'a'.repeat(40);

test('defaults produce the unchanged pre-2.2 argv', () => {
  const plan = planDoctorArgs({ ...BASE });
  assert.deepEqual(plan.args, ['--preset', 'recommended', '--threshold', '0', '--fail-on', 'error']);
  assert.equal(plan.scope, 'full');
  assert.equal(plan.usesNewFlags, false);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.warnings, []);
});

test('legacy diff on a PR keeps --changed-files-from <ref> and warns it is deprecated', () => {
  const plan = planDoctorArgs({ ...BASE, diff: 'true', isPr: true, diffRef: REF });
  assert.deepEqual(plan.args.slice(-2), ['--changed-files-from', REF]);
  assert.equal(plan.scope, 'files');
  assert.equal(plan.usesNewFlags, false);
  assert.match(plan.warnings.join('\n'), /deprecated/);
});

test('legacy diff without a PR base keeps plain --diff', () => {
  const plan = planDoctorArgs({ ...BASE, diff: 'true', isPr: false, diffRef: '' });
  assert.deepEqual(plan.args.slice(-1), ['--diff']);
  assert.equal(plan.usesNewFlags, false);
});

test('scope on a PR maps to --scope + --base <PR base>', () => {
  for (const scope of ['files', 'changed', 'lines', 'contextual']) {
    const plan = planDoctorArgs({ ...BASE, scope, isPr: true, diffRef: REF });
    assert.deepEqual(plan.args.slice(-4), ['--scope', scope, '--base', REF]);
    assert.equal(plan.scope, scope);
    assert.equal(plan.usesNewFlags, true);
    assert.deepEqual(plan.errors, []);
  }
});

test('scope is case/space tolerant and full is explicit no-op', () => {
  assert.equal(planDoctorArgs({ ...BASE, scope: ' Changed ', isPr: true, diffRef: REF }).scope, 'changed');
  const full = planDoctorArgs({ ...BASE, scope: 'full', isPr: true, diffRef: REF });
  assert.equal(full.args.includes('--scope'), false);
  assert.equal(full.usesNewFlags, false);
});

test('an unknown scope is an error', () => {
  const plan = planDoctorArgs({ ...BASE, scope: 'diffs', isPr: true, diffRef: REF });
  assert.match(plan.errors.join('\n'), /Invalid scope 'diffs'/);
});

test('a non-full scope outside a pull request scans the full project with a notice', () => {
  const plan = planDoctorArgs({ ...BASE, scope: 'changed', isPr: false });
  assert.equal(plan.scope, 'full');
  assert.equal(plan.args.includes('--scope'), false);
  assert.equal(plan.usesNewFlags, false);
  assert.match(plan.notices.join('\n'), /pull request/);
});

test('a non-full scope on a PR without a resolvable base fails with a fetch-depth hint', () => {
  const plan = planDoctorArgs({ ...BASE, scope: 'changed', isPr: true, diffRef: '' });
  assert.match(plan.errors.join('\n'), /fetch-depth: 0/);
});

test('scope wins over the legacy diff input', () => {
  const plan = planDoctorArgs({ ...BASE, scope: 'lines', diff: 'true', isPr: true, diffRef: REF });
  assert.deepEqual(plan.args.slice(-4), ['--scope', 'lines', '--base', REF]);
  assert.equal(plan.args.includes('--changed-files-from'), false);
  assert.match(plan.warnings.join('\n'), /ignored/);
});

test('baseline maps to --baseline on any event', () => {
  const plan = planDoctorArgs({ ...BASE, baseline: 'doctor-baseline.json', isPr: false });
  assert.deepEqual(plan.args.slice(-2), ['--baseline', 'doctor-baseline.json']);
  assert.equal(plan.usesNewFlags, true);
});

test('a baseline path with a newline is rejected', () => {
  const plan = planDoctorArgs({ ...BASE, baseline: 'a\nb.json' });
  assert.match(plan.errors.join('\n'), /baseline/);
});

test('warning-exit-code maps to --warning-exit-code and is range-checked', () => {
  const plan = planDoctorArgs({ ...BASE, warningExitCode: '78' });
  assert.deepEqual(plan.args.slice(-2), ['--warning-exit-code', '78']);
  assert.equal(plan.usesNewFlags, true);
  for (const bad of ['1', '256', 'x', '7.5', '0']) {
    assert.match(planDoctorArgs({ ...BASE, warningExitCode: bad }).errors.join('\n'), /warning-exit-code/, bad);
  }
});

test('meetsMinimumVersion compares against the per-framework floor', () => {
  assert.deepEqual(MIN_SCOPE_VERSION, { vue: '1.8.0', nuxt: '1.9.0' });
  assert.equal(meetsMinimumVersion('vue', '1.8.0'), true);
  assert.equal(meetsMinimumVersion('vue', '1.10.2'), true);
  assert.equal(meetsMinimumVersion('vue', '2.0.0'), true);
  assert.equal(meetsMinimumVersion('vue', '1.7.9'), false);
  assert.equal(meetsMinimumVersion('nuxt', '1.8.5'), false);
  assert.equal(meetsMinimumVersion('nuxt', '1.9.0'), true);
  assert.equal(meetsMinimumVersion('nuxt', '^1.9.1'), true);
  assert.equal(meetsMinimumVersion('vue', '1.8.0-rc.1'), false);
  assert.equal(meetsMinimumVersion('vue', 'workspace:*'), null);
  assert.equal(meetsMinimumVersion('vue', ''), null);
});

test('the version guard fails fast when new flags meet an old CLI', () => {
  const plan = planDoctorArgs({ ...BASE, scope: 'changed', isPr: true, diffRef: REF, framework: 'vue', version: '1.7.0' });
  assert.match(plan.errors.join('\n'), /@geoql\/vue-doctor 1\.7\.0.*1\.8\.0/);
  const ok = planDoctorArgs({ ...BASE, framework: 'nuxt', version: '1.2.0' });
  assert.deepEqual(ok.errors, []);
  const unknown = planDoctorArgs({ ...BASE, warningExitCode: '78', framework: 'vue', version: 'workspace:*' });
  assert.deepEqual(unknown.errors, []);
  assert.match(unknown.warnings.join('\n'), /Could not verify/);
});

test('a CLI with --sarif-output gets a single run', () => {
  for (const [framework, version] of [['vue', '1.9.0'], ['nuxt', '1.10.0'], ['vue', '2.0.0'], ['nuxt', '1.10.3']]) {
    const plan = planDoctorArgs({ ...BASE, framework, version });
    assert.equal(plan.singleRun, true, `${framework} ${version}`);
    assert.deepEqual(plan.args, ['--preset', 'recommended', '--threshold', '0', '--fail-on', 'error']);
  }
});

test('an older, prerelease, or unreadable CLI keeps the two-run path', () => {
  for (const [framework, version] of [['vue', '1.8.0'], ['nuxt', '1.9.0'], ['vue', '1.9.0-rc.1'], ['vue', 'workspace:*'], ['vue', ''], [undefined, '9.9.9']]) {
    const plan = planDoctorArgs({ ...BASE, framework, version });
    assert.equal(plan.singleRun, false, `${framework} ${version}`);
  }
});

test('meetsMinimumVersion accepts a custom floor table', () => {
  assert.equal(meetsMinimumVersion('vue', '1.9.0', MIN_SARIF_OUTPUT_VERSION), true);
  assert.equal(meetsMinimumVersion('vue', '1.8.9', MIN_SARIF_OUTPUT_VERSION), false);
  assert.equal(meetsMinimumVersion('nuxt', '1.10.0', MIN_SARIF_OUTPUT_VERSION), true);
  assert.equal(meetsMinimumVersion('nuxt', '1.9.9', MIN_SARIF_OUTPUT_VERSION), false);
});

test('main writes the single-run step output', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'doctor-args-'));
  const run = (version) => {
    const outFile = join(dir, `out-${version}`);
    const r = spawnSync(process.execPath, [new URL('./doctor-args.mjs', import.meta.url).pathname, join(dir, 'args')], {
      env: { ...process.env, INPUT_FRAMEWORK: 'vue', RESOLVED_VERSION: version, GITHUB_OUTPUT: outFile },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return readFileSync(outFile, 'utf8');
  };
  assert.match(run('1.9.0'), /^single-run=true$/m);
  assert.match(run('1.8.0'), /^single-run=false$/m);
});
