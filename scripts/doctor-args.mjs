// @ts-check
//
// Build the doctor CLI argv from the action inputs. Pure planning lives in
// planDoctorArgs() (unit-tested in doctor-args.test.mjs); main() reads the
// step env, prints errors/warnings as workflow commands, and writes one arg
// per line to the file given as argv[2].
//
// Usage: node doctor-args.mjs <args-file>

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SCOPES = ['full', 'files', 'changed', 'lines', 'contextual'];

/** First CLI release with --scope / --base / --baseline / --warning-exit-code. */
export const MIN_SCOPE_VERSION = { vue: '1.8.0', nuxt: '1.9.0' };

/** First CLI release with --sarif-output (one audit writes JSON + SARIF). */
export const MIN_SARIF_OUTPUT_VERSION = { vue: '1.9.0', nuxt: '1.10.0' };

/** @param {string} v */
function parseVersion(v) {
  const m = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(String(v ?? ''));
  if (!m) return null;
  return { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: Boolean(m[4]) };
}

/**
 * Whether `version` is at least the framework's floor in `floors` (default:
 * the scope-capable release). Returns null when the version cannot be read
 * (workspace:, file:, empty).
 * @param {string} framework
 * @param {string} version
 * @param {Record<'vue'|'nuxt', string>} [floors]
 * @returns {boolean | null}
 */
export function meetsMinimumVersion(framework, version, floors = MIN_SCOPE_VERSION) {
  const floor = parseVersion(floors[/** @type {'vue'|'nuxt'} */ (framework)] ?? '');
  const actual = parseVersion(version);
  if (!floor || !actual) return null;
  for (let i = 0; i < 3; i += 1) {
    if (actual.parts[i] !== floor.parts[i]) return actual.parts[i] > floor.parts[i];
  }
  // Equal core: a prerelease of the floor predates it.
  return !actual.pre;
}

/**
 * @param {{
 *   preset?: string, threshold?: string, failOn?: string,
 *   scope?: string, diff?: string, baseline?: string, warningExitCode?: string,
 *   isPr?: boolean, diffRef?: string, framework?: string, version?: string,
 * }} input
 */
export function planDoctorArgs(input) {
  /** @type {string[]} */ const errors = [];
  /** @type {string[]} */ const warnings = [];
  /** @type {string[]} */ const notices = [];
  const args = ['--preset', String(input.preset ?? 'recommended'), '--threshold', String(input.threshold ?? '0'), '--fail-on', String(input.failOn ?? 'error')];

  let scope = String(input.scope ?? '').trim().toLowerCase() || 'full';
  const legacyDiff = String(input.diff ?? '').trim() === 'true';
  const diffRef = String(input.diffRef ?? '').trim();
  let usesNewFlags = false;

  if (!SCOPES.includes(scope)) {
    errors.push(`Invalid scope '${scope}'. Expected one of: ${SCOPES.join(', ')}.`);
    scope = 'full';
  }

  if (legacyDiff && scope !== 'full') {
    warnings.push(`The deprecated 'diff' input is ignored because scope is '${scope}'.`);
  }

  if (legacyDiff && scope === 'full') {
    // Exact pre-2.2 behavior, so it keeps working with any CLI version.
    warnings.push("The 'diff' input is deprecated; use scope: files instead.");
    args.push(...(diffRef ? ['--changed-files-from', diffRef] : ['--diff']));
    scope = 'files';
  } else if (scope !== 'full') {
    if (!input.isPr) {
      notices.push(`scope '${scope}' applies to pull request events only; scanning the full project.`);
      scope = 'full';
    } else if (!diffRef) {
      errors.push(
        `scope '${scope}' needs the PR base commit and its merge-base with HEAD, but neither resolved. Set fetch-depth: 0 on actions/checkout.`,
      );
    } else {
      args.push('--scope', scope, '--base', diffRef);
      usesNewFlags = true;
    }
  }

  const baseline = String(input.baseline ?? '').trim();
  if (baseline) {
    if (/[\r\n]/.test(baseline)) errors.push('The baseline path must not contain a newline.');
    else {
      args.push('--baseline', baseline);
      usesNewFlags = true;
    }
  }

  const wec = String(input.warningExitCode ?? '').trim();
  if (wec) {
    const n = Number(wec);
    if (!/^\d+$/.test(wec) || n < 2 || n > 255) {
      errors.push(`Invalid warning-exit-code '${wec}'. Expected an integer from 2 to 255.`);
    } else {
      args.push('--warning-exit-code', String(n));
      usesNewFlags = true;
    }
  }

  if (usesNewFlags && input.framework) {
    const pkg = `@geoql/${input.framework}-doctor`;
    const floor = MIN_SCOPE_VERSION[/** @type {'vue'|'nuxt'} */ (input.framework)];
    const ok = meetsMinimumVersion(input.framework, String(input.version ?? ''));
    if (ok === false) {
      errors.push(
        `${pkg} ${input.version} does not support scope, baseline, or warning-exit-code. They need ${pkg} ${floor} or later; upgrade it or set the version input.`,
      );
    } else if (ok === null) {
      warnings.push(`Could not verify that ${pkg} '${input.version ?? ''}' is ${floor} or later (needed for scope, baseline, and warning-exit-code).`);
    }
  }

  // One audit writes JSON + SARIF when the CLI has --sarif-output; an older
  // or unreadable version keeps the two-run path.
  const singleRun = Boolean(input.framework) && meetsMinimumVersion(String(input.framework), String(input.version ?? ''), MIN_SARIF_OUTPUT_VERSION) === true;

  return { args, scope, usesNewFlags, singleRun, errors, warnings, notices };
}

function main() {
  const out = process.argv[2];
  const env = process.env;
  const plan = planDoctorArgs({
    preset: env.INPUT_PRESET,
    threshold: env.INPUT_THRESHOLD,
    failOn: env.INPUT_FAIL_ON,
    scope: env.INPUT_SCOPE,
    diff: env.INPUT_DIFF,
    baseline: env.INPUT_BASELINE,
    warningExitCode: env.INPUT_WARNING_EXIT_CODE,
    isPr: env.EVENT_NAME === 'pull_request' || env.EVENT_NAME === 'pull_request_target',
    diffRef: env.DIFF_REF,
    framework: env.INPUT_FRAMEWORK,
    version: env.RESOLVED_VERSION,
  });
  for (const n of plan.notices) console.log(`::notice::${n}`);
  for (const w of plan.warnings) console.log(`::warning::${w}`);
  for (const e of plan.errors) console.log(`::error::${e}`);
  if (plan.errors.length > 0) process.exit(2);

  if (out) fs.writeFileSync(out, `${plan.args.join('\n')}\n`);
  else process.stdout.write(`${plan.args.join('\n')}\n`);
  const outputs = `scope=${plan.scope}\nsingle-run=${plan.singleRun}\n`;
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, outputs);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
