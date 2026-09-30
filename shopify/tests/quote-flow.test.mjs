// The quote flow end to end, on a minimal fake DOM (zero dependencies):
// `node --test shopify/tests/quote-flow.test.mjs`.
//
// Pins the storefront QA fixes of 2026-10-01 and the owner's price / variant
// requirement: sold-out variants are quotable by default; the submit button is
// usable again after a successful send; the floating cart's count renders on
// first load and after an add; lines carry the SELECTED variant's price for
// display, two variants make two lines, the same variant adds quantity; prices
// format in the presentment currency; and a buyer's price is sent only when typed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'theme-app-extension');
const ASSETS = join(EXT, 'assets');
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ------------------------------------------------------------ fake DOM */
class El {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.style = { setProperty() {}, getPropertyValue: () => '' };
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.parentNode = null;
    this.named = {};
    Object.assign(this, attrs);
  }
  append(...c) {
    for (const x of c) this.appendChild(x);
  }
  appendChild(c) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  replaceChild(n, o) {
    this.children[this.children.indexOf(o)] = n;
    n.parentNode = this;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  addEventListener(t, fn) {
    (this.listeners[t] = this.listeners[t] || []).push(fn);
  }
  click() {
    for (const fn of this.listeners.click || []) fn({ target: this, preventDefault() {} });
  }
  cloneNode() {
    const c = new El(this.tagName);
    c.dataset = { ...this.dataset };
    return c;
  }
  focus() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  getBoundingClientRect() {
    return { left: 0, right: 0, top: 0, bottom: 0 };
  }
  querySelector(sel) {
    return this.named[sel] || null;
  }
  querySelectorAll(sel) {
    if (sel === '.tackquote-link-button') return [];
    return this.named[sel] ? [this.named[sel]] : [];
  }
}

function page({ variants = [], idField = '', storage = {} } = {}) {
  const store = { ...storage };
  const events = {};
  const body = new El('body');
  const list = new El('ul');
  const fields = Object.fromEntries(['name', 'email', 'company', 'hp'].map((n) => [n, new El('input')]));
  const submitWrap = new El('div');
  const submit = submitWrap.appendChild(new El('button'));
  const status = new El('p');
  const empty = new El('p');
  const sub = new El('p');
  const drawer = new El('dialog');
  drawer.dataset = {
    tackquoteProxy: '/apps/tackquote',
    tackquoteCurrency: 'EUR',
    msgSuccess: 'OK',
    msgSending: '...',
    msgRequired: 'req',
    msgFailure: 'fail',
    msgAdded: 'added',
    msgAlready: 'again',
    msgFull: 'full',
    msgPrice: 'Price',
    msgYourPrice: 'Your price',
    msgEach: 'each',
    msgSubtotal: 'Subtotal {amount}',
  };
  Object.assign(drawer.named, {
    '[data-tackquote-items]': list,
    '[data-tackquote-empty]': empty,
    '[data-tackquote-subtotal]': sub,
    '[data-tackquote-drawer-status]': status,
    '[data-tackquote-submit]': submit,
    ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [`[name="${k}"]`, v])),
  });
  const idInput = new El('input', { value: idField });
  const form = new El('form');
  form.named['[name="id"]'] = idInput;
  form.named['[name="quantity"]'] = new El('input', { value: '1' });
  const variantsNode = new El('script', { textContent: JSON.stringify(variants) });
  const button = new El('button');
  const blockStatus = new El('p');
  const block = new El('div');
  block.dataset = {
    tackquoteMode: 'add',
    tackquoteProxy: '/apps/tackquote',
    tackquoteProduct: 'The Complete Snowboard',
    tackquoteVariant: String(variants[0] ? variants[0].id : ''),
    tackquoteCurrency: 'EUR',
    tackquoteSoldOut: 'allow',
    msgOutOfStock: 'Out of stock — quote request',
    msgUnavailable: 'This variant is unavailable.',
  };
  Object.assign(block.named, {
    '.tackquote-variants': variantsNode,
    '[data-tackquote-action]': button,
    '[data-tackquote-status]': blockStatus,
  });
  block.closest = (sel) => (sel.includes('cart/add') ? form : null);
  const badge = new El('span', { hidden: true });
  const selectors = {
    'dialog[data-tackquote-drawer]': drawer,
    '[data-tackquote-count]': badge,
    '.tackquote-block[data-tackquote-mode="add"], .tackquote-block[data-tackquote-mode="request"]': block,
  };
  // bind() swaps in a fresh submit button: keep the drawer's lookup pointing at it.
  submitWrap.replaceChild = (n, o) => {
    El.prototype.replaceChild.call(submitWrap, n, o);
    drawer.named['[data-tackquote-submit]'] = n;
  };
  const document = {
    readyState: 'complete',
    documentElement: { lang: 'en' },
    body,
    createElement: (t) => new El(t),
    getElementById: () => null,
    querySelector: (s) => (s.includes('dialog[data-tackquote-drawer]') ? drawer : selectors[s] || null),
    querySelectorAll: (s) => (selectors[s] ? [selectors[s]] : []),
    addEventListener: (t, fn) => {
      (events[t] = events[t] || []).push(fn);
    },
    dispatchEvent: (e) => {
      for (const fn of events[e.type] || []) fn(e);
    },
  };
  const sent = [];
  const fetch = (url, opts) => {
    sent.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ message: 'Quote request received!' }) });
  };
  const window = {
    location: { search: '', host: 'shop.test' },
    addEventListener() {},
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    },
  };
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  }
  const ctx = vm.createContext({ window, document, fetch, URLSearchParams, setTimeout, clearTimeout, CustomEvent, Intl, Promise });
  for (const f of ['tackquote-shared.js', 'tackquote-quote-lines.js', 'tackquote-quote.js', 'tackquote-quote-cart.js']) {
    vm.runInContext(readFileSync(join(ASSETS, f), 'utf8'), ctx, { filename: f });
  }
  const draft = () => JSON.parse(store['tackquote:draft:shop.test'] || '[]');
  return { ns: window.TackQuote, button, blockStatus, idInput, drawer, fields, status, list, sub, badge, sent, draft, store };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const SNOWBOARD = [
  { id: 101, sku: 'CS-ICE', title: 'Ice', available: true, price: 69995 },
  { id: 102, sku: 'CS-DAWN', title: 'Dawn', available: true, price: 74995 },
  { id: 103, sku: 'CS-SUN', title: 'Sunset', available: false, price: 64995 },
];

/* ---------------------------------------------------------- 3: sold out */
test('3: a sold-out variant is QUOTABLE by default and labelled as a backorder', () => {
  const p = page({ variants: SNOWBOARD, idField: '103' });
  assert.equal(p.button.disabled, false, 'default must not disable the button');
  p.button.click();
  const [line] = p.draft();
  assert.equal(line.variantId, '103');
  assert.equal(line.name, 'The Complete Snowboard - Sunset (Out of stock — quote request)');
});

test('3: "Disable the button" disables it for a sold-out variant only', () => {
  const { ns } = page();
  assert.equal(ns.soldOut({ available: false }, 'disable'), 'disable');
  assert.equal(ns.soldOut({ available: false }, 'allow'), 'quote');
  assert.equal(ns.soldOut({ available: false }, undefined), 'quote', 'an unset setting allows');
  assert.equal(ns.soldOut({ available: true }, 'disable'), 'ok');
});

test('3: the setting exists on add-to-quote, request-a-quote and the card embed, default allow', () => {
  for (const b of ['add-to-quote', 'request-a-quote', 'quote-cards']) {
    const src = readFileSync(join(EXT, 'blocks', `${b}.liquid`), 'utf8');
    const schema = JSON.parse(src.slice(src.indexOf('{% schema %}') + 12, src.indexOf('{% endschema %}')));
    const s = schema.settings.find((x) => x.id === 'sold_out');
    assert.ok(s, `${b} has no sold_out setting`);
    assert.equal(s.default, 'allow', b);
  }
});

/* ------------------------------------------------- 4: submit after send */
test('4: after a successful send the submit button is usable again and the contact is kept', async () => {
  const p = page({ variants: SNOWBOARD, idField: '101' });
  p.button.click();
  p.fields.name.value = 'Ada Buyer';
  p.fields.email.value = 'ada@example.test';
  const btn = p.drawer.named['[data-tackquote-submit]'];
  btn.click();
  await flush();
  await flush();
  assert.equal(p.status.textContent, 'OK');
  assert.equal(btn.disabled, false, 'the submit must not stay disabled');
  assert.equal(p.fields.email.value, 'ada@example.test');
  assert.deepEqual(p.draft(), []);
});

/* ----------------------------------------------------------- 7: count */
test('7: the count renders on first load when the draft is already non-empty', () => {
  const p = page({ storage: { 'tackquote:draft:shop.test': JSON.stringify([{ variantId: '1', name: 'x', quantity: 2 }]) } });
  assert.equal(p.badge.hidden, false);
  assert.equal(p.badge.textContent, '1');
});

test('7: an add updates the count through the same event and storage key', () => {
  const p = page({ variants: SNOWBOARD, idField: '101' });
  assert.equal(p.badge.hidden, true);
  p.button.click();
  assert.equal(p.badge.hidden, false);
  assert.equal(p.badge.textContent, '1');
});

test('7: the floating badge never paints its background with currentColor', () => {
  const css = readFileSync(join(ASSETS, 'tackquote-drawer.css'), 'utf8');
  assert.ok(!/--tq-count-bg:\s*currentColor/.test(css), 'currentColor on the badge is its own text colour: invisible');
  const fab = readFileSync(join(EXT, 'blocks', 'quote-fab.liquid'), 'utf8');
  const schema = JSON.parse(fab.slice(fab.indexOf('{% schema %}') + 12, fab.indexOf('{% endschema %}')));
  assert.equal(schema.settings.find((x) => x.id === 'show_count').default, true);
});

/* --------------------------------------------------- variants and price */
test('the SELECTED variant is added, with its own price and SKU', () => {
  const p = page({ variants: SNOWBOARD, idField: '102' });
  p.button.click();
  const [line] = p.draft();
  assert.deepEqual(
    { id: line.variantId, name: line.name, sku: line.sku, unit: line.unit, cur: line.cur },
    { id: '102', name: 'The Complete Snowboard - Dawn', sku: 'CS-DAWN', unit: 749.95, cur: 'EUR' },
  );
});

test('two variants make two lines; the same variant again adds quantity', () => {
  const p = page({ variants: SNOWBOARD, idField: '101' });
  p.button.click();
  p.idInput.value = '102';
  p.button.click();
  p.idInput.value = '101';
  p.button.click();
  assert.deepEqual(
    p.draft().map((l) => [l.name, l.quantity, l.unit]),
    [
      ['The Complete Snowboard - Ice', 2, 699.95],
      ['The Complete Snowboard - Dawn', 1, 749.95],
    ],
  );
});

test('prices format in the presentment currency; a wholesale rung wins; subtotal', () => {
  const { ns } = page();
  const line = { quantity: 10, unit: 699.95, cur: 'EUR', tiers: [[1, 600], [10, 550]] };
  assert.deepEqual(plain(ns.linePrice(line, 'EUR')), { each: 550, kind: 'w' });
  assert.equal(ns.linePrice(line, 'USD'), null, 'a line from another currency shows no price');
  assert.match(ns.money(550, 'EUR'), /€/);
  assert.equal(ns.quoteSubtotal([line, { quantity: 1, unit: 50, cur: 'EUR' }], 'EUR'), 5550);
  assert.equal(ns.quoteSubtotal([line, { quantity: 1 }], 'EUR'), null, 'no subtotal while a line is unpriced');
});

test('no display price is ever sent, and the buyer price only when typed', async () => {
  const p = page({ variants: SNOWBOARD, idField: '101' });
  p.drawer.dataset.tackquoteTargetPrice = '';
  p.button.click();
  p.fields.name.value = 'Ada';
  p.fields.email.value = 'ada@example.test';
  p.drawer.named['[data-tackquote-submit]'].click();
  await flush();
  await flush();
  const [first] = p.sent;
  assert.equal(first.url, '/apps/tackquote/quote-request');
  assert.deepEqual(Object.keys(first.body.items[0]).sort(), ['name', 'quantity', 'sku', 'variantId']);
  assert.equal(first.body.items[0].variantId, 101);

  const q = page({ variants: SNOWBOARD, idField: '101' });
  q.drawer.dataset.tackquoteTargetPrice = '';
  q.button.click();
  const items = q.draft();
  items[0].target = 500;
  q.store['tackquote:draft:shop.test'] = JSON.stringify(items);
  q.fields.name.value = 'Ada';
  q.fields.email.value = 'ada@example.test';
  q.ns.quote.open({ items, persist: true });
  q.drawer.named['[data-tackquote-submit]'].click();
  await flush();
  await flush();
  assert.equal(q.sent[0].body.items[0].price, 500);
});

test('the cart import carries display prices, one line per variant', () => {
  const { ns } = page();
  const lines = ns.cartLines(
    [
      { variant_id: 101, title: 'Ice', quantity: 1, price: 69995 },
      { variant_id: 101, title: 'Ice', quantity: 2, price: 69995 },
    ],
    'EUR',
  );
  assert.deepEqual(plain(lines), [{ variantId: '101', name: 'Ice', sku: '', quantity: 3, unit: 699.95, cur: 'EUR' }]);
});
