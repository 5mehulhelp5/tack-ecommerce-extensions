// The storefront's own money format (assets/tackquote-shared.js `ns.shopMoney` /
// `ns.money`), so drawer and block prices read like the theme's ("Rs. 699.95",
// not Intl's "₹699.95"). Shopify's placeholders:
// https://help.shopify.com/en/manual/international/pricing/currency-formatting
// Zero dependencies: `node --test shopify/tests/money-format.test.mjs`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme-app-extension');

function load(dataset) {
  const src = dataset ? { dataset } : null;
  const document = {
    readyState: 'complete',
    documentElement: { lang: 'en' },
    querySelector: (s) => (s === '[data-tackquote-money-format]' ? src : null),
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  const window = { location: { search: '', host: 'x' }, addEventListener: () => {} };
  const ctx = vm.createContext({ window, document, URLSearchParams, setTimeout, clearTimeout, Intl });
  vm.runInContext(readFileSync(join(EXT, 'assets', 'tackquote-shared.js'), 'utf8'), ctx);
  return window.TackQuote;
}

test('every Shopify placeholder formats as the storefront does', () => {
  const { shopMoney } = load();
  assert.equal(shopMoney(1234567.891, 'Rs. {{amount}}'), 'Rs. 1,234,567.89');
  assert.equal(shopMoney(1234567.891, '${{amount_no_decimals}}'), '$1,234,568');
  assert.equal(shopMoney(1234.5, '€{{amount_with_comma_separator}}'), '€1.234,50');
  assert.equal(shopMoney(1234.5, '{{amount_no_decimals_with_comma_separator}} kr'), '1.235 kr');
  assert.equal(shopMoney(1234.5, "CHF {{amount_with_apostrophe_separator}}"), "CHF 1'234.50");
  assert.equal(shopMoney(1234.5, '{{ amount_with_space_separator }} zł'), '1 234,50 zł');
  assert.equal(shopMoney(699.95, 'Rs. {{amount}}'), 'Rs. 699.95');
});

test('HTML in the format is stripped, never rendered', () => {
  const { shopMoney } = load();
  assert.equal(shopMoney(10, '<span class="money">${{amount}}</span>'), '$10.00');
  assert.equal(shopMoney(10, '<img src=x onerror=alert(1)>{{amount}}'), '10.00');
});

test('an unusable format is refused, so the caller falls back', () => {
  const { shopMoney } = load();
  assert.equal(shopMoney(10, ''), '');
  assert.equal(shopMoney(10, 'no placeholder'), '');
  assert.equal(shopMoney(10, '{{amount_in_roman_numerals}}'), '');
});

test('ns.money uses the shop format only in the shop currency, Intl otherwise', () => {
  const ns = load({ tackquoteMoneyFormat: 'Rs. {{amount}}', tackquoteShopCurrency: 'INR' });
  assert.equal(ns.money(699.95, 'INR'), 'Rs. 699.95');
  assert.match(ns.money(10, 'EUR'), /€/, 'a presentment currency other than the shop currency uses Intl');
  const none = load(null);
  assert.match(none.money(699.95, 'INR'), /699\.95/);
  assert.doesNotMatch(none.money(699.95, 'INR'), /^Rs\./, 'no format: Intl fallback');
});

test('the drawer, the variant table and Quick Order carry the escaped format', () => {
  const attr = 'data-tackquote-money-format="{{ shop.money_format | escape }}" data-tackquote-shop-currency="{{ shop.currency }}"';
  for (const f of ['snippets/tackquote-drawer.liquid', 'snippets/tackquote-selection.liquid', 'blocks/quick-order.liquid']) {
    assert.ok(readFileSync(join(EXT, f), 'utf8').includes(attr), f);
  }
});
