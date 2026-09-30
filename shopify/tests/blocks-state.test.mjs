// State-machine tests for the theme app extension's read blocks.
//
// Zero dependencies: `node --test shopify/tests/blocks-state.test.mjs`.
// The assets are browser IIFEs, so they are evaluated in a `vm` context with a
// minimal window/document. Only the PURE parts are exercised — `ns.explain`,
// `ns.breaksView`, `ns.limitsView` — which is exactly the logic that decides
// what a guest, an unlinked buyer and a merchant in the theme editor see.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme-app-extension', 'assets');

function loadNs(files) {
  const document = {
    readyState: 'complete',
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
  };
  const window = { location: { search: '', host: 'x' }, addEventListener: () => {} };
  const ctx = vm.createContext({ window, document, URLSearchParams, setTimeout, clearTimeout });
  for (const f of ['tackquote-shared.js', ...files]) {
    vm.runInContext(readFileSync(join(ASSETS, f), 'utf8'), ctx, { filename: f });
  }
  return window.TackQuote;
}

const ns = loadNs(['tackquote-quantity-breaks.js', 'tackquote-order-limits.js']);

test('quantity breaks: a guest gets a sign-in prompt, never the failure text', () => {
  assert.equal(ns.breaksView({ status: 'anonymous' }, false), 'login');
  assert.equal(ns.breaksView({ status: 'anonymous' }, true), 'login');
});

test('quantity breaks: an unlinked customer gets the quote CTA', () => {
  assert.equal(ns.breaksView({ status: 'unlinked', reason: 'customer_not_linked' }, false), 'unlinked');
});

test('quantity breaks: an uninstalled shop is told to the merchant only', () => {
  const data = { status: 'unlinked', reason: 'shop_not_installed' };
  assert.equal(ns.breaksView(data, true), 'not-connected');
  assert.equal(ns.breaksView(data, false), 'hide');
});

test('quantity breaks: no ladder hides for shoppers, explains in the editor', () => {
  assert.equal(ns.breaksView({ status: 'unpriced' }, false), 'hide');
  assert.equal(ns.breaksView({ status: 'unpriced' }, true), 'empty');
  assert.equal(ns.breaksView({ status: 'priced', rows: [] }, false), 'table');
});

test('order limits: no rule hides for shoppers and hints where to set one in the editor', () => {
  assert.equal(ns.limitsView({ status: 'none' }, false), 'hide');
  assert.equal(ns.limitsView({ status: 'none' }, true), 'none');
  assert.equal(ns.limitsView({ status: 'limited', limits: [] }, true), 'none');
  assert.equal(ns.limitsView({ status: 'limited', limits: [{ min: 2 }] }, false), 'list');
  assert.equal(ns.limitsView({ status: 'unlinked', reason: 'shop_not_installed' }, true), 'not-connected');
});

test('explain: each failure maps to its own merchant diagnostic', () => {
  const root = {
    dataset: {
      msgDiagFail: 'fail {path}',
      msgDiagPassword: 'password',
      msgDiagNotJson: 'html',
      msgDiag404: '404 {path}',
      msgDiagAuth: 'auth',
      msgDiag5xx: 'server {status}',
      msgDiagTimeout: 'timeout',
    },
  };
  const e = (message, name) => Object.assign(new Error(message), name ? { name } : {});
  assert.equal(ns.explain(root, e('STOREFRONT_PASSWORD'), '/apps/t'), 'password');
  assert.equal(ns.explain(root, e('NOT_JSON'), '/apps/t'), 'html');
  assert.equal(ns.explain(root, e('HTTP 404'), '/apps/t'), '404 /apps/t');
  assert.equal(ns.explain(root, e('HTTP 403'), '/apps/t'), 'auth');
  assert.equal(ns.explain(root, e('HTTP 502'), '/apps/t'), 'server HTTP 502');
  assert.equal(ns.explain(root, e('aborted', 'AbortError'), '/apps/t'), 'timeout');
  assert.equal(ns.explain(root, e('boom'), '/apps/t'), 'fail /apps/t');
});

test('every storefront asset stays under 10,000 bytes (the theme-check threshold)', () => {
  // EVERY file in assets/, not a hand-kept list: a new runtime or stylesheet
  // must not be able to slip past the gate by not being named here.
  const files = readdirSync(ASSETS);
  assert.ok(files.length >= 9, 'asset listing looks wrong');
  for (const f of files) {
    const size = readFileSync(join(ASSETS, f)).length;
    assert.ok(size < 10_000, `${f} is ${size} B, over 10,000 B`);
  }
});

test('quantity breaks: a guest gets the NEUTRAL heading, never "applied at checkout"', () => {
  const m = { msgHeadingNeutral: 'neutral', msgHeadingApplied: 'applied', msgHeadingQuote: 'quote' };
  assert.equal(ns.breaksHeading('login', true, m), 'neutral');
  assert.equal(ns.breaksHeading('table', true, m), 'applied');
  assert.equal(ns.breaksHeading('table', false, m), 'quote');
});
