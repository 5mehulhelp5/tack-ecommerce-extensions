// Customer-account net-terms UI extension (Wave 3).
// Zero dependencies: `node --test shopify/tests/net-terms-extension.test.mjs`.
// Session token: https://shopify.dev/docs/api/customer-account-ui-extensions/2026-07/target-apis/platform-apis/session-token-api
// Capabilities:  https://shopify.dev/docs/apps/build/customer-accounts/capabilities
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'customer-account-net-terms');
const toml = readFileSync(join(DIR, 'shopify.extension.toml'), 'utf8');
const jsx = readFileSync(join(DIR, 'src', 'ProfileBlock.jsx'), 'utf8');
const code = jsx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const locale = JSON.parse(readFileSync(join(DIR, 'locales', 'en.default.json'), 'utf8'));

/** Evaluate the two pure helpers without a JSX toolchain. */
function pure(name) {
  const start = code.indexOf(`export function ${name}(`);
  let depth = 0;
  let end = code.indexOf('{', start);
  for (let i = end; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    if (code[i] === '}') depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
  const ctx = vm.createContext({});
  vm.runInContext(`${code.slice(start, end).replace('export ', '')}; this.fn = ${name};`, ctx);
  return ctx.fn;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

test('toml: 2026-07, the profile block target, network access and no Storefront API', () => {
  assert.match(toml, /^api_version = "2026-07"$/m);
  assert.match(toml, /^type = "ui_extension"$/m);
  assert.match(toml, /^target = "customer-account\.profile\.block\.render"$/m);
  assert.match(toml, /^network_access = true$/m);
  assert.match(toml, /^api_access = false$/m);
  const module = toml.match(/^module = "(.+)"$/m)[1];
  assert.ok(existsSync(join(DIR, module)), `${module} does not exist`);
});

test('every request carries a fresh session token as a Bearer credential', () => {
  assert.match(code, /const token = await shopify\.sessionToken\.get\(\);/);
  assert.match(code, /Authorization: `Bearer \$\{token\}`/);
  assert.match(code, /export const API_BASE = 'https:\/\/api\.tackquote\.com\/v1\/shopify-app\/customer-account';/);
});

test('sends no customer id, tenant or account email of its own', () => {
  assert.doesNotMatch(code, /customerId|customer_id|tenant/i);
  assert.doesNotMatch(code, /authenticatedAccount/);
});

test('omits empty optional fields and sends numbers as numbers', () => {
  const build = pure('buildApplication');
  assert.deepEqual(plain(build({ legalBusinessName: ' Acme ', contactEmail: 'a@b.co', contactPhone: '', requestedLimit: '', requestedTermsDays: '30' })), {
    legalBusinessName: 'Acme',
    contactEmail: 'a@b.co',
    requestedTermsDays: 30,
  });
  const full = plain(build({ legalBusinessName: 'A', contactEmail: 'e', taxId: 'X1', requestedLimit: '2500', notes: 'hi' }));
  assert.equal(full.requestedLimit, 2500);
  assert.equal(full.taxId, 'X1');
  assert.equal('contactPhone' in full, false);
});

test('each status maps to its own view', () => {
  const view = pure('viewFor');
  assert.equal(view(null), 'loading');
  assert.equal(view({ state: 'none' }), 'apply');
  assert.equal(view({ state: 'pending' }), 'pending');
  assert.equal(view({ state: 'approved' }), 'approved');
  assert.equal(view({ state: 'declined' }), 'declined');
});

test('every translation key the block uses exists, and no string is HTML-special', () => {
  const keys = [...code.matchAll(/\bt\('([a-zA-Z.]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 20, `only ${keys.length} keys found`);
  const resolve = (k) => k.split('.').reduce((n, p) => n?.[p], locale);
  for (const k of keys) assert.equal(typeof resolve(k), 'string', `${k} missing`);
  const walk = (node) => (typeof node === 'string' ? [node] : Object.values(node).flatMap(walk));
  for (const s of walk(locale)) assert.doesNotMatch(s, /[<>&'"]/);
});

test('a 404 (store not connected) is told apart from a failure', () => {
  assert.match(code, /err\.status === 404 \? t\('notConnected'\) : t\('loadFailed'\)/);
});
