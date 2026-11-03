import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  detectPackageManager,
  findProjectDoctor,
  planInstall,
  parseNpmViewVersions,
} from './resolve-doctor.mjs';

/** @param {Record<string, string>} files */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-action-'));
  fs.mkdirSync(path.join(root, '.git'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

test('detectPackageManager prefers the packageManager field', () => {
  const root = fixture({
    'package.json': JSON.stringify({ packageManager: 'pnpm@12.15.0' }),
    'package-lock.json': '{}',
  });
  assert.equal(detectPackageManager(root), 'pnpm');
});

test('detectPackageManager falls back to lockfiles, walking up to the repo root', () => {
  assert.equal(detectPackageManager(fixture({ 'yarn.lock': '' })), 'yarn');
  assert.equal(detectPackageManager(fixture({ 'bun.lock': '' })), 'bun');
  assert.equal(detectPackageManager(fixture({ 'bun.lockb': '' })), 'bun');
  assert.equal(detectPackageManager(fixture({ 'package-lock.json': '' })), 'npm');
  const mono = fixture({ 'pnpm-lock.yaml': '', 'apps/web/package.json': '{}' });
  assert.equal(detectPackageManager(path.join(mono, 'apps/web')), 'pnpm');
});

test('detectPackageManager defaults to npm', () => {
  assert.equal(detectPackageManager(fixture({ 'package.json': '{}' })), 'npm');
});

test('findProjectDoctor reports a declared + installed dependency with its version', () => {
  const root = fixture({
    'package.json': JSON.stringify({ devDependencies: { '@geoql/vue-doctor': '^1.4.0' } }),
    'node_modules/@geoql/vue-doctor/package.json': JSON.stringify({ version: '1.4.2' }),
    'node_modules/.bin/vue-doctor': '',
  });
  assert.deepEqual(findProjectDoctor(root, 'vue'), {
    declaredRange: '^1.4.0',
    installed: true,
    installedVersion: '1.4.2',
  });
});

test('findProjectDoctor finds a dependency declared at the monorepo root', () => {
  const root = fixture({
    'package.json': JSON.stringify({ dependencies: { '@geoql/nuxt-doctor': '2.0.0' } }),
    'apps/web/package.json': '{}',
  });
  assert.deepEqual(findProjectDoctor(path.join(root, 'apps/web'), 'nuxt'), {
    declaredRange: '2.0.0',
    installed: false,
    installedVersion: null,
  });
});

test('findProjectDoctor ignores the other framework package', () => {
  const root = fixture({
    'package.json': JSON.stringify({ devDependencies: { '@geoql/vue-doctor': '^1' } }),
  });
  assert.equal(findProjectDoctor(root, 'nuxt').declaredRange, null);
});

test('planInstall: an explicit version always overrides the project dependency', () => {
  assert.deepEqual(
    planInstall({ inputVersion: '1.2.3', declaredRange: '^1.4.0', installed: true, installedVersion: '1.4.2' }),
    { mode: 'registry', range: '1.2.3', reason: 'input' },
  );
});

test('planInstall: default latest runs the installed project dependency', () => {
  assert.deepEqual(
    planInstall({ inputVersion: 'latest', declaredRange: '^1.4.0', installed: true, installedVersion: '1.4.2' }),
    { mode: 'project', range: '1.4.2', reason: 'installed' },
  );
  assert.equal(
    planInstall({ inputVersion: '', declaredRange: '^1.4.0', installed: true, installedVersion: '1.4.2' }).mode,
    'project',
  );
});

test('planInstall: declared but not installed installs the declared range', () => {
  assert.deepEqual(
    planInstall({ inputVersion: 'latest', declaredRange: '^1.4.0', installed: false, installedVersion: null }),
    { mode: 'registry', range: '^1.4.0', reason: 'declared' },
  );
});

test('planInstall: non-registry declared specs (workspace:, file:, link:) fall back to latest', () => {
  for (const spec of ['workspace:*', 'file:../doctor', 'link:../x', 'catalog:']) {
    assert.deepEqual(
      planInstall({ inputVersion: 'latest', declaredRange: spec, installed: false, installedVersion: null }),
      { mode: 'registry', range: 'latest', reason: 'default' },
    );
  }
});

test('planInstall: nothing declared falls back to latest from the registry', () => {
  assert.deepEqual(
    planInstall({ inputVersion: 'latest', declaredRange: null, installed: false, installedVersion: null }),
    { mode: 'registry', range: 'latest', reason: 'default' },
  );
});

test('parseNpmViewVersions picks the highest match from npm view --json output', () => {
  assert.equal(parseNpmViewVersions('"1.5.0"'), '1.5.0');
  assert.equal(parseNpmViewVersions('["1.4.0","1.4.1","1.4.2"]'), '1.4.2');
  assert.equal(parseNpmViewVersions(''), null);
  assert.equal(parseNpmViewVersions('not json'), null);
  assert.equal(parseNpmViewVersions('[]'), null);
});
