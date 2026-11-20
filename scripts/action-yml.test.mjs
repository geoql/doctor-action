import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const actionYml = readFileSync(
  new URL('../action.yml', import.meta.url),
  'utf8',
);

function step(name) {
  const start = actionYml.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, `step "${name}" not found`);
  const next = actionYml.indexOf('\n    - name: ', start + 1);
  return actionYml.slice(start, next === -1 ? undefined : next);
}

test('Run doctor exports the api-key input as DOCTOR_API_KEY', () => {
  assert.match(
    step('Run doctor'),
    /^\s+DOCTOR_API_KEY: \$\{\{ inputs\.api-key \}\}$/m,
  );
});

test('Run doctor keeps passing --api-key for CLIs that predate DOCTOR_API_KEY', () => {
  assert.match(step('Run doctor'), /--api-key "\$INPUT_API_KEY"/);
});
