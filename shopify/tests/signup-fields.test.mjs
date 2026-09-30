// Wholesale Application field rules (Wave 3): conditional fields and file
// pre-checks, which must agree with the API's wholesale-form-schema.ts.
// Zero dependencies: `node --test shopify/tests/signup-fields.test.mjs`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme-app-extension', 'assets');
function loadNs() {
  const document = { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {} };
  const window = { location: { search: '', host: 'x' }, addEventListener: () => {} };
  const ctx = vm.createContext({ window, document, URLSearchParams, setTimeout, clearTimeout });
  for (const f of ['tackquote-shared.js', 'tackquote-signup-fields.js']) {
    vm.runInContext(readFileSync(join(ASSETS, f), 'utf8'), ctx);
  }
  return window.TackQuote;
}
const { shown, fileProblem } = loadNs().signupFields;

const fields = [
  { key: 'type', type: 'select', options: ['Retailer', 'Distributor'] },
  { key: 'resale', type: 'checkbox' },
  { key: 'cert', type: 'file', showIf: { field: 'resale', equals: true } },
  { key: 'certNo', type: 'tax_id', showIf: { field: 'cert', equals: 'x' } },
  { key: 'region', type: 'text', showIf: { field: 'type', equals: 'Distributor' } },
  { key: 'depot', type: 'text', showIf: { field: 'region', equals: 'North' } },
];
const byKey = new Map(fields.map((f) => [f.key, f]));
const f = (k) => byKey.get(k);

test('a field with no condition is always shown', () => {
  assert.equal(shown(f('type'), byKey, {}), true);
});

test('a checkbox condition compares booleans, never the string "on"', () => {
  assert.equal(shown(f('cert'), byKey, { resale: true }), true);
  assert.equal(shown(f('cert'), byKey, { resale: false }), false);
  assert.equal(shown(f('cert'), byKey, { resale: 'on' }), false);
});

test('a select condition compares the trimmed string', () => {
  assert.equal(shown(f('region'), byKey, { type: 'Distributor' }), true);
  assert.equal(shown(f('region'), byKey, { type: ' Distributor ' }), true);
  assert.equal(shown(f('region'), byKey, { type: 'Retailer' }), false);
});

test('a hidden controller hides its dependants, even with a matching stale value', () => {
  assert.equal(shown(f('depot'), byKey, { type: 'Retailer', region: 'North' }), false);
  assert.equal(shown(f('depot'), byKey, { type: 'Distributor', region: 'North' }), true);
});

test('file pre-check: wrong type and oversize are named, a fine file passes', () => {
  const field = { key: 'cert', type: 'file', accept: ['application/pdf'], maxSizeMb: 2 };
  assert.equal(fileProblem({ type: 'image/png', size: 10 }, field), 'type');
  assert.equal(fileProblem({ type: 'application/pdf', size: 3 * 1024 * 1024 }, field), 'size');
  assert.equal(fileProblem({ type: 'application/pdf', size: 1024 }, field), null);
  // No accept list: the server default applies, and the 5 MB ceiling still holds.
  assert.equal(fileProblem({ type: 'application/pdf', size: 6 * 1024 * 1024 }, { type: 'file' }), 'size');
});
