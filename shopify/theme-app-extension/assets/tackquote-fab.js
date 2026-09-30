/*
 * The floating quote cart (blocks/quote-fab.liquid): keeps clear of the
 * theme's own fixed bars and chat launchers, steps aside while any modal is
 * open, collapses to its icon on scroll, announces count changes, and places
 * the optional header quote icon beside the theme's cart link.
 *
 * Opening the drawer and painting counts are tackquote-quote-cart.js's job;
 * this file only positions. Every measurement is a read of the layout the
 * theme already produced, batched behind a timer, so it adds no layout shift.
 */
(window.TackQuoteQ = window.TackQuoteQ || []).push((ns) => {
  if (ns.fab) return;
  ns.fab = true;
  const CHATS = '#ShopifyChat, [id*="gorgias"], #tidio-chat, .intercom-lightweight-app, #shopify-chat';
  const fabs = () => document.querySelectorAll('[data-tackquote-fab]');
  const shown = (el) => {
    if (!el.getClientRects().length) return false;
    const cs = window.getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
  };

  // A THEME drawer or modal is open: dialogs, aria-modal panels that are
  // actually visible (Dawn keeps its cart drawer in the DOM), Dawn's body lock.
  // Our own quote dialog is excluded: it sits in the top layer anyway, and the
  // button must stay focusable so focus can return to it when the dialog closes.
  const modalOpen = () => {
    if (/(^|\s)overflow-hidden/.test(document.body.className)) return true;
    for (const el of document.querySelectorAll('dialog[open]:not([data-tackquote-drawer]), [aria-modal="true"], details[open] > .menu-drawer')) {
      if (shown(el)) return true;
    }
    return false;
  };

  function fixedBar(el, fab) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (fab.contains(n)) return null;
      const p = window.getComputedStyle(n).position;
      if (p === 'fixed' || p === 'sticky') return n.getBoundingClientRect().height < window.innerHeight / 2 ? n : null;
    }
    return null;
  }

  // Measured against the button's BASE position (current rect + current lift),
  // so nothing is zeroed and re-applied: the lift only changes when it must,
  // and the transition never replays (no bounce).
  function place(fab) {
    const hide = modalOpen() ? 'hidden' : '';
    if (fab.style.visibility !== hide) fab.style.visibility = hide;
    if (hide || !shown(fab) || window.getComputedStyle(fab).bottom === 'auto') return;
    const cur = Number.parseFloat(fab.style.getPropertyValue('--tq-lift')) || 0;
    const r = fab.getBoundingClientRect();
    const base = r.bottom + cur;
    let lift = 0;
    // Chat launchers: their height plus 12px, when they share our side.
    for (const c of document.querySelectorAll(CHATS)) {
      if (!shown(c)) continue;
      const cr = c.getBoundingClientRect();
      if (cr.right > r.left - 12 && cr.left < r.right + 12 && cr.top > window.innerHeight / 2) {
        lift = Math.max(lift, base - cr.top + 12);
      }
    }
    // Sticky add-to-cart bars, cookie banners: anything fixed under our base corners.
    if (document.elementsFromPoint && base - 2 < window.innerHeight) {
      for (const x of [r.left + 2, r.right - 2]) {
        for (const el of document.elementsFromPoint(x, base - 2)) {
          const bar = fixedBar(el, fab);
          if (bar) lift = Math.max(lift, base - bar.getBoundingClientRect().top + 8);
        }
      }
    }
    const next = Math.max(0, Math.round(lift));
    if (next !== cur) fab.style.setProperty('--tq-lift', `${next}px`);
  }

  let timer = null;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fabs().forEach(place), 150);
  };

  // Collapse to the icon while scrolling down (always under 750px, else if set).
  let lastY = window.scrollY;
  window.addEventListener(
    'scroll',
    () => {
      const y = window.scrollY;
      const down = y > lastY && y > 120;
      lastY = y;
      fabs().forEach((fab) => {
        const small = window.matchMedia('(max-width: 749px)').matches;
        if (fab.dataset.collapse === undefined && !small) return;
        // Written only on a change, so scrolling does not churn attributes.
        if (down && fab.dataset.collapsed === undefined) fab.dataset.collapsed = '';
        else if (!down && fab.dataset.collapsed !== undefined) delete fab.dataset.collapsed;
      });
      later();
    },
    { passive: true },
  );
  window.addEventListener('resize', later, { passive: true });
  if (typeof MutationObserver === 'function') {
    new MutationObserver(later).observe(document.body, {
      attributes: true,
      subtree: true,
      attributeFilter: ['open', 'class', 'aria-hidden', 'aria-modal'],
    });
  }

  // Announce a changed count once, politely (not on page load).
  let last = null;
  document.addEventListener('tackquote:counted', (e) => {
    const c = e.detail.count;
    const live = document.querySelector('[data-tackquote-live]');
    if (live && last !== null && c !== last) live.textContent = ns.format(live.dataset.tackquoteLive, { count: c });
    last = c;
    later();
  });

  // Header quote icon, before the theme's cart link and wearing its classes.
  function headerIcon() {
    const tpl = document.querySelector('template[data-tackquote-hicon]');
    if (!tpl || document.querySelector('.tackquote-hicon[data-placed]')) return;
    const cart = document.querySelector(
      'header a[href$="/cart"], header a[href*="/cart?"], #cart-icon-bubble, a.site-header__cart, [data-cart-drawer-toggle]',
    );
    if (!cart || !cart.parentNode) return;
    const icon = tpl.content.firstElementChild.cloneNode(true);
    // The icon's SVG is the floating button's, not a second copy in the Liquid.
    const art = document.querySelector('[data-tackquote-fab] svg');
    if (art) icon.prepend(art.cloneNode(true));
    for (const c of cart.className.split(/\s+/)) if (c && !/cart|bubble|drawer|active/i.test(c)) icon.classList.add(c);
    icon.dataset.placed = '';
    cart.parentNode.insertBefore(icon, cart);
    if (ns.theme) ns.theme.apply(icon);
    if (ns.quotePaint) ns.quotePaint();
  }

  const start = () => {
    headerIcon();
    later();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
  document.addEventListener('shopify:section:load', start);
});
