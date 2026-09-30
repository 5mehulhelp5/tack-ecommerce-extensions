/*
 * The wholesale price block.
 *
 * This block READS, so it never trusts a tenant id in the DOM. The request goes
 * to the MERCHANT's own domain at the app proxy path, and Shopify forwards it
 * with the shop and the logged-in customer id signed with the app secret.
 * https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 *
 * Availability rules (our latency sits on the merchant's product page):
 *   1. Every request has a deadline; a slow answer is a failed answer.
 *   2. A failure removes the block, leaving the theme's own price. Suspended in
 *      the theme editor, where the merchant must see the failure.
 *   3. A cached answer beats a fresh failure: cache first, revalidate behind it.
 *
 * Currency (Wave 3): the page's presentment currency (Liquid
 * `cart.currency.iso_code`) is sent with the request, and a priced answer in any
 * other currency is never shown. A USD figure beside a EUR product would be a
 * wrong price, not a missing one.
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  // B2B contract prices change over weeks; five minutes, bounded by the tab.
  const CACHE_TTL_MS = 5 * 60 * 1000;

  ns.boot('.tackquote-block[data-tackquote-mode="price"]', (root) => {
    const proxy = ns.safeProxyPath(root.dataset.tackquoteProxy);
    const body = root.querySelector('[data-tackquote-price-body]');
    if (!proxy || !body) return;

    const variants = ns.variants(root);
    const designMode = root.dataset.tackquoteDesign === 'true';
    // Not an identity: it only partitions the cache, so logging out in the same
    // tab cannot surface the previous session's price.
    const customerMarker = root.dataset.tackquoteCustomer || 'anon';
    const pageCurrency = ns.pageCurrency(root);
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

    /** Rule 2. `why` renders ONLY in the theme editor; shoppers see nothing. */
    function standDown(why) {
      if (designMode) {
        const frag = document.createDocumentFragment();
        frag.appendChild(line(root.dataset.msgError, 'tackquote-price__error'));
        if (why) {
          const detail = line(why, 'tackquote-price__error-detail');
          detail.setAttribute('data-tackquote-diagnostic', '');
          frag.appendChild(detail);
        }
        show(frag);
        return;
      }
      root.hidden = true;
    }

    function render(data) {
      // True only when TackQuote's checkout discount is confirmed active.
      const applied = data.checkoutApplied === true;
      const d = root.dataset;
      const h = root.querySelector('.tackquote-price__heading');
      if (h && d.tackquoteAutoHeading === 'true') {
        h.textContent = applied ? d.msgHeadingApplied : d.msgHeadingQuote;
      }
      if (data.status === 'anonymous') {
        const wrap = document.createElement('div');
        wrap.appendChild(line(applied ? d.msgAnonymousApplied : d.msgAnonymous));
        const link = document.createElement('a');
        link.className = 'tackquote-price__login';
        link.href = d.tackquoteLoginUrl || '/account/login';
        link.textContent = d.msgLogin;
        wrap.appendChild(link);
        show(wrap);
        return;
      }

      if (data.status === 'unlinked') {
        // `shop_not_installed` is the MERCHANT's problem: tell them in the
        // editor, show shoppers nothing. No reason (older API) keeps the CTA.
        if (data.reason === 'shop_not_installed') {
          standDown(d.msgDiagNotConnected);
          return;
        }
        show(line(d.msgUnlinked));
        return;
      }

      // Server refused to price in this currency, or answered in another one.
      if (ns.currencyView(data, pageCurrency) === 'mismatch') {
        show(line(applied ? d.msgCurrencyApplied : d.msgCurrencyQuote, 'tackquote-price__note'));
        return;
      }

      if (data.status === 'priced') {
        const box = document.createElement('div');
        box.appendChild(
          line(`${ns.money(data.unitPrice, data.currency)} ${d.msgEach}`, 'tackquote-price__amount'),
        );
        // A catalogue list price is not this buyer's negotiated rate.
        if (!data.accountSpecific) {
          box.appendChild(line(d.msgListNote, 'tackquote-price__note'));
        }
        box.appendChild(line(applied ? d.msgAppliedNote : d.msgQuoteNote, 'tackquote-price__note'));
        show(box);
        return;
      }

      show(line(d.msgUnpriced));
    }

    function refresh() {
      const variant = ns.findVariant(variants, ns.variantId(root));
      const sku = variant ? variant.sku : '';
      if (!sku) {
        // Shoppers get "no price set"; the merchant is told the fix (add a SKU).
        const frag = document.createDocumentFragment();
        frag.appendChild(line(root.dataset.msgUnpriced));
        if (designMode) frag.appendChild(line(root.dataset.msgDiagNoSku, 'tackquote-price__error-detail'));
        show(frag);
        return;
      }

      const quantity = ns.quantity(root);
      const cacheKey = `price:${customerMarker}:${proxy}:${pageCurrency}:${sku}:${quantity}`;
      const cached = ns.cache.read(cacheKey);
      const token = ++inFlight;

      if (cached) render(cached);

      ns.fetchJson(
        `${proxy}/wholesale-price?sku=${encodeURIComponent(sku)}&quantity=${encodeURIComponent(String(quantity))}${ns.currencyQuery(root)}`,
      )
        .then((data) => {
          // A slow reply for a variant the shopper has left must not win.
          if (token !== inFlight) return;
          // Only resolved answers are cached; anonymous/unlinked can change.
          if (data.status === 'priced' || data.status === 'unpriced') {
            ns.cache.write(cacheKey, data, CACHE_TTL_MS);
          }
          render(data);
        })
        .catch((err) => {
          if (token !== inFlight) return;
          if (cached) return;
          standDown(ns.explain(root, err, proxy));
        });
    }

    ns.onChange(root, refresh);
    refresh();
  });
});
