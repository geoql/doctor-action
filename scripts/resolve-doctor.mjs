// @ts-check
//
// Decide which @geoql/<framework>-doctor to run:
//
// - explicit `version` input (anything but `latest`/empty) → install that
//   version from the registry.
// - default `latest` + the project has the doctor installed → run the
//   project's own copy through its package manager (pnpm/yarn/bun/npm exec).
// - default `latest` + declared in package.json but not installed → install
//   the declared range from the registry.
// - otherwise → install the latest published version.
//
// Registry installs are resolved to a concrete version so the toolchain cache
// key is stable.
//
// Usage: node resolve-doctor.mjs <framework> <version-input>  (cwd = project dir)

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_MANAGER_LOCKFILES = [
  { name: 'pnpm', lockfile: 'pnpm-lock.yaml' },
  { name: 'yarn', lockfile: 'yarn.lock' },
  { name: 'bun', lockfile: 'bun.lock' },
  { name: 'bun', lockfile: 'bun.lockb' },
  { name: 'npm', lockfile: 'package-lock.json' },
];
const KNOWN_MANAGERS = new Set(PACKAGE_MANAGER_LOCKFILES.map((m) => m.name));

/** @param {string} dir */
function readJson(dir, file = 'package.json') {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The project dir and its ancestors, stopping at the git root.
 * @param {string} projectDir
 */
function projectDirectories(projectDir) {
  const dirs = [];
  let dir = path.resolve(projectDir);
  while (true) {
    dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir || fs.existsSync(path.join(dir, '.git'))) break;
    dir = parent;
  }
  return dirs;
}

/** @param {string} projectDir */
export function detectPackageManager(projectDir) {
  const dirs = projectDirectories(projectDir);
  for (const dir of dirs) {
    const pkg = readJson(dir);
    const declared = pkg?.packageManager;
    const name =
      typeof declared === 'string' ? declared.split('@')[0] : pkg?.devEngines?.packageManager?.name;
    if (KNOWN_MANAGERS.has(name)) return name;
  }
  for (const dir of dirs) {
    const hit = PACKAGE_MANAGER_LOCKFILES.find(({ lockfile }) => fs.existsSync(path.join(dir, lockfile)));
    if (hit) return hit.name;
  }
  return 'npm';
}

/**
 * @param {string} projectDir
 * @param {string} framework vue | nuxt
 * @returns {{ declaredRange: string | null, installed: boolean, installedVersion: string | null }}
 */
export function findProjectDoctor(projectDir, framework) {
  const pkgName = `@geoql/${framework}-doctor`;
  const bin = `${framework}-doctor`;
  const dirs = projectDirectories(projectDir);

  let declaredRange = null;
  for (const dir of dirs) {
    const pkg = readJson(dir);
    const range = pkg?.dependencies?.[pkgName] ?? pkg?.devDependencies?.[pkgName];
    if (typeof range === 'string' && range) {
      declaredRange = range;
      break;
    }
  }

  let installedVersion = null;
  let hasBin = false;
  if (declaredRange !== null) {
    for (const dir of dirs) {
      if (
        !hasBin &&
        (fs.existsSync(path.join(dir, 'node_modules', '.bin', bin)) ||
          fs.existsSync(path.join(dir, 'node_modules', '.bin', `${bin}.cmd`)))
      ) {
        hasBin = true;
      }
      if (!installedVersion) {
        const v = readJson(path.join(dir, 'node_modules', pkgName))?.version;
        if (typeof v === 'string' && v) installedVersion = v;
      }
    }
  }

  return { declaredRange, installed: declaredRange !== null && hasBin, installedVersion };
}

/** A registry-installable range (not workspace:/file:/link:/catalog:/git/url). */
function isRegistryRange(/** @type {string} */ spec) {
  return !/^(workspace|file|link|catalog|portal|patch|npm|git|git\+\w+|https?|github):/.test(spec) && !spec.includes('/');
}

/**
 * @param {{ inputVersion?: string, declaredRange: string | null, installed: boolean, installedVersion: string | null }} input
 * @returns {{ mode: 'project' | 'registry', range: string, reason: 'input' | 'installed' | 'declared' | 'default' }}
 */
export function planInstall({ inputVersion, declaredRange, installed, installedVersion }) {
  const requested = String(inputVersion ?? '').trim();
  if (requested && requested !== 'latest') return { mode: 'registry', range: requested, reason: 'input' };
  if (installed) return { mode: 'project', range: installedVersion ?? declaredRange ?? '', reason: 'installed' };
  if (declaredRange && isRegistryRange(declaredRange)) {
    return { mode: 'registry', range: declaredRange, reason: 'declared' };
  }
  return { mode: 'registry', range: 'latest', reason: 'default' };
}

/**
 * Parse `npm view <pkg>@<range> version --json`: a string for one match, an
 * array (ascending) for several. Returns the highest match.
 * @param {string} output
 * @returns {string | null}
 */
export function parseNpmViewVersions(output) {
  let parsed;
  try {
    parsed = JSON.parse(String(output).trim());
  } catch {
    return null;
  }
  if (typeof parsed === 'string') return parsed || null;
  if (Array.isArray(parsed) && parsed.length > 0) return String(parsed[parsed.length - 1]);
  return null;
}

/** @param {string} pkgName @param {string} range */
function resolveConcreteVersion(pkgName, range) {
  try {
    const out = execFileSync('npm', ['view', `${pkgName}@${range}`, 'version', '--json'], {
      encoding: 'utf8',
      cwd: tmpdir(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseNpmViewVersions(out);
  } catch {
    return null;
  }
}

function main() {
  const framework = process.argv[2] || 'vue';
  const inputVersion = process.argv[3] ?? 'latest';
  const pkgName = `@geoql/${framework}-doctor`;
  const projectDir = process.cwd();

  const packageManager = detectPackageManager(projectDir);
  const found = findProjectDoctor(projectDir, framework);
  const plan = planInstall({ inputVersion, ...found });

  /** @type {Record<string, string>} */
  const outputs = { mode: plan.mode, 'package-manager': packageManager, resolved: '' };
  if (plan.mode === 'project') {
    outputs.resolved = plan.range;
    console.log(`Using the project's ${pkgName}@${plan.range || '?'} via ${packageManager}.`);
  } else {
    const resolved = resolveConcreteVersion(pkgName, plan.range);
    if (!resolved) {
      console.log(`::error::Could not resolve ${pkgName}@${plan.range} from the npm registry.`);
      process.exit(1);
    }
    outputs.resolved = resolved;
    console.log(`Resolved ${pkgName}@${plan.range} → ${resolved} (${plan.reason}).`);
  }

  const rendered = `${Object.entries(outputs)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, rendered);
  else process.stdout.write(rendered);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
