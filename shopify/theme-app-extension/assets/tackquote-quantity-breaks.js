/*
 * The volume/tier pricing table block. A READ, like `tackquote-price.js`: the
 * request goes to the merchant's own domain at the app proxy path and Shopify
 * signs the shop and customer; no tenant id travels from this page.
 * https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 *
 * Same resilience rules as the price block: a deadline on every request, a
 * failure removes the block (except in the theme editor), cache first.
 * A real <table> with <caption> and scoped headers, so a screen reader announces
 * "Quantity 10, Price 9.00" instead of two unattached columns.
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  /** Matches the price block. B2B contract prices change on the order of weeks. */
  const CACHE_TTL_MS = 5 * 60 * 1000;

  /*
   * The state machine, pure so it is tested on its own (test/blocks-state.test.mjs).
   * An EXPECTED answer is never a failure: `anonymous` is a guest (sign-in
   * prompt), `unlinked` a customer with no wholesale link (a quote CTA). Only a
   * real fetch failure reaches `standDown`, and only the merchant sees why.
   */
  /** Pure: the automatic heading for a view. */
  ns.breaksHeading = (view, applied, m) =>
    view === 'login' ? m.msgHeadingNeutral : applied ? m.msgHeadingApplied : m.msgHeadingQuote;

  ns.breaksView = (data, designMode, pageCurrency) => {
    const s = data && data.status;
    // Never a ladder in another currency than the page shows (Wave 3).
    if (ns.currencyView(data, pageCurrency) === 'mismatch') return 'currency';
    if (s === 'priced') return 'table';
    if (s === 'anonymous') return 'login';
    if (s === 'unlinked') {
      if (data.reason === 'shop_not_installed') return designMode ? 'not-connected' : 'hide';
      return 'unlinked';
    }
    return designMode ? 'empty' : 'hide';
  };

  ns.boot('.tackquote-block[data-tackquote-mode="quantity-breaks"]', (root) => {
    const proxy = ns.safeProxyPath(root.dataset.tackquoteProxy);
    const body = root.querySelector('[data-tackquote-breaks-body]');
    if (!proxy || !body) return;

    const variants = ns.variants(root);
    const designMode = root.dataset.tackquoteDesign === 'true';
    // Not an identity — an identity would have to be signed. This only
    // partitions the cache, so that logging out in the same tab cannot surface
    // a ladder the previous session was entitled to see.
    const customerMarker = root.dataset.tackquoteCustomer || 'anon';
    let inFlight = 0;

    function show(node) {
      root.hidden = false;
      body.textContent = '';
      body.appendChild(node);
    }

    function line(text, className) {
      const p = document.createElement('p');
      if (className) p.className = className;
      p.textContent = text;
      return p;
    }

    /* Rule 2. No answer, so get out of the way — hiding rather than emptying,
     * because an empty block still occupies its heading and its spacing, which
     * reads as a broken widget rather than an absent one. */
    function standDown(why) {
      if (designMode) {
        const frag = document.createDocumentFragment();
        frag.appendChild(line(root.dataset.msgError, 'tackquote-breaks__error'));
        if (why) frag.appendChild(line(why, 'tackquote-price__error-detail'));
        show(frag);
        return;
      }
      root.hidden = true;
    }

    function cell(tag, text, scope) {
      const el = document.createElement(tag);
      if (scope) el.scope = scope;
      el.textContent = text;
      return el;
    }

    function table(data, applied) {
      const el = document.createElement('table');
      el.className = 'tackquote-breaks__table';

      const caption = document.createElement('caption');
      caption.className = 'tackquote-breaks__caption';
      caption.textContent = applied ? root.dataset.msgCaptionApplied : root.dataset.msgCaption;
      el.appendChild(caption);

      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      headRow.appendChild(cell('th', root.dataset.msgQuantity, 'col'));
      headRow.appendChild(cell('th', applied ? root.dataset.msgPriceApplied : root.dataset.msgPrice, 'col'));
      head.appendChild(headRow);
      el.appendChild(head);

      const bodyEl = document.createElement('tbody');
      data.rows.forEach((row) => {
        const tr = document.createElement('tr');
        // `10+` rather than `10-49`: the server sends only the quantity at which
        // each price STARTS, because that is the only thing it can state without
        // inventing the top of a band. The last rung has no top at all.
        tr.appendChild(cell('th', `${row.minQty}+`, 'row'));
        tr.appendChild(cell('td', ns.money(row.unitPrice, data.currency)));
        bodyEl.appendChild(tr);
      });
      el.appendChild(bodyEl);
      return el;
    }

    let lastSku = '';
    function render(data) {
      // True only when TackQuote's checkout discount is confirmed active.
      const applied = data.checkoutApplied === true;
      const view = ns.breaksView(data, designMode, ns.pageCurrency(root));
      const h = root.querySelector('.tackquote-breaks__heading');
      if (h && root.dataset.tackquoteAutoHeading === 'true') {
        // A guest sees a sign-in prompt, not prices: a neutral heading, never
        // "applied at checkout" above "Sign in to see…" (QA 2026-10-01).
        h.textContent = ns.breaksHeading(view, applied, root.dataset);
      }
      if (view === 'hide') {
        root.hidden = true;
        return;
      }
      if (view === 'login') {
        // A guest, and the merchant has not published a public ladder. Like the
        // price block and every benchmark app: invite them to sign in.
        const wrap = document.createElement('div');
        wrap.appendChild(line(root.dataset.msgAnonymous));
        const link = document.createElement('a');
        link.className = 'tackquote-price__login';
        link.href = root.dataset.tackquoteLoginUrl || '/account/login';
        link.textContent = root.dataset.msgLogin;
        wrap.appendChild(link);
        show(wrap);
        return;
      }
      if (view === 'unlinked') {
        show(line(root.dataset.msgUnlinked));
        return;
      }
      if (view === 'currency') {
        show(line(applied ? root.dataset.msgCurrencyApplied : root.dataset.msgCurrencyQuote, 'tackquote-breaks__note'));
        return;
      }
      if (view === 'not-connected') {
        standDown(root.dataset.msgDiagNotConnected);
        return;
      }
      if (view === 'empty') {
        show(line(root.dataset.msgEmpty, 'tackquote-breaks__error'));
        return;
      }

      // This buyer's own rungs, for the quote drawer's DISPLAY price.
      if (lastSku && data.accountSpecific) {
        (ns.breaks = ns.breaks || {})[lastSku] = { rows: data.rows.map((r) => [r.minQty, r.unitPrice]), currency: data.currency };
      }
      const wrap = document.createElement('div');
      wrap.appendChild(table(data, applied));
      if (applied) wrap.appendChild(line(root.dataset.msgAppliedNote, 'tackquote-breaks__note'));
      // The server says whether these are this buyer's negotiated rates or the
      // tenant's list prices. Labelling one as the other is the failure the
      // whole wholesale surface exists to avoid.
      if (!data.accountSpecific) {
        wrap.appendChild(line(root.dataset.msgListNote, 'tackquote-breaks__note'));
      }
      show(wrap);
    }

    function refresh() {
      const variant = ns.findVariant(variants, ns.variantId(root));
      const sku = variant ? variant.sku : '';
      lastSku = sku;
      if (!sku) {
        // Not a failure: the variant has no SKU to price. Merchant hint only.
        if (designMode) show(line(root.dataset.msgDiagNoSku, 'tackquote-breaks__error'));
        else root.hidden = true;
        return;
      }

      const cacheKey = `tiers:${customerMarker}:${proxy}:${ns.pageCurrency(root)}:${sku}`;
      const cached = ns.cache.read(cacheKey);
      const token = ++inFlight;

      // Rule 3, first half: paint what we already know before asking anything.
      if (cached) render(cached);

      ns.fetchJson(`${proxy}/quantity-breaks?sku=${encodeURIComponent(sku)}${ns.currencyQuery(root)}`)
        .then((data) => {
          // A slow reply for a variant the shopper has already navigated away
          // from must not overwrite a newer one.
          if (token !== inFlight) return;

          // Only outcomes that do not depend on session state are remembered.
          // `anonymous` and `unlinked` can both change without this page
          // reloading — caching them would keep hiding the ladder from someone
          // who has just signed in.
          if (data.status === 'priced' || data.status === 'unpriced') {
            ns.cache.write(cacheKey, data, CACHE_TTL_MS);
          }
          render(data);
        })
        .catch((err) => {
          if (token !== inFlight) return;
          // Rule 3, second half. A stale ladder already on screen survives an
          // outage, and there is nothing better to replace it with.
          if (cached) return;
          standDown(ns.explain(root, err, proxy));
        });
    }

    // The ladder depends on the SKU but NOT on the quantity box — unlike the
    // price block, which re-asks on every quantity change. Listening to the form
    // anyway is what keeps it correct across a variant switch.
    ns.onChange(root, refresh);
    refresh();
  });
});
