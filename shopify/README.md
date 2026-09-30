# TackQuote for Shopify — Theme App Extension

Eleven app blocks a merchant drags onto a page from the theme editor, three app embeds switched
on under *Theme settings, App embeds*, and one customer-account extension:

| Block | Where | What it does |
| --- | --- | --- |
| **Add to Quote** | product | Adds the selected variant and quantity to a running quote request, then opens the drawer. |
| **Request a Quote** | product | Opens the quote request form for this product alone. |
| **Wholesale Price** | product | Shows the signed-in customer's B2B price, resolved server-side by TackQuote, in the page currency. |
| **Quantity Breaks** | product | The quantity-break ladder for this product, in the page currency. |
| **Order Minimums** | product | The minimum and maximum order quantities, stated up front. |
| **Buyer Group Badge** | product, collection, home, cart, page | "Your pricing tier: Tier 2", when the shopper is in a TackQuote buyer group. |
| **Quick Order** | product, page | A signed-in buyer pastes SKUs and quantities, then adds them all to the cart or to a quote. |
| **Wholesale Application** | page, home | The merchant's application form: text, email, phone, number, choice, checkbox, long text, file upload, address and tax ID fields, with show-if conditions. |
| **Net Terms Application** | page | A form for buyers to apply for net payment terms. |
| **Quote cart button** | cart | "Request a quote for your cart" (reads the live cart) and "View quote (N)", after the cart. |
| **Quote page** | page | The saved quote, with quantity editing and the request form, inline on its own page. |
| **Price Gate** (app embed) | every page | Hides prices and add to cart from guests, or from customers without the wholesale tag, with a Log in to see prices link. Also hides add to cart and Buy it now on products carrying a quote-only tag. |
| **Floating quote cart** (app embed) | chosen page types | A floating Quote button with a live count that opens the quote; optional header quote icon. |
| **Quote on product cards** (app embed) | collection, search, home | Add to Quote under each product card; products with options open their page. |
| **Net terms** (customer account) | Profile page | A signed-in customer on new customer accounts applies for net terms and sees the status. Lives in `customer-account-net-terms/`. |

The first five are product-page furniture; the application form is not about a product at
all, which is why it is pinned to different templates. The badge is the only one that is a
statement about the *account* rather than the item, so it is equally at home in the cart.

This is the Shopify counterpart to the WooCommerce catalog-mode work — same intent,
Shopify's extension model instead of PHP hooks. Licensed MIT, like every extension in
this directory.

Theme-editor deep links (not yet listed in the web app's `shopify-theme-blocks.ts`, which still names nine blocks and one embed):
`…/admin/themes/current/editor?template=cart&addAppBlockId=<api_key>/quote-cart&target=newAppsSection`,
`…?template=page&addAppBlockId=<api_key>/quote-page&target=newAppsSection`, and
`…?context=apps&activateAppId=<api_key>/quote-fab` (or `/quote-cards`) for the embeds.

---

## Matching the merchant's theme

Every block, the drawer and the embeds wear the theme's own type, colours, corners and
buttons, in any Online Store 2.0 theme, with one CSS chain per property:

1. the merchant's explicit style setting (`--tqm-*`, written by `snippets/tackquote-style.liquid`;
   every setting defaults to *Match theme*, which writes nothing);
2. what `assets/tackquote-theme.js` detected from the theme's own rendered elements
   (`--tqd-*`, written on each TackQuote root, never `:root`): the section's background and
   text colour, a heading, the theme's primary button (add to cart first, preferring an opaque
   candidate, since Dawn's add to cart is an outline beside dynamic checkout) and an input;
3. the theme's tokens: Horizon's full colours (`--color-primary-button-background`, …) before
   Dawn's r,g,b triplets (`rgb(var(--color-button))`);
4. `inherit` / `currentColor`.

We never WRITE a theme token: Horizon holds full colours where Dawn holds triplets, and Dawn
derives `--buttons-radius-outset` from `--buttons-radius`. Sizes are `em`, never `rem`
(Dawn's `html{font-size:62.5%}` makes a rem 10px), and nothing defaults below the body size.
Detected button colours must pass WCAG AA (4.5:1, 3:1 for large text); otherwise the theme's
tokens are used, and if those fail too, the section's inverted foreground/background pair.
No font is ever loaded. `tests/theme-detect.test.mjs` pins the decisions against Dawn, Horizon,
a classic `.btn` theme and a dark section; `validate-theme-extension.mjs` pins the chain order.

Repeated theme-editor labels (the Style group, the app URL prefix, target price,
message and files) and the long help paragraphs are schema translations
(`locales/*.schema.json`, `t:tq.*`), because Shopify enforces 100 KB of Liquid across the
extension. All of it is translated in the eight languages.

**Buyer message and attachments** (settings "Let buyers add a message" / "Let buyers attach
files", off by default): `assets/tackquote-attach.js` uploads each file first to
`POST {proxy}/quote-upload?name=…` as raw bytes, keeps a guest's `uploadToken` for the next
uploads and the request, and sends `buyer.message`, `uploadIds` and `uploadToken` with
`quote-request`. A 400 saying an attachment expired triggers one re-upload and resend.

**Quote-only product tag (Price Gate) caveat:** it hides Add to cart and Buy it now on the
product PAGE only. An embed has no per-card product on a collection grid, so a theme's own
quick-add button on a card still shows for a tagged product; turn quick add off in the theme,
or use the Quote on product cards embed alongside it.

The drawer is a native `<dialog>` opened with `showModal()`: top layer, focus contained,
Escape closes, focus returns to the trigger. It is moved under `<body>` on first open so it
inherits the body type, and is painted from the OPENING block's section.

---

## Requirements

- **An Online Store 2.0 theme.** App blocks need JSON templates and sections that render
  blocks of type `@app`. On a vintage theme the blocks cannot be added at all.
- The TackQuote Shopify app installed on the store.
- For the four blocks that READ from TackQuote — Wholesale Price, Quantity Breaks, Buyer
  Group Badge and Wholesale Application — the app proxy, which ships in `shopify.app.toml`.
  The two button blocks write instead, and do not use it.

App blocks **cannot render on checkout pages** and have no access to
`content_for_header`, `content_for_layout`, or any parent-section property other than
`id`. That last one is why the runtime finds the product form by selector rather than
asking the theme.

---

## Install

The extension is source material. It is deployed as part of the TackQuote Shopify app:

```bash
cp -R shopify/theme-app-extension <shopify-app>/extensions/tackquote
cd <shopify-app>
shopify app deploy
```

Merchants then add the blocks in **Online Store → Themes → Customize → Product page →
Add block → Apps**.

---

## Configuration

Both button blocks take a **TackQuote Tenant ID** (from TackQuote → Settings) and an API
URL that defaults to `https://api.tackquote.com/v1`. Until the tenant id is set the block
renders nothing on the storefront — and a setup notice in the theme editor, which is the
only place a merchant can act on it.

The four reading blocks each take the **app proxy path**, default `/apps/tackquote`. It is a setting
rather than a constant because merchants can rename the proxy under *Settings → Apps and
sales channels → TackQuote → App proxy*; the value is immutable per store once installed,
and a change in app config only applies to new installations.

---

## How the price block knows who is asking

This is the part worth reading before changing anything.

The two button blocks **write**: they POST a quote request with a merchant-configured
tenant id and read nothing back. That is the same surface every other TackQuote storefront
plugin uses.

The price block **reads**, and a read cannot work that way. A tenant id sitting in the DOM
is caller-supplied, and a price lookup keyed on one would let anybody ask any tenant what
it charges — the failure `WidgetController` documents, where a lookup that matches nothing
"quietly agrees with whatever the storefront claimed".

So the price block calls the **merchant's own domain** at the app proxy path. Shopify
forwards it to TackQuote with `shop` and `logged_in_customer_id` appended and an
HMAC-SHA256 `signature` over the parameters keyed with the app secret. Both the tenant
selector and the customer identity are therefore asserted by Shopify. **No tenant id
travels from the page at all.**

### The trap: signed is not the same as vendor-asserted

The proxy signs *every* query parameter, including ones the block put there. So a Liquid
block that emitted `{{ customer.email }}` into the request would see it arrive with a
perfectly valid signature — and it would still be worthless, because Shopify signs what
the *browser* sent. A shopper could substitute someone else's address. Only
`logged_in_customer_id` is injected by Shopify from the storefront session.

### Four outcomes, and only one of them is a number

| Server says | Block shows |
| --- | --- |
| `anonymous` | "Log in to see your wholesale price", with a login link. |
| `unlinked` | The account is not linked to wholesale pricing yet. |
| `unpriced` | No wholesale price is configured for this item. |
| `priced` | The price — labelled as a list price unless it came from a price book keyed to this buyer. |

`unlinked` matters more than it looks. TackQuote's resolver falls back to the tenant's
catalogue list price when it has no buyer, which is a real number — and showing it under
"Your wholesale price" is a lie that looks like a feature. So a customer we cannot
identify gets told so, and never gets a price.

### What still has to happen for a real price to appear

The endpoint resolves the Shopify customer id to a TackQuote buyer through
`external_identities` under the `shopify_customer` platform. **Nothing populates that
namespace yet**, so today every signed-in shopper resolves to `unlinked`. Wiring a
customer sync that records those identities is the remaining piece; the endpoint,
verification and block are complete and fail closed until it lands.

---

## Price Gate: what it does and does not do

The embed decides in Liquid, from the global `customer` and `customer.tags` objects, whether
this shopper may see prices (embeds only get the global scope:
<https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration>). For a
gated shopper it emits a `<style>` that hides the theme's price and add-to-cart elements, and
`tackquote-price-gate.js` puts a *Log in to see prices* link where each price was.

- **It degrades safely.** Without JavaScript the prices stay hidden, just without the link.
  Switched off, or with the app uninstalled, Shopify removes the embed and nothing is left in
  the theme (<https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/ux>).
- **It is display gating, not a checkout rule.** Product JSON such as `/products/x.js` and the
  checkout itself are not blocked by it. Say so to a merchant who needs prices to be secret.
- **Theme coverage is by selector.** Common Online Store 2.0 price and buy-button classes are
  built in; a theme that prints prices elsewhere takes extra selectors in the embed settings.
  Braces, semicolons, `@` and `<` are refused so a setting cannot inject CSS.
- The theme editor never hides anything; it shows a notice saying the gate is on.

## Presentment currency

Every price read sends `cart.currency.iso_code`, the customer's local (presentment) currency
(<https://shopify.dev/docs/api/liquid/objects/cart>). When it differs from the currency TackQuote
prices in, the server answers `reason: "currency_mismatch"` and the blocks show *Your wholesale
price is applied at checkout* (or *available on a quote*) instead of a number. A priced answer in
a currency other than the page's is never rendered, whatever the server says.

## Quick Order

`GET {proxy}/quick-order?skus=A,B&currency=EUR` returns, per SKU, whether it exists on this
store, its Shopify variant id, the buyer's price and any order limits. Found lines go to the cart
in one `POST cart/add.js` with an `items` array (<https://shopify.dev/docs/api/ajax/reference/cart>),
or to the quote drawer through `ns.quoteAdd`. A line over its per-item limit disables both add
buttons; order-level limits are still enforced by the checkout validation. SKUs containing
spaces or commas cannot be pasted (one SKU per line, then the quantity).

## Wholesale Application: files and conditions

A file field uploads the raw bytes to `{proxy}/wholesale-upload` first, and the application then
carries only `{ uploadId }`. The server sniffs the type (PDF, JPEG, PNG only) and enforces the
size; the block's own checks just save a wasted upload. A field with `showIf` is shown only while
an earlier field holds the chosen value; a hidden field is disabled, never validated, and never
sent. The rules mirror the API's `wholesale-form-schema.ts`.

## Net terms on the customer's Profile page

`customer-account-net-terms/` is a customer-account UI extension for new customer accounts
(target `customer-account.profile.block.render`). It calls
`https://api.tackquote.com/v1/shopify-app/customer-account/net-terms` with a session token, whose
`sub` is the signed-in customer; it sends no customer id of its own. It needs `network_access`,
which Shopify must approve in the Partner Dashboard before the extension can be published
(<https://shopify.dev/docs/apps/build/customer-accounts/capabilities>). It runs alongside the Net
Terms Application page block, for stores still on a storefront account page.

## Server side

| Piece | Where |
| --- | --- |
| App proxy signature verification | `apps/api/src/modules/shopify-app/shopify-app-proxy.ts` |
| Price endpoint | `apps/api/src/modules/shopify-app/shopify-storefront-pricing.controller.ts` |
| Proxy + scope declaration | `shopify.app.toml` |
| Verified vendor contracts | `docs/vendor-contracts/shopify.md` |

---

## Quantity Breaks: which ladder it shows, and who sees it

TackQuote has **three** quantity-break stores and only two of them price anything. The
block renders the two that do — `price_book_entries` and `catalog_products.tier_prices` —
and deliberately not `volume_tiers`.

`volume_tiers` holds a `discountPct`, and a discount only means something beside the number
it is taken from. That table does not store that number, and for a logged-out visitor we do
not know it. Rendering it would also put a figure on the product page that the **Wholesale
Price block on the same page would contradict**, since that block prices through the other
two mechanisms. Two of our own blocks disagreeing about price on one page is worse than one
block being absent.

So every rung is produced by the same server-side price resolution the Wholesale Price
block uses, evaluated at that rung's quantity. The two can never disagree, because they are
the same computation.

Two consequences a merchant will notice:

- **Rungs that repeat the price above them are dropped.** Break quantities are unioned from
  both ladders, so a SKU can produce four candidates where only two prices exist. Showing
  "10+ $7.50" directly beneath "1+ $7.50" invites a shopper to buy ten of something to save
  nothing. A rung only appears where the price actually moves — and if nothing moves, the
  block hides.
- **Logged-out visitors see nothing by default.** Volume breaks are usually public
  marketing and the merchant will often want them shown, but publishing a wholesale ladder
  is their call and cannot be undone once a competitor has read it. A tenant admin turns it
  on with `PATCH /v1/tenants/me/settings` → `{"storefront":{"publicVolumeTiers":true}}`.
  There is no checkbox for it in the seller portal yet.

When it is on, the public ladder is the **catalogue** ladder and never a price book, even
the default one — an anonymous shopper is shown list prices, labelled as list prices.

---

## Buyer Group Badge

Reads the shopper's group from TackQuote and renders a chip. Four outcomes, and three of
them render **nothing at all**: signed out, signed in but not linked to a TackQuote buyer,
and linked but in no group. An empty chip beside a product reads as a broken feature rather
than an absent one.

The natural sentence is "You're on Tier 2 pricing", and Shopify's locale files do support
that placeholder — the localization guide shows single-brace interpolation filled in by the
`t` filter. The catch is *where the value comes from*: `t` interpolates in Liquid, on
Shopify's side, at render time, and the group name is not known until the proxy answers.
The template would have to reach the browser with `{group}` still in it, which means calling
`t` without passing `group` and trusting the filter to leave the token alone — behaviour
shopify.dev does not document, and whose two plausible outcomes differ by a shopper seeing a
literal `{group}` on a product page. So the badge is a label and a name in two elements
instead. No interpolation, and not hostage to English word order.

---

## Notes for whoever edits this next

- **`{% schema %}` JSON supports no comments and no trailing commas**, unlike theme
  settings files. This is the single most likely way a change here breaks, and the failure
  is a rejected extension rather than a visible error.
  `apps/api/src/modules/shopify-app/theme-extension-schema.spec.ts` guards it, along with
  block names, targets, asset references and locale keys.
- **Theme Check caps a storefront JavaScript asset at 10 KB.** The first draft was a single
  20 KB file and was rejected. That is why the drawer markup is rendered by Liquid — where
  the `t` filter translates it directly, instead of shipping a dictionary to the browser —
  and why the runtime is split per block.
- **Schema-declared JavaScript is injected `async`**, so nothing guarantees load order.
  The runtimes push their initialisers onto `window.TackQuoteQ` and
  `tackquote-shared.js` drains the queue, so either file may arrive first. An ordering bug
  here would work on a fast connection and silently fail on a slow one.
- **No price is ever sent with a quote request.** The API records a supplied per-line price
  as the buyer's *requested* price, so sending the storefront's retail figure would put a
  number in front of a sales rep as though the buyer had asked for it. It would also have
  to survive Shopify's cents-based money representation, which is not uniform across
  zero-decimal currencies. TackQuote prices every line server-side regardless.
- Verify anything about Shopify against **`shopify-dev-mcp`**, never Context7 — it returns
  confident false positives for Shopify-adjacent queries.

---

## Validating the blocks before you deploy

```bash
node --test shopify/validate-theme-extension.mjs
```

No dependencies — it uses Node's built-in test runner, because this repository
ships PHP and Liquid and has no JS toolchain.

It checks the real blocks, not just itself: schema JSON validity, required keys,
`target: "section"`, per-block template gating, that declared `stylesheet` /
`javascript` assets exist, unique setting ids, that every `| t` key resolves in
`en.default.json`, and that the config file stays minimal.

It also enforces **Shopify's size limits**, which are otherwise invisible until a
deploy is rejected or a storefront quietly gets slower:

| Limit | Value | Class |
| --- | --- | --- |
| App blocks per extension | 30 | **Enforced** — deploy rejected |
| All Liquid, added together | 100 KB | **Enforced** |
| JS per schema-referenced file, gzipped | 10 KB | Suggested |
| CSS, gzipped | 100 KB | Suggested |

Measured with gzip rather than Brotli: Shopify does not publish which encoder it
counts with, and gzip is the conservative reading, so a pass here passes either way.
`tackquote-shared.js` gets its own assertion because every block loads it through
`asset_url` — it is named by no schema's `javascript` key, so the schema-driven loop
would never look at it, and it is the one file whose weight is paid on every page
carrying any block.

**The check that earns its place is the comment rule.** Shopify's schema JSON
supports neither comments nor trailing commas — unlike ordinary theme files, where
both are legal and habitual. Neither produces a useful error: Shopify simply
declines to render the block, or the theme editor silently omits it. The validator
reports both **by name**, because `Unexpected token` from `JSON.parse` does not
tell you which habit bit you.

Doc: <https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration>

---

## Liquid design notes

Moved out of the Liquid on 2026-10-01: Shopify enforces 100 KB of Liquid across the whole
extension, and comments count toward it. Each Liquid comment points here by file and number.

### add-to-quote.liquid (1)

```text
Catalog visibility: a product restricted to TackQuote buyer groups offers
no price, break, limit or quote control to a shopper who may not buy it.
The rule, and why, is in snippets/tackquote-visibility.liquid.
```

### add-to-quote.liquid (2)

```text
The schema default is English. Left as it is (or blank), the
      shopper's language is used instead; a merchant's own wording is kept.
```

### buyer-group-badge.liquid (1)

```text
Hidden until the proxy answers with a group. A badge that renders empty and
then fills in is a layout shift on someone's product page; a badge that
renders empty and STAYS empty is a broken-looking chip. Neither is worth the
fraction of a second it would save.

No `data-tackquote-customer` here, unlike the price and tier blocks: nothing
on this block is cached, so there is no cache key to partition. Emitting the
id anyway would be an identity-shaped attribute with no purpose, which is
exactly the thing the other blocks have a comment apologising for.
```

### credit-application.liquid (1)

```text
Whether to draw the FORM or the sign-in prompt, and nothing more.

The API refuses this route outright without a signed
`logged_in_customer_id`, so a logged-out visitor must never be given a
form to fill in — they would complete seven fields and be told to sign in.
Liquid already knows, so the block decides here rather than spending one
of the caller's three attempts per fifteen minutes discovering it.

This is NOT identity. The identity is the customer id Shopify signs into
the proxy request; a shopper editing this attribute gets a form whose
submission the server then refuses.
```

### credit-application.liquid (2)

```text
The schema default is English. Left as it is (or blank), the
      shopper's language is used instead; a merchant's own wording is kept.
```

### order-limits.liquid (1)

```text
Catalog visibility: a product restricted to TackQuote buyer groups offers
no price, break, limit or quote control to a shopper who may not buy it.
The rule, and why, is in snippets/tackquote-visibility.liquid.
```

### order-limits.liquid (2)

```text
Kept OUTSIDE the tag's attribute list (see b5a4158: a Liquid tag between
attributes failed `shopify app deploy`'s theme check).

The product ID is sent alongside the SKU because an order-limit rule may
name either one. `data-tackquote-product-id`, deliberately distinct from
`data-tackquote-product`, which is the product TITLE that `ns.label`
reads — sending a title where the API expects an id would match no rule
and look exactly like "this product has no minimum".
```

### price-gate.liquid (1)

```text
Quote-only products: a product carrying the merchant's tag loses Add to
cart and Buy it now for EVERY shopper (quote is the only way to buy it),
whoever is signed in. Product pages only: an embed sees `product` there.
```

### quantity-breaks.liquid (1)

```text
Catalog visibility: a product restricted to TackQuote buyer groups offers
no price, break, limit or quote control to a shopper who may not buy it.
The rule, and why, is in snippets/tackquote-visibility.liquid.
```

### quantity-breaks.liquid (2)

```text
Kept OUTSIDE the tag's attribute list (see b5a4158: a Liquid tag between
attributes failed `shopify app deploy`'s theme check).

`data-tackquote-customer` is NOT identity: it only partitions the per-tab
cache. The identity that decides the ladder is `logged_in_customer_id`,
which Shopify injects into the proxy request and signs.
`data-tackquote-design` suspends the fail-quiet behaviour so a merchant in
the theme editor sees every state; a shopper sees only the useful ones.
```

### quote-cards.liquid (1)

```text
"Add to Quote" on product cards, an app EMBED: a collection grid has no app
block slot, so tackquote-cards.js finds the cards and adds the button after
each one. It loads only on the page types chosen here.

KNOWN LIMIT, stated to the merchant in the settings: an embed cannot read a
card's TackQuote catalog-visibility metafield, so a product restricted to
buyer groups still shows this button on a grid (its product page does not).
Checkout still refuses it for a buyer who may not purchase it.
```

### quote-cart.liquid (1)

```text
Cart-page quote button: Dawn main-cart-footer / Horizon main-cart @app slot,
or an Apps section. Cart drawers take no app block; quote-fab covers them.
The cart import reads the live cart (tackquote-quote-cart.js); no price.
```

### quote-fab.liquid (1)

```text
Floating quote cart, an app embed: every theme, beside cart drawers that take
no app block. Assets load only on the chosen page types. Placement logic:
tackquote-fab.js. Attributes are captured, never Liquid tags in a tag.
```

### quote-page.liquid (1)

```text
The Quote page: the buyer's saved quote, with quantity editing and the
request form, inline on a page of the merchant's choosing rather than in the
pop-up. The floating quote cart, the cart-page button and the header icon can
link here (their "Quote page" setting). Same runtime and endpoint as the
drawer (tackquote-quote.js, `quote-request`).
```

### request-a-quote.liquid (1)

```text
Catalog visibility: a product restricted to TackQuote buyer groups offers
no price, break, limit or quote control to a shopper who may not buy it.
The rule, and why, is in snippets/tackquote-visibility.liquid.
```

### request-a-quote.liquid (2)

```text
The schema default is English. Left as it is (or blank), the
      shopper's language is used instead; a merchant's own wording is kept.
```

### wholesale-price.liquid (1)

```text
Catalog visibility: a product restricted to TackQuote buyer groups offers
no price, break, limit or quote control to a shopper who may not buy it.
The rule, and why, is in snippets/tackquote-visibility.liquid.
```

### wholesale-price.liquid (2)

```text
Kept OUTSIDE the tag's attribute list: a Liquid tag between attributes
failed `shopify app deploy`'s theme check on another block (b5a4158).

Two attributes below are NOT identity and must never be read as such.
`data-tackquote-customer` only partitions the per-tab price cache, so that
logging out in the same tab cannot surface the price the previous session
was entitled to see. The identity that decides the price is
`logged_in_customer_id`, which Shopify injects into the proxy request and
signs; anything emitted here is just markup a shopper can edit.
`data-tackquote-design` suspends the fail-quiet behaviour: a merchant placing
the block in the theme editor needs to see every state, a shopper does not.
```

### wholesale-signup.liquid (1)

```text
Works with ZERO configuration. With the form setting blank (the default) the
server resolves the store's default wholesale form at request time: the form
the seller marked as default in TackQuote, else the oldest form that is
switched on. Every install creates a standard application form, so a
merchant can drop this block onto a page and it shows a real form.

The tenant is NOT carried in this markup, deliberately. Shopify signs `shop`
on every App Proxy request and the server resolves that signed value to a
tenant, so there is nothing tenant-shaped for a merchant to type or mistype.
https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
```

### wholesale-signup.liquid (2)

```text
Login-first: a signed-out shopper is asked to sign in (or create an account)
before applying, so the application carries Shopify's signed customer id and
approval can link the account without reading any customer data. The theme
editor still shows the form, so the merchant can see it.
```

### wholesale-signup.liquid (3)

```text
The schema default is English. Left as it is (or blank), the
      shopper's language is used instead; a merchant's own wording is kept.
```

### tackquote-diagnostics.liquid (1)

```text
Merchant-only diagnostics for the read blocks, as data attributes on the
block's root element. Emitted ONLY in the theme editor, so a shopper's page
never carries them. `ns.explain` in tackquote-shared.js picks one by the
failure it saw; the price, quantity-breaks and order-limits blocks share it.

In the theme editor Shopify wraps every rendered snippet in
<!-- BEGIN app snippet --> / <!-- END app snippet --> comments. Placed inside an
attribute list, the first "-->" closes the block's tag and every attribute after
it prints as page text. So each block captures this snippet and outputs it
through  split: '-->' | last | split: '<!--' | first , which leaves the bare
attributes and is a no-op on the storefront, where there are no markers.

@example
<div {% render 'tackquote-diagnostics' %}></div>
```

### tackquote-drawer.liquid (1)

```text
The quote request form: a modal <dialog> for the button blocks, the cart-page
button and the floating quote-cart button, or an inline section for the Quote
page block. Static, already-translated markup: Liquid's `t` filter translates
it, so no dictionary ships to the browser (Theme Check's 10 KB JS threshold).

It carries its own proxy, currency and signed-in customer, so any trigger on
the page can open it. tackquote-quote.js moves the dialog to <body> on first
open, so it inherits the theme's body type and colours wherever it was
rendered, and paints it from the theme's detected tokens (tackquote-theme.js).

Accessibility: a native modal dialog (focus contained, Escape closes, focus
returns to the trigger), labelled by its heading, every field labelled.

Attributes are captured first and output whole, so no Liquid tag sits inside
an HTML tag's attribute list (that failed deploy-time theme check, b5a4158).

@param {string} proxy - The app proxy path, already stripped of a trailing slash.
@param {boolean} [inline] - Render in the page instead of as a modal.
@param {string} [attrs] - Style attributes from tackquote-style, markers stripped.
@param {boolean} [target_price] - Offer an optional "Your target price" per line.
@param {string} [id] - An id for the dialog, for a trigger's aria-controls.

@example
{% render 'tackquote-drawer', proxy: proxy_path %}
```

### tackquote-selection.liquid (1)

```text
The variant lookup every block's JavaScript needs, as a JSON script tag.

Only the fields the quote payload actually uses are emitted. Price is
deliberately absent: the API records a supplied per-line price as the buyer's
REQUESTED price, so sending the storefront's retail figure would put a number in
front of a sales rep as though the buyer had asked for it. TackQuote prices every
line server-side regardless.

KNOWN LIMIT — products with more than 250 variants.

Shopify caps `product.variants` at 250 to stop themes over-fetching, while the
merchant-facing variant limit has been 2,048 since October 2025. So on a
high-variant product this list is TRUNCATED, and there is no loop bound to
raise: the cap is on the object, not on the `for`.
https://shopify.dev/docs/storefronts/themes/product-merchandising/variants/support-high-variant-products

It fails closed, which is why it is recorded here rather than worked around.
`ns.findVariant` returns null for a variant past the cap, so the SKU is empty
and the price and quantity-break blocks report "unpriced" / hide themselves
instead of pricing the wrong variant. Add to Quote still sends the line, with
the product title and no SKU.

The real fix is to stop shipping the variant table at all and resolve the
selected variant on demand — the Section Rendering API with `option_values`, or
a `?variant=` lookup — which is a larger change than this snippet. Do not
"solve" it by raising a limit; there isn't one.

@param {product} product - The product whose variants should be emitted.
@example
{% render 'tackquote-selection', product: product %}
```

### tackquote-style.liquid (1)

```text
The merchant's style overrides for one block or embed, as ATTRIBUTES for its
root tag: a `style` of --tqm-* custom properties, plus `data-tqm-bg` when a
background is set (so the root gets padding). Every setting defaults to
"Match theme", which emits nothing.

Only TackQuote's own --tqm-* properties are written, never a theme token
(--color-foreground, --color-button, --buttons-radius, --inputs-radius):
Horizon holds full colours where Dawn holds r,g,b triplets, and Dawn derives
--buttons-radius-outset from --buttons-radius, so writing either breaks one.

Rendered inside an attribute list, so every caller MUST strip the theme
editor's snippet markers, as snippets/tackquote-diagnostics.liquid explains:
output through  split: '-->' | last | split: '<!--' | first .

@param {object} s - The block's settings (block.settings).

@example
{%- capture tq_style -%}{% render 'tackquote-style', s: block.settings %}{%- endcapture -%}
{%- assign tq_attrs = tq_style | split: '-->' | last | split: '<!--' | first -%}
<div {{ tq_attrs }}></div>
```

### tackquote-visibility.liquid (1)

```text
Catalog visibility (TackQuote metafield contract v2) for the product blocks.

Outputs exactly one of:
  `hidden`        a shopper who may not buy this product: the calling block
                  renders nothing, so no price, quantity break, limit or quote
                  control is offered for it;
  the editor note in the theme editor, for a restricted product, so the
                  merchant sees why shoppers may not see the block;
  nothing         an unrestricted product, or one this shopper may buy.

It reads the product's `$app:visibility` and the customer's `$app:groups`
(the buyer-group codes of `$app:buyer` and nothing else: `$app:buyer` also
carries confidential prices, so it is never exposed to the storefront),
through the reserved-prefix syntax documented for theme app extensions
(https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration,
"Reserved prefixes for metafields and metaobjects"). The rule is the one the
checkout validation Function enforces (`is_entitled` in
shopify/functions/contract/contract.rs):
  1. deny first: a linked buyer in any `d` audience may not buy;
  2. then `a`: only a linked buyer in an `a` audience may; a guest never may;
  3. `*` means any linked TackQuote buyer, never a guest.
A value that is not a v2 document is not a restriction, exactly as the
Function treats it. The Function is what enforces this at checkout; this
snippet only stops the storefront from offering what checkout will refuse.

@param {product} product - The product the calling block is rendered for.

@example
{%- capture tackquote_access -%}{% render 'tackquote-visibility', product: product %}{%- endcapture -%}
```

