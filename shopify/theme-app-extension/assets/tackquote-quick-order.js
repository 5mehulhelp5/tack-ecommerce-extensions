/*
 * Quick Order block: a signed-in trade buyer pastes "SKU, quantity" lines, and
 * TackQuote answers which SKUs exist, their price in the page currency and any
 * order limits (GET {proxy}/quick-order, signed by the App Proxy). Found lines
 * go to the cart in one Ajax call, or to the quote drawer.
 * Cart API: https://shopify.dev/docs/api/ajax/reference/cart (POST cart/add.js
 * with an `items` array). Checkout pricing and the order-limits validation
 * still apply at checkout; the checks here only save the buyer a rejection.
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  const MAX_LINES = 50;

  /** Pure. "SKU, 3" / "SKU 3" / "SKU<TAB>3" / "SKU" (qty 1). Duplicates add up. */
  ns.parseQuickOrder = (text) => {
    const bySku = new Map();
    const bad = [];
    String(text || '')
      .split(/\r?\n/)
      .forEach((raw, i) => {
        const row = raw.trim();
        if (!row) return;
        const m = row.match(/^([^\s,;\t]{1,64})(?:[\s,;\t]+(\d{1,6}))?$/);
        if (!m) return bad.push(i + 1);
        const qty = m[2] === undefined ? 1 : Number(m[2]);
        if (qty < 1) return bad.push(i + 1);
        bySku.set(m[1], (bySku.get(m[1]) || 0) + qty);
      });
    const lines = [...bySku].map(([sku, quantity]) => ({ sku, quantity }));
    return { lines: lines.slice(0, MAX_LINES), bad, tooMany: lines.length > MAX_LINES };
  };

  /** Pure. The first per-line quantity rule this quantity breaks, or null. */
  ns.lineLimit = (quantity, limits) => {
    for (const l of limits || []) {
      if (l.limitType !== 'product_qty' && l.limitType !== 'per_product_qty') continue;
      if (l.min != null && quantity < l.min) return { kind: 'Min', value: l.min, message: l.message };
      if (l.max != null && quantity > l.max) return { kind: 'Max', value: l.max, message: l.message };
    }
    return null;
  };

  /** Pure. What the block shows for a lookup answer. */
  ns.quickOrderView = (data) => {
    const s = data && data.status;
    if (s === 'anonymous') return 'login';
    if (s === 'unlinked') return data.reason === 'shop_not_installed' ? 'not-connected' : 'unlinked';
    if (s === 'ok' && Array.isArray(data.items)) return 'rows';
    return 'error';
  };

  ns.boot('.tackquote-block[data-tackquote-mode="quick-order"]', (root) => {
    const d = root.dataset;
    const proxy = ns.safeProxyPath(d.tackquoteProxy);
    const input = root.querySelector('[data-tackquote-qo-input]');
    const out = root.querySelector('[data-tackquote-qo-out]');
    const status = root.querySelector('[data-tackquote-qo-status]');
    const check = root.querySelector('[data-tackquote-qo-check]');
    const toCart = root.querySelector('[data-tackquote-qo-cart]');
    const toQuote = root.querySelector('[data-tackquote-qo-quote]');
    if (!proxy || !input || !out || !check) return;
    const pageCurrency = ns.pageCurrency(root);
    let rows = [];

    const say = (text) => {
      status.textContent = text || '';
    };
    const cell = (tr, text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
      return td;
    };

    function ready() {
      const ok = rows.filter((r) => r.variantId && !r.problem);
      const blocked = rows.some((r) => r.variantId && r.problem);
      if (toCart) toCart.disabled = !ok.length || blocked;
      if (toQuote) toQuote.disabled = !ok.length || blocked;
      return ok;
    }

    function limitText(row) {
      const p = ns.lineLimit(row.quantity, row.limits);
      row.problem = p;
      if (!p) return '';
      if (p.message && p.message.trim()) return p.message;
      return ns.format(d[`msgLimit${p.kind}`], { n: String(p.value) });
    }

    function draw(data, lines) {
      const qtyBySku = new Map(lines.map((l) => [l.sku, l.quantity]));
      const hidePrice = data.priceHidden || ns.currencyView(data, pageCurrency) === 'mismatch';
      rows = data.items.map((it) => ({
        sku: it.sku,
        variantId: it.found && it.variantId ? String(it.variantId) : '',
        title: it.title || it.sku,
        quantity: qtyBySku.get(it.sku) || 1,
        price: hidePrice || !it.price ? null : it.price,
        limits: it.limits || [],
      }));
      const table = document.createElement('table');
      table.className = 'tackquote-qo__table';
      const head = table.createTHead().insertRow();
      for (const k of ['msgColSku', 'msgColItem', 'msgColQty', 'msgColPrice']) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = d[k];
        head.appendChild(th);
      }
      const body = table.createTBody();
      rows.forEach((row) => {
        const tr = body.insertRow();
        cell(tr, row.sku);
        const item = cell(tr, row.variantId ? row.title : d.msgNotFound);
        const qtyCell = document.createElement('td');
        const qty = document.createElement('input');
        qty.type = 'number';
        qty.min = '1';
        qty.value = String(row.quantity);
        qty.disabled = !row.variantId;
        qty.setAttribute('aria-label', `${d.msgColQty} ${row.sku}`);
        const note = document.createElement('small');
        note.className = 'tackquote-qo__limit';
        note.textContent = limitText(row);
        qty.addEventListener('change', () => {
          const n = Number.parseInt(qty.value, 10);
          row.quantity = Number.isFinite(n) && n > 0 ? n : 1;
          note.textContent = limitText(row);
          ready();
        });
        qtyCell.append(qty, note);
        tr.appendChild(qtyCell);
        cell(tr, row.price ? `${ns.money(row.price.unitPrice, data.currency)} ${d.msgEach}` : row.variantId ? d.msgPriceAtCheckout : '');
        if (!row.variantId) item.className = 'tackquote-qo__missing';
      });
      out.textContent = '';
      out.appendChild(table);
      if (hidePrice) out.appendChild(Object.assign(document.createElement('p'), { textContent: d.msgCurrency }));
      say('');
      ready();
    }

    check.addEventListener('click', () => {
      const parsed = ns.parseQuickOrder(input.value);
      if (!parsed.lines.length) return say(d.msgEmpty);
      if (parsed.tooMany) say(d.msgTooMany);
      else if (parsed.bad.length) say(ns.format(d.msgBadLines, { lines: parsed.bad.join(', ') }));
      else say(d.msgLoading);
      const skus = parsed.lines.map((l) => encodeURIComponent(l.sku)).join(',');
      ns.fetchJson(`${proxy}/quick-order?skus=${skus}${ns.currencyQuery(root)}`, { timeoutMs: 6000 })
        .then((data) => {
          const view = ns.quickOrderView(data);
          if (view === 'rows') return draw(data, parsed.lines);
          out.textContent = '';
          say(view === 'unlinked' ? d.msgUnlinked : view === 'login' ? d.msgSignIn : d.msgError);
          if (view === 'not-connected' && d.tackquoteDesign === 'true') say(d.msgDiagNotConnected);
        })
        .catch((err) => say(d.tackquoteDesign === 'true' ? ns.explain(root, err, proxy) : d.msgError));
    });

    if (toCart) {
      toCart.addEventListener('click', () => {
        const items = ready().map((r) => ({ id: Number(r.variantId), quantity: r.quantity }));
        if (!items.length) return;
        toCart.disabled = true;
        const rootUrl = (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || '/';
        fetch(`${rootUrl}cart/add.js`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ items }),
        })
          .then((res) => res.json().then((body) => ({ res, body })))
          .then(({ res, body }) => {
            // The Cart API answers 422 with a `description` (sold out, too many).
            if (!res.ok) throw new Error(body && body.description ? body.description : d.msgCartFailed);
            say(d.msgAddedCart);
            document.dispatchEvent(new CustomEvent('tackquote:cart-updated', { detail: body }));
          })
          .catch((err) => say(err && err.message ? err.message : d.msgCartFailed))
          .finally(() => ready());
      });
    }

    if (toQuote) {
      toQuote.addEventListener('click', () => {
        const lines = ready().map((r) => ({ variantId: r.variantId, name: r.title, sku: r.sku, quantity: r.quantity }));
        if (!lines.length) return;
        const ok = typeof ns.quoteAdd === 'function' && ns.quoteAdd(lines, { proxy, currency: pageCurrency });
        if (!ok) say(d.msgQuoteFailed);
      });
    }
  });
});
