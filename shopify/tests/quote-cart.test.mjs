// The cart page's "Request a quote for your cart" (assets/tackquote-quote-cart.js).
//
// Zero dependencies: `node --test shopify/tests/quote-cart.test.mjs`.
// cart.js can list the same variant on two lines (line-item properties, selling
// plans). The import SETS quantities (so pressing it twice never doubles), which
// means an un-aggregated second line would silently overwrite the first.
// https://shopify.dev/docs/api/ajax/reference/cart
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme-app-extension', 'assets');

function load() {
  const document = {
    readyState: 'complete',
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    dispatchEvent: () => {},
  };
  const window = { location: { search: '', host: 'x' }, addEventListener: () => {}, localStorage: { getItem: () => null } };
  const ctx = vm.createContext({ window, document, URLSearchParams, setTimeout, clearTimeout, CustomEvent: class {} });
  for (const f of ['tackquote-shared.js', 'tackquote-quote-cart.js']) {
    vm.runInContext(readFileSync(join(ASSETS, f), 'utf8'), ctx, { filename: f });
  }
  return window.TackQuote;
}
const ns = load();
const plain = (v) => JSON.parse(JSON.stringify(v));

test('two cart lines for one variant become ONE quote line with the summed quantity', () => {
  const lines = ns.cartLines([
    { variant_id: 111, title: 'Bolt - M8', sku: 'B-M8', quantity: 10 },
    { variant_id: 222, title: 'Nut', sku: 'N', quantity: 3 },
    { variant_id: 111, title: 'Bolt - M8', sku: 'B-M8', quantity: 5, properties: { engraving: 'x' } },
  ]);
  assert.deepEqual(plain(lines), [
    { variantId: '111', name: 'Bolt - M8', sku: 'B-M8', quantity: 15 },
    { variantId: '222', name: 'Nut', sku: 'N', quantity: 3 },
  ]);
});

test('no price is carried from the cart', () => {
  const [line] = ns.cartLines([{ variant_id: 1, title: 'X', quantity: 1, price: 1999, final_line_price: 1999 }]);
  assert.equal('price' in line, false);
});

test('the cap is counted after aggregation: 101 cart lines of 100 variants fit', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ variant_id: i + 1, title: `V${i}`, quantity: 1 }));
  items.push({ variant_id: 1, title: 'V0', quantity: 2 });
  const lines = ns.cartLines(items);
  assert.equal(lines.length, 100);
  assert.equal(lines[0].quantity, 3);
});

test('empty or zero-quantity lines produce nothing', () => {
  assert.equal(ns.cartLines(undefined).length, 0);
  assert.equal(ns.cartLines([{ variant_id: 1, title: 'X', quantity: 0 }]).length, 0);
});
