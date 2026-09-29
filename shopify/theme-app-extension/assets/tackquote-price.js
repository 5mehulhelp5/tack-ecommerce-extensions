/*
 * The wholesale price block.
 *
 * This block READS, which is why it does not work like the button blocks. A
 * tenant id sitting in the DOM is caller-supplied, and a read keyed on one would
 * let anybody ask any tenant what it charges. So the request goes to the
 * MERCHANT's own domain at the app proxy path, and Shopify forwards it to
 * TackQuote with the shop and the logged-in customer id signed using the app
 * secret. The identity is asserted by Shopify, never by this file — and no
 * tenant id travels from this page at all.
 *
 * https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 *
 * ---------------------------------------------------------------------------
 * The availability problem this file is built around
 * ---------------------------------------------------------------------------
 * Competing B2B apps resolve their price natively in Liquid; we resolve ours
 * over an App Proxy round trip. That is a deliberate trade — it is what lets one
 * TackQuote price book serve Shopify, WooCommerce and the seller portal
 * identically — but it puts OUR latency and OUR uptime on the merchant's product
 * page, and theirs has no such dependency.
 *
 * Three rules follow, and they are why this file is longer than the markup it
 * produces:
 *
 *   1. Every request has a deadline. A slow answer is a failed answer.
 *   2. A failure degrades to the theme's own public price — the block REMOVES
 *      itself rather than printing an error beside a product. The shopper is
 *      left with a working product page, which is the state they would have been
 *      in had the merchant never installed us.
 *   3. A cached answer beats a fresh failure. The cache renders first and
 *      revalidates behind it, so an outage costs a stale price for the rest of
 *      the session rather than a blank block.
 *
 * Rule 2 is suspended in the theme editor. A merchant placing the block needs to
 * see that it is failing; a shopper does not.
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  /**
   * How long a resolved price may be reused within one tab.
   *
   * B2B contract prices change on the order of weeks, so five minutes is
   * conservative. It is bounded by the tab, not the browser — see `ns.cache`.
   */
  const CACHE_TTL_MS = 5 * 60 * 1000;

  ns.boot('.tackquote-block[data-tackquote-mode="price"]', (root) => {
    const proxy = ns.safeProxyPath(root.dataset.tackquoteProxy);
    const body = root.querySelector('[data-tackquote-price-body]');
    if (!proxy || !body) return;

    const variants = ns.variants(root);
    const designMode = root.dataset.tackquoteDesign === 'true';
    // Not an identity — an identity would have to be signed. This only
    // partitions the cache, so that logging out in the same tab cannot surface
    // the price the previous session was entitled to see.
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

    function money(amount, currency) {
      try {
        return new Intl.NumberFormat(document.documentElement.lang || 'en', {
          style: 'currency',
          currency: currency || 'USD',
        }).format(amount);
      } catch (_err) {
        return `${String(amount)} ${String(currency || '')}`;
      }
    }

    /** Merchant-only diagnosis. Copy lives in Liquid (`data-msg-diag-*`, design mode only). */
    function explain(err, proxyPath) {
      const msg = err && err.message ? String(err.message) : '';
      const d = root.dataset;
      let key = 'msgDiagFail';
      if (msg === 'STOREFRONT_PASSWORD') key = 'msgDiagPassword';
      else if (msg === 'NOT_JSON') key = 'msgDiagNotJson';
      else if (msg === 'HTTP 404') key = 'msgDiag404';
      else if (msg === 'HTTP 401' || msg === 'HTTP 403') key = 'msgDiagAuth';
      else if (/^HTTP 5/.test(msg)) key = 'msgDiag5xx';
      else if (err && err.name === 'AbortError') key = 'msgDiagTimeout';
      return ns.format(d[key], { path: proxyPath, status: msg });
    }

    /** Rule 2: no answer, so get out of the way (hide, do not empty: an empty block still reads as broken). */
    /** `why` is rendered ONLY in the theme editor (`Shopify.designMode` guidance); shoppers see nothing. */
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
      if (data.status === 'anonymous') {
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

      if (data.status === 'unlinked') {
        // `unlinked` means two different things and the server now says which.
        //
        // `shop_not_installed` is a MERCHANT condition — the store has no
        // TackQuote install — and the install check runs before the anonymous
        // one, so it reaches even logged-out visitors. Showing them the
        // wholesale CTA offers help that cannot arrive: applying for access to
        // a store that is not connected does nothing. Render nothing at all and
        // let the merchant find it in their own setup, rather than putting a
        // dead prompt in front of every shopper.
        //
        // Older servers send no `reason`. Absence therefore keeps the previous
        // behaviour exactly, so this block is safe against an un-updated API.
        //
        // `standDown()` rather than a bare hide, and that is the useful part:
        // in the theme editor it shows the merchant the error message, and on a
        // live storefront it hides. So the person who can fix a broken install
        // is the one who is told about it, which is what the issue asked for.
        if (data.reason === 'shop_not_installed') {
          standDown(root.dataset.msgDiagNotConnected);
          return;
        }
        show(line(root.dataset.msgUnlinked));
        return;
      }

      if (data.status === 'priced') {
        const box = document.createElement('div');
        box.appendChild(
          line(
            `${money(data.unitPrice, data.currency)} ${root.dataset.msgEach}`,
            'tackquote-price__amount',
          ),
        );
        // A catalogue list price is a real number but it is NOT this buyer's
        // negotiated rate, and the server says which it is. Labelling one as the
        // other is the failure this whole path exists to avoid.
        if (!data.accountSpecific) {
          box.appendChild(line(root.dataset.msgListNote, 'tackquote-price__note'));
        }
        box.appendChild(line(root.dataset.msgQuoteNote, 'tackquote-price__note'));
        show(box);
        return;
      }

      show(line(root.dataset.msgUnpriced));
    }

    function refresh() {
      const variant = ns.findVariant(variants, ns.variantId(root));
      const sku = variant ? variant.sku : '';
      if (!sku) {
        show(line(root.dataset.msgUnpriced));
        return;
      }

      const quantity = ns.quantity(root);
      const cacheKey = `price:${customerMarker}:${proxy}:${sku}:${quantity}`;
      const cached = ns.cache.read(cacheKey);
      const token = ++inFlight;

      // Rule 3, first half: paint what we already know before asking anything,
      // so a repeat view costs no visible wait at all.
      if (cached) render(cached);

      ns.fetchJson(
        `${proxy}/wholesale-price?sku=${encodeURIComponent(sku)}&quantity=${encodeURIComponent(String(quantity))}`,
      )
        .then((data) => {
          // A slow reply for a variant the shopper has already navigated away
          // from must not overwrite a newer one.
          if (token !== inFlight) return;

          // Only a resolved answer is worth remembering. `anonymous` and
          // `unlinked` depend on state that can change without this page
          // reloading, and caching them would keep telling someone to log in
          // after they just did.
          if (data.status === 'priced' || data.status === 'unpriced') {
            ns.cache.write(cacheKey, data, CACHE_TTL_MS);
          }
          render(data);
        })
        .catch((err) => {
          if (token !== inFlight) return;
          // Rule 3, second half. A stale price already on screen survives an
          // outage, and there is nothing better to replace it with.
          if (cached) return;
          standDown(explain(err, proxy));
        });
    }

    ns.onChange(root, refresh);
    refresh();
  });
});
