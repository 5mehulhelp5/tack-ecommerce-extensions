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
