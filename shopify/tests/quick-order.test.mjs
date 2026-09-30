// Quick Order block (Wave 3): parsing, limits, state and the wire contract.
// Zero dependencies: `node --test shopify/tests/quick-order.test.mjs`.
// Contract: GET {proxy}/quick-order?skus=...&currency=... (App Proxy signed),
// then POST cart/add.js with an items array
// (https://shopify.dev/docs/api/ajax/reference/cart).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme-app-extension');
const read = (p) => readFileSync(join(EXT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function loadNs() {
  const document = { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {} };
  const window = { location: { search: '', host: 'x' }, addEventListener: () => {} };
  const ctx = vm.createContext({ window, document, URLSearchParams, setTimeout, clearTimeout, Intl });
  for (const f of ['tackquote-shared.js', 'tackquote-quick-order.js']) vm.runInContext(read(`assets/${f}`), ctx);
  return window.TackQuote;
}
const ns = loadNs();
// Values built inside the vm realm have foreign prototypes; compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));
const js = strip(read('assets/tackquote-quick-order.js'));
const liquid = read('blocks/quick-order.liquid');

test('parses SKU and quantity in the separators buyers paste', () => {
  const r = ns.parseQuickOrder('ABC-1, 3\nXYZ 2\nQ9\t10\n\nABC-1;4\nsolo');
  assert.deepEqual(plain(r.lines.map((l) => [l.sku, l.quantity])), [['ABC-1', 7], ['XYZ', 2], ['Q9', 10], ['solo', 1]]);
  assert.deepEqual(plain(r.bad), []);
});

test('refuses unreadable lines and zero quantities, by line number', () => {
  const r = ns.parseQuickOrder('ok 1\nbad sku with spaces 2\nz, 0');
  assert.deepEqual(plain(r.bad), [2, 3]);
  assert.equal(r.lines.length, 1);
});

test('caps a lookup at 50 SKUs and says so', () => {
  const text = Array.from({ length: 60 }, (_, i) => `S${i}, 1`).join('\n');
  const r = ns.parseQuickOrder(text);
  assert.equal(r.lines.length, 50);
  assert.equal(r.tooMany, true);
});

test('per-line limits: min and max block, order-level limits do not', () => {
  const limits = [
    { limitType: 'order_total', min: 500 },
    { limitType: 'product_qty', min: 6, max: 60 },
  ];
  assert.deepEqual(plain(ns.lineLimit(2, limits)), { kind: 'Min', value: 6 });
  assert.equal(ns.lineLimit(61, limits).kind, 'Max');
  assert.equal(ns.lineLimit(12, limits), null);
  assert.equal(ns.lineLimit(1, [{ limitType: 'order_total', min: 500 }]), null);
});

test('state: guest, unlinked, uninstalled, ok', () => {
  assert.equal(ns.quickOrderView({ status: 'anonymous' }), 'login');
  assert.equal(ns.quickOrderView({ status: 'unlinked', reason: 'customer_not_linked' }), 'unlinked');
  assert.equal(ns.quickOrderView({ status: 'unlinked', reason: 'shop_not_installed' }), 'not-connected');
  assert.equal(ns.quickOrderView({ status: 'ok', items: [] }), 'rows');
  assert.equal(ns.quickOrderView({ status: 'weird' }), 'error');
});

test('calls the lookup route with the SKUs and the page currency, and no tenant', () => {
  assert.match(js, /\$\{proxy\}\/quick-order\?skus=\$\{skus\}\$\{ns\.currencyQuery\(root\)\}/);
  assert.doesNotMatch(js, /tenant/i);
  assert.doesNotMatch(js, /customerId|customer_id/);
});

test('adds to cart in one Ajax call with numeric variant ids and quantities only', () => {
  assert.match(js, /cart\/add\.js/);
  assert.match(js, /JSON\.stringify\(\{ items \}\)/);
  assert.match(js, /\(\{ id: Number\(r\.variantId\), quantity: r\.quantity \}\)/);
  // No price travels to the cart; Shopify and the discount Function price it.
  assert.doesNotMatch(js, /price:\s*r\./);
});

test('a line over its limit disables both add buttons', () => {
  assert.match(js, /const blocked = rows\.some\(\(r\) => r\.variantId && r\.problem\);/);
  assert.match(js, /toCart\.disabled = !ok\.length \|\| blocked;/);
});

test('never prints a price when the currency does not match', () => {
  assert.match(js, /const hidePrice = data\.priceHidden \|\| ns\.currencyView\(data, pageCurrency\) === 'mismatch';/);
  assert.match(js, /price: hidePrice \|\| !it\.price \? null : it\.price/);
});

test('reuses the quote drawer instead of forking it', () => {
  assert.match(js, /ns\.quoteAdd\(lines, \{ proxy, currency: pageCurrency \}\)/);
  assert.match(read('assets/tackquote-quote.js'), /ns\.quoteAdd = \(lines, ctx\) =>/);
  assert.match(liquid, /\{% render 'tackquote-drawer', proxy: proxy_path/);
});

test('a signed-out shopper gets a sign-in link and the runtime never boots', () => {
  const guest = liquid.slice(liquid.indexOf('{%- elsif customer == blank -%}'), liquid.indexOf('{%- else -%}'));
  assert.match(guest, /tackquote\.quick_order\.sign_in/);
  assert.doesNotMatch(guest, /data-tackquote-mode="quick-order"/);
});
