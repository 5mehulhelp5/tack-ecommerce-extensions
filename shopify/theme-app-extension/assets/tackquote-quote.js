/*
 * The quote drawer and draft. POSTs only to `<proxy>/quote-request` (tenant from
 * Shopify's signed `shop`; never send a tenant id). No storefront price is ever
 * sent; `price` is only a target the BUYER typed. Notes: shopify/README.md.
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  if (ns.quoteOpen) return;
  const KEY = `tackquote:draft:${window.location.host}`;
  const MAX_ITEMS = 100;

  function loadDraft() {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      return [];
    }
  }

  function saveDraft(items) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(items));
    } catch (_err) {}
    document.dispatchEvent(new CustomEvent('tackquote:draft', { detail: { count: items.length } }));
  }

  // Merge by variant; null when full (API cap: 100 lines). `replace` sets the
  // quantity, so importing the cart twice never doubles a line.
  function mergeIntoDraft(lines, replace) {
    const items = loadDraft();
    let already = false;
    const fresh = lines.filter((l) => !items.some((i) => i.variantId === l.variantId));
    if (items.length + fresh.length > MAX_ITEMS) return null;
    for (const line of lines) {
      const existing = items.filter((i) => i.variantId === line.variantId)[0];
      if (existing) {
        existing.quantity = replace ? line.quantity : existing.quantity + line.quantity;
        already = true;
      } else {
        items.push(line);
      }
    }
    saveDraft(items);
    return { items, already };
  }

  const drawer = (id) =>
    (id && document.getElementById(id)) ||
    document.querySelector('dialog[data-tackquote-drawer][data-tackquote-rich]') ||
    document.querySelector('dialog[data-tackquote-drawer]');

  ns.quoteAdd = (lines, ctx) => {
    if (!drawer()) return false;
    const merged = mergeIntoDraft(lines, ctx && ctx.replace);
    if (!merged) return false;
    open(Object.assign({}, ctx, { items: merged.items, persist: true }));
    return true;
  };
  ns.quoteOpen = (from, id) => {
    if (!drawer(id)) return false;
    open({ items: loadDraft(), persist: true, from, id });
    return true;
  };

  // Lines, prices and subtotal: tackquote-quote-lines.js.
  const renderItems = (el, items, persist) => {
    if (ns.renderQuoteLines) ns.renderQuoteLines(el, items, persist, saveDraft);
  };

  function send(el, ctx, button, status) {
    const d = el.dataset;
    const field = (n) => el.querySelector(`[name="${n}"]`);
    const name = field('name').value.trim();
    const email = field('email').value.trim();
    if (!name || !email || !ctx.items.length) {
      status.textContent = d.msgRequired;
      (name ? field('email') : field('name')).focus();
      return;
    }
    button.disabled = true;
    status.textContent = d.msgSending;
    const say = (t) => {
      status.textContent = t;
    };
    const x = el.querySelector('[name="message"], [name="files"]') && ns.quoteExtras;
    const body = (extra) =>
      JSON.stringify({
        currency: ctx.currency,
        buyer: { name, email, company: field('company').value.trim() || undefined, message: extra.message },
        // Honeypot: filled means bot; the API answers success-shaped, creates nothing.
        hp: field('hp').value,
        items: ctx.items.map((i) => ({
          name: i.name,
          sku: i.sku || undefined,
          variantId: /^\d+$/.test(String(i.variantId)) && Number.isSafeInteger(Number(i.variantId)) ? Number(i.variantId) : undefined,
          quantity: i.quantity,
          // Only a price the BUYER typed; never the storefront's retail price.
          price: d.tackquoteTargetPrice !== undefined && typeof i.target === 'number' ? i.target : undefined,
        })),
        uploadIds: extra.uploadIds && extra.uploadIds.length ? extra.uploadIds : undefined,
        uploadToken: extra.uploadToken,
      });
    const url = `${ctx.proxy}/quote-request`;
    const go = (again) =>
      (x ? x.collect(el, ctx.proxy, say) : Promise.resolve({}))
        .then((extra) => {
          say(d.msgSending);
          if (x) return x.post(url, body(extra), 'application/json');
          return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(extra) }).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          });
        })
        .catch((err) => {
          if (x && !again && x.stale(err.message)) {
            x.reset();
            return go(true);
          }
          throw err;
        });

    go(false)
      .then(() => {
        say(d.msgSuccess);
        // Ready for the next request (QA: it looked stuck). Name, email and
        // company are kept for convenience; lines, message and files clear.
        button.disabled = false;
        ctx.items = [];
        if (ctx.persist) saveDraft([]);
        renderItems(el, ctx.items, ctx.persist);
        if (x) {
          x.reset();
          for (const f of el.querySelectorAll('[name="message"], [name="files"]')) f.value = '';
        }
      })
      .catch((err) => {
        const m = err && err.message;
        say(x && m && !/^HTTP \d/.test(m) ? m : d.msgFailure);
        button.disabled = false;
      });
  }

  function bind(el, ctx) {
    const d = el.dataset;
    ctx.proxy = ctx.proxy || ns.safeProxyPath(d.tackquoteProxy);
    ctx.currency = ctx.currency || d.tackquoteCurrency;
    const name = el.querySelector('[name="name"]');
    const email = el.querySelector('[name="email"]');
    if (!name.value) name.value = ctx.customerName || d.tackquoteCustomerName || '';
    if (!email.value) email.value = ctx.customerEmail || d.tackquoteCustomerEmail || '';

    renderItems(el, ctx.items, ctx.persist);
    const status = el.querySelector('[data-tackquote-drawer-status]');
    status.textContent = ctx.note || '';

    const old = el.querySelector('[data-tackquote-submit]');
    const button = old.cloneNode(true);
    button.disabled = !ctx.proxy;
    old.parentNode.replaceChild(button, old);
    button.addEventListener('click', () => send(el, ctx, button, status));
  }

  function open(ctx) {
    const el = drawer(ctx.id);
    if (!el) return;
    // Under <body> it inherits the theme's body type, not its section's.
    if (el.parentNode !== document.body) document.body.appendChild(el);
    if (!el.dataset.tqWired) {
      el.dataset.tqWired = '1';
      el.addEventListener('click', (e) => {
        if (e.target !== el) return;
        const r = el.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) el.close();
      });
    }
    if (ns.theme) ns.theme.carry(el, ctx.from);
    bind(el, ctx);
    if (!el.open) el.showModal();
  }

  ns.boot('[data-tackquote-inline]', (el) => {
    bind(el, { items: loadDraft(), persist: true });
  });

  ns.quote = { merge: mergeIntoDraft, open, drawer };
});
