/*
 * The quote request (Add/Request a Quote, quote-cart buttons, Quote page).
 * POSTs only to `<proxy>/quote-request` via the App Proxy on the merchant's own
 * domain; the server derives the tenant from Shopify's signed `shop`, so no
 * tenant id travels from here (never restore one). The quote accumulates in
 * localStorage and is sent whole. No storefront price is ever sent (see
 * tackquote-selection.liquid); a line carries `price` only when the merchant
 * turned on "Ask for a target price" and the BUYER typed one, which the API
 * records as the requested price. Each draft write fires `tackquote:draft`.
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
    } catch (_err) {
      /* not persisted */
    }
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

  // The trigger's own dialog when it names one (aria-controls), else the first.
  const drawer = (id) => (id && document.getElementById(id)) || document.querySelector('dialog[data-tackquote-drawer]');

  // Add lines and open the drawer; false when full or there is no drawer.
  ns.quoteAdd = (lines, ctx) => {
    if (!drawer()) return false;
    const merged = mergeIntoDraft(lines, ctx && ctx.replace);
    if (!merged) return false;
    open(Object.assign({}, ctx, { items: merged.items, persist: true }));
    return true;
  };
  // Open on the saved quote; `from` is the trigger's styled root.
  ns.quoteOpen = (from, id) => {
    if (!drawer(id)) return false;
    open({ items: loadDraft(), persist: true, from, id });
    return true;
  };

  const mk = (tag, cls, props) => {
    const n = Object.assign(document.createElement(tag), props || {});
    if (cls) n.className = cls;
    return n;
  };

  function renderItems(el, items, persist) {
    const list = el.querySelector('[data-tackquote-items]');
    const d = el.dataset;
    const save = () => persist && saveDraft(items);
    list.textContent = '';
    el.querySelector('[data-tackquote-empty]').hidden = items.length > 0;

    items.forEach((item, index) => {
      const li = mk('li', 'tackquote-line');
      const ctl = mk('div', 'tackquote-line__controls');
      const box = mk('div', 'tackquote-qty');
      const qty = mk('input', 'tackquote-qty__input', { type: 'number', min: '1', inputMode: 'numeric', value: String(item.quantity) });
      qty.setAttribute('aria-label', `${d.msgQuantity}: ${item.name}`);
      const set = (n) => {
        items[index].quantity = Number.isFinite(n) && n > 0 ? Math.min(n, 1000000) : 1;
        qty.value = String(items[index].quantity);
        save();
      };
      const step = (label, glyph, delta) => {
        const b = mk('button', 'tackquote-icon-button', { type: 'button', textContent: glyph });
        b.setAttribute('aria-label', `${label}: ${item.name}`);
        b.addEventListener('click', () => set(items[index].quantity + delta));
        return b;
      };
      qty.addEventListener('change', () => set(Number.parseInt(qty.value, 10)));
      box.append(step(d.msgDecrease, '−', -1), qty, step(d.msgIncrease, '+', 1));
      ctl.append(box);

      // Optional, buyer-typed only: sent as the line's requested `price`.
      if (d.tackquoteTargetPrice !== undefined) {
        const lab = mk('label', 'tackquote-line__target');
        const tp = mk('input', 'tackquote-field tackquote-field--short', { type: 'number', min: '0', step: '0.01', inputMode: 'decimal' });
        if (typeof item.target === 'number') tp.value = String(item.target);
        tp.addEventListener('change', () => {
          const v = Number.parseFloat(tp.value);
          items[index].target = Number.isFinite(v) && v >= 0 ? Math.round(v * 10000) / 10000 : undefined;
          save();
        });
        lab.append(mk('span', '', { textContent: d.msgTarget }), tp);
        ctl.append(lab);
      }

      const remove = mk('button', 'tackquote-link-button', { type: 'button', textContent: d.msgRemove });
      remove.setAttribute('aria-label', `${d.msgRemove}: ${item.name}`);
      remove.addEventListener('click', () => {
        items.splice(index, 1);
        save();
        renderItems(el, items, persist);
        // Keep focus in the list, not on <body>.
        const next = list.querySelectorAll('.tackquote-link-button')[Math.min(index, items.length - 1)];
        (next || el.querySelector('[name="name"]')).focus();
      });
      ctl.append(remove);
      li.append(mk('span', 'tackquote-line__name', { textContent: item.name }), ctl);
      list.appendChild(li);
    });
  }

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

    fetch(`${ctx.proxy}/quote-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currency: ctx.currency,
        buyer: { name, email, company: field('company').value.trim() || undefined },
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
      }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(() => {
        status.textContent = d.msgSuccess;
        ctx.items = [];
        if (ctx.persist) saveDraft([]);
        renderItems(el, ctx.items, ctx.persist);
      })
      .catch(() => {
        status.textContent = d.msgFailure;
        button.disabled = false;
      });
  }

  // Fill and wire the form (modal and inline page).
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

    // A fresh button drops the previous open's listener.
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
      // Backdrop click closes, like theme drawers.
      el.addEventListener('click', (e) => {
        if (e.target !== el) return;
        const r = el.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) el.close();
      });
    }
    // Styled from the OPENING block's section (colour schemes are per section).
    if (ns.theme) ns.theme.carry(el, ctx.from);
    bind(el, ctx);
    if (!el.open) el.showModal();
  }

  ns.boot('[data-tackquote-inline]', (el) => {
    bind(el, { items: loadDraft(), persist: true });
  });

  // For the trigger runtime (tackquote-quote-cart.js): merge, and open with a context.
  ns.quote = { merge: mergeIntoDraft, open, drawer };
});
