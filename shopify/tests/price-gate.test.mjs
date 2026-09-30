// Price Gate app embed (Wave 3): who is gated, what is hidden, and that it
// cannot be turned into a CSS injection by a merchant setting.
//
// Zero dependencies: `node --test shopify/tests/price-gate.test.mjs`.
// App embed facts: https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration
// ("app embed blocks ... only have access to the Global Liquid scope").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme-app-extension');
const liquid = readFileSync(join(EXT, 'blocks', 'price-gate.liquid'), 'utf8');
const logic = liquid.slice(0, liquid.indexOf('{% schema %}'));
const schema = JSON.parse(liquid.match(/\{% schema %\}([\s\S]*?)\{% endschema %\}/)[1]);

function loadGate() {
  const document = { readyState: 'complete', getElementById: () => null, addEventListener: () => {} };
  const window = {};
  vm.runInContext(readFileSync(join(EXT, 'assets', 'tackquote-price-gate.js'), 'utf8'), vm.createContext({ window, document }));
  return window.TackQuoteGate;
}
const gate = loadGate();

test('it is an app embed injected into the body, on every page', () => {
  assert.equal(schema.target, 'body');
  assert.equal(schema.enabled_on, undefined);
  assert.equal(schema.javascript, 'tackquote-price-gate.js');
});

test('a guest is always gated, in both modes', () => {
  assert.match(logic, /if customer == blank\s+assign gated = true/);
});

test('tag mode un-gates only a customer carrying the tag, case-insensitively', () => {
  assert.match(logic, /elsif block\.settings\.mode == 'tag' and want_tag != blank\s+assign gated = true/);
  assert.match(logic, /for customer_tag in customer\.tags/);
  assert.match(logic, /if have_tag == want_tag\s+assign gated = false/);
  assert.match(logic, /assign want_tag = block\.settings\.tag \| strip \| downcase/);
});

test('the theme editor never hides anything, it only explains', () => {
  const design = logic.indexOf('{%- if request.design_mode -%}');
  const gated = logic.indexOf('{%- elsif gated -%}');
  const hide = logic.indexOf('display: none !important');
  assert.ok(design >= 0 && gated > design && hide > gated, 'hiding must live in the gated branch only');
});

test('add to cart is hidden only when the merchant keeps that setting on', () => {
  assert.match(logic, /\{%- if block\.settings\.hide_cart %\}\s*form\[action\*="\/cart\/add"\]/);
  assert.equal(schema.settings.find((s) => s.id === 'hide_cart').default, true);
  // TackQuote's own quote buttons are exempt from the submit rule.
  assert.match(logic, /\[type="submit"\]:not\(\[class\*="tackquote"\]\)/);
});

test('merchant selectors cannot break out of the style rule (Liquid side)', () => {
  for (const bad of ["'{'", "'}'", "'<'", "'/*'", "'@'", "';'"]) {
    assert.ok(logic.includes(`extra contains ${bad}`), `Liquid must refuse ${bad}`);
  }
  assert.match(logic, /\{% if extra_ok and extra != blank %\}, \{\{ extra \}\}\{% endif %\}/);
});

test('merchant selectors cannot break out (JS side)', () => {
  assert.ok(gate.selectors('.my-price').endsWith(', .my-price'));
  for (const bad of ['.x{color:red}', '.x;', '@import url(x)', '</style>', '.x/*', '.x\\']) {
    assert.ok(!gate.selectors(bad).includes(bad), `accepted ${bad}`);
  }
});

test('login link prefers the return-to-page route', () => {
  assert.match(logic, /routes\.storefront_login_url \| default: routes\.account_login_url/);
});

test('one link per price: nested price parts get no second link', () => {
  const parent = { id: 'p' };
  const child = { id: 'c', parentElement: parent };
  const lone = { id: 'l', parentElement: { id: 'x' } };
  const isPrice = (n) => n === parent;
  assert.deepEqual(gate.outermost([parent, child, lone], isPrice).map((n) => n.id), ['p', 'l']);
});

test('no Liquid tags inside an HTML attribute list', () => {
  // A Liquid tag between attributes failed theme check on another block (b5a4158).
  const configTag = liquid.match(/<div\s+id="tackquote-price-gate"[\s\S]*?>/)[0];
  assert.doesNotMatch(configTag, /\{%-?\s*comment/);
});
