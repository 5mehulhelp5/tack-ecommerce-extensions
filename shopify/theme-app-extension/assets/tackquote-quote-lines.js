/*
 * The quote drawer's lines: name (with its variant), quantity stepper, the
 * DISPLAYED price and line total, the optional buyer-asked price, remove, and
 * an estimated subtotal.
 *
 * Prices here are display only. The request never carries them (see
 * tackquote-quote.js `body`); TackQuote prices every line server-side. A line
 * shows, in order: the buyer's TackQuote quantity-break rung for its quantity,
 * their TackQuote wholesale price ("Your price"), then the variant's storefront
 * price ("Price"). All in the presentment currency the line was added in; a
 * line added in another currency shows no price rather than a wrong one.
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  if (ns.renderQuoteLines) return;

  /** Pure: { each, kind: 'w' | 'r' } in major units, or null when unknown. */
  ns.linePrice = (item, cur) => {
    if (!item || (item.cur && cur && item.cur !== cur)) return null;
    if (Array.isArray(item.tiers) && item.tiers.length) {
      let each = null;
      for (const t of item.tiers.slice().sort((a, b) => a[0] - b[0])) if (item.quantity >= t[0]) each = t[1];
      if (each !== null) return { each, kind: 'w' };
    }
    if (typeof item.wprice === 'number') return { each: item.wprice, kind: 'w' };
    if (typeof item.unit === 'number') return { each: item.unit, kind: 'r' };
    return null;
  };
  /** Pure: the estimated subtotal, or null unless EVERY line has a price. */
  ns.quoteSubtotal = (items, cur) => {
    let t = 0;
    for (const i of items) {
      const p = ns.linePrice(i, cur);
      if (!p) return null;
      t += p.each * i.quantity;
    }
    return items.length ? Math.round(t * 100) / 100 : null;
  };

  const mk = (tag, cls, props) => {
    const n = Object.assign(document.createElement(tag), props || {});
    if (cls) n.className = cls;
    return n;
  };

  ns.renderQuoteLines = (el, items, persist, saveDraft) => {
    const list = el.querySelector('[data-tackquote-items]');
    const d = el.dataset;
    const cur = d.tackquoteCurrency;
    const money = (n) => ns.money(n, cur);
    const sub = el.querySelector('[data-tackquote-subtotal]');
    const total = () => {
      if (!sub) return;
      const t = ns.quoteSubtotal(items, cur);
      sub.hidden = t === null;
      sub.textContent = t === null ? '' : ns.format(d.msgSubtotal, { amount: money(t) });
    };
    const save = () => {
      if (persist) saveDraft(items);
      total();
    };
    list.textContent = '';
    el.querySelector('[data-tackquote-empty]').hidden = items.length > 0;

    items.forEach((item, index) => {
      const li = mk('li', 'tackquote-line');
      const ctl = mk('div', 'tackquote-line__controls');
      const box = mk('div', 'tackquote-qty');
      const qty = mk('input', 'tackquote-qty__input', { type: 'number', min: '1', inputMode: 'numeric', value: String(item.quantity) });
      qty.setAttribute('aria-label', `${d.msgQuantity}: ${item.name}`);
      const price = mk('span', 'tackquote-line__price');
      const showPrice = () => {
        const p = ns.linePrice(items[index], cur);
        price.hidden = !p;
        price.textContent = p
          ? `${p.kind === 'w' ? d.msgYourPrice : d.msgPrice}: ${money(p.each)} ${d.msgEach} · ${money(p.each * items[index].quantity)}`
          : '';
      };
      const set = (n) => {
        items[index].quantity = Number.isFinite(n) && n > 0 ? Math.min(n, 1000000) : 1;
        qty.value = String(items[index].quantity);
        showPrice();
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

      // The price the buyer is asking for: optional, sent only when typed.
      if (d.tackquoteTargetPrice !== undefined) {
        const lab = mk('label', 'tackquote-line__target');
        const tp = mk('input', 'tackquote-field tackquote-field--short', { type: 'number', min: '0', step: '0.01', inputMode: 'decimal' });
        if (typeof item.target === 'number') tp.value = String(item.target);
        tp.addEventListener('change', () => {
          const v = Number.parseFloat(tp.value);
          items[index].target = tp.value.trim() !== '' && Number.isFinite(v) && v >= 0 ? Math.round(v * 10000) / 10000 : undefined;
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
        ns.renderQuoteLines(el, items, persist, saveDraft);
        // Keep focus in the list, not on <body>.
        const next = list.querySelectorAll('.tackquote-link-button')[Math.min(index, items.length - 1)];
        (next || el.querySelector('[name="name"]')).focus();
      });
      ctl.append(remove);
      showPrice();
      li.append(mk('span', 'tackquote-line__name', { textContent: item.name }), price, ctl);
      list.appendChild(li);
    });
    total();
  };
});
