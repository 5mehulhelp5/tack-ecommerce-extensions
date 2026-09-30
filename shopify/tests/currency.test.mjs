// Presentment-currency rules for the read blocks (Wave 3).
//
// Zero dependencies: `node --test shopify/tests/currency.test.mjs`.
// The page currency is Liquid `cart.currency.iso_code`, the customer's local
// (presentment) currency: https://shopify.dev/docs/api/liquid/objects/cart
// The rule under test: a price in one currency is NEVER rendered beside a
// product shown in another, whatever the server answers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    documentElement: { lang: 'en' },
  };
  const window = { location: { search: '', host: 'x' }, addEventListener: () => {} };
  const ctx = vm.createContext({ window, document, URLSearchParams, setTimeout, clearTimeout, Intl });
  for (const f of ['tackquote-shared.js', ...files]) {
    vm.runInContext(readFileSync(join(ASSETS, f), 'utf8'), ctx, { filename: f });
  }
  return window.TackQuote;
}

const ns = loadNs(['tackquote-quantity-breaks.js']);
const root = (currency) => ({ dataset: { tackquoteCurrency: currency } });

test('page currency: only an ISO 4217 alpha-3 code is sent', () => {
  assert.equal(ns.pageCurrency(root('eur')), 'EUR');
  assert.equal(ns.currencyQuery(root('EUR')), '&currency=EUR');
  assert.equal(ns.pageCurrency(root('EURO')), '');
  assert.equal(ns.currencyQuery(root('')), '');
  assert.equal(ns.currencyQuery(root('E&x=1')), '');
});

test('a server refusal in the page currency is a mismatch', () => {
  const data = { status: 'unpriced', reason: 'currency_mismatch', currency: 'USD', presentmentCurrency: 'EUR' };
  assert.equal(ns.currencyView(data, 'EUR'), 'mismatch');
});

test('a priced answer in another currency is a mismatch even if the server priced it', () => {
  assert.equal(ns.currencyView({ status: 'priced', unitPrice: 9, currency: 'USD' }, 'EUR'), 'mismatch');
  assert.equal(ns.currencyView({ status: 'ok', currency: 'USD', items: [] }, 'EUR'), 'mismatch');
});

test('same currency, or no page currency known, renders normally', () => {
  assert.equal(ns.currencyView({ status: 'priced', unitPrice: 9, currency: 'EUR' }, 'EUR'), 'ok');
  assert.equal(ns.currencyView({ status: 'priced', unitPrice: 9, currency: 'usd' }, 'USD'), 'ok');
  assert.equal(ns.currencyView({ status: 'anonymous' }, 'EUR'), 'ok');
});

test('quantity breaks never draw a ladder in a foreign currency', () => {
  const ladder = { status: 'priced', currency: 'USD', rows: [{ minQty: 1, unitPrice: 5 }] };
  assert.equal(ns.breaksView(ladder, false, 'EUR'), 'currency');
  assert.equal(ns.breaksView(ladder, false, 'USD'), 'table');
  assert.equal(ns.breaksView({ status: 'unpriced', reason: 'currency_mismatch' }, false, 'EUR'), 'currency');
});

test('the price block routes a mismatch before it can print a number', () => {
  // Source-order assertion on the control flow, comments stripped: the
  // currency check must sit ABOVE the priced branch, or a USD number renders.
  const src = readFileSync(join(ASSETS, 'tackquote-price.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const guard = src.indexOf("ns.currencyView(data, pageCurrency) === 'mismatch'");
  const priced = src.indexOf("if (data.status === 'priced')");
  assert.ok(guard > 0 && priced > 0 && guard < priced, 'currency guard must precede the priced branch');
  assert.match(src, /\/wholesale-price\?[^`]*\$\{ns\.currencyQuery\(root\)\}/);
});

test('money formats in the currency it is given', () => {
  assert.match(ns.money(12.5, 'EUR'), /12\.50/);
  assert.match(ns.money(12.5, 'EUR'), /€|EUR/);
});
