# App configuration, scopes and install hook for the checkout Functions

`shopify.app.toml` lives in the main TackQuote repository, not here. This
document is the exact change that repository needs so that the two Functions
in this directory ship and run. Nothing here has been deployed.

Verification status:

- The TOML below passed `shopify app config validate --json` (Shopify CLI
  4.8.2). The run used a scratch copy of the live `shopify.app.toml`, with
  both function directories placed under `extensions/`, and returned
  `"valid": true`.
- Every GraphQL operation passed the shopify-dev MCP
  `validate_graphql_codeblocks` against Admin API **2026-07**.

## 1. Where the functions go

Use the same pattern as the theme app extension. The main repository's
`shopify.app.toml` explains why `extension_directories` does not work for a
path outside the app root, and why a symlink does. Add two symlinks next to
the existing one:

```text
extensions/tackquote-wholesale-pricing -> ../../tack-ecommerce-extensions/shopify/functions/tackquote-wholesale-pricing
extensions/tackquote-order-limits      -> ../../tack-ecommerce-extensions/shopify/functions/tackquote-order-limits
```

The main repository's guard `apps/api/src/shopify-app-config.spec.ts` should
also check that these resolve. On the first `shopify app deploy`, the CLI
writes a `uid` into each `shopify.extension.toml`, and that change must be
committed back here. The build command, `cargo build --target=wasm32-unknown-unknown --release`,
needs the Rust `wasm32-unknown-unknown` target on the machine that deploys.
The CLI then runs Shopify's trampoline over the wasm itself.

## 2. `[access_scopes]`

Current:

```toml
scopes = "read_customers,write_app_proxy,write_draft_orders,read_orders,write_orders,read_products"
```

Proposed:

```toml
scopes = "write_app_proxy,write_customers,write_discounts,write_draft_orders,read_orders,write_orders,write_products,write_validations"
```

"Any scope that writes a resource also grants read access to it"
(https://shopify.dev/docs/apps/build/authentication-authorization), so
`read_customers` and `read_products` are replaced, not kept alongside.

| Scope | Needed for | Source |
|---|---|---|
| `write_discounts` (new) | `discountAutomaticAppCreate` / `discountAutomaticAppUpdate`, which install the wholesale discount. "Requires `write_discounts` access scope." | https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/discountAutomaticAppCreate |
| `write_validations` (new) | `validationCreate` / `validationUpdate`, which install and enable the order-limits validation and write its `$app:cart_limits`. "Requires `write_validations` access scope." | https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/validationCreate |
| `write_products` (replaces `read_products`) | `metafieldsSet` on `ProductVariant` (`$app:price_tiers`, `$app:order_limits`). `metafieldsSet` "Requires the same access level needed to mutate the owner resource." | https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/metafieldsSet ; `write_products` covers `ProductVariant`: https://shopify.dev/docs/api/usage/access-scopes |
| `write_customers` (replaces `read_customers`) | `metafieldsSet` / `metafieldsDelete` on `Customer` (`$app:buyer`). Same owner-resource rule. | same two pages |

About the `$app` metafield writes themselves: no separate scope exists for the
app-reserved namespace. The owner resource's write scope is the requirement,
as Shopify's definitions guide states: "Your app has the appropriate access
scopes for the owner type ... For example, write_products for product
metafields, or write_customers for customer metafields"
(https://shopify.dev/docs/apps/build/metafields/definitions).

**`write_customers` reverses a deliberate earlier removal.** The main
repository's TOML comment explains that it was dropped because it was unused,
and that an unused write scope on protected customer data risks App Store
rejection. It is now genuinely used: `$app:buyer` must live on the Customer,
because that is the only per-buyer resource a Discount Function can read on
every plan (`cart.buyerIdentity.customer`). Update that comment. The App Store
listing's protected-customer-data justification must say that the scope
writes one app-owned metafield and no personal data.

The main repository's TOML also says to keep the scope list "in lockstep with
`ShopifyService.getOAuthUrl`". Change both places together.

### Re-authorization

Changing `scopes` affects every existing install. "Merchants are prompted to
approve the updated access scopes when they open your app. The
`app/scopes_update` webhook fires when the merchant approves the changes"
(https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes).
Until a merchant approves, the install hook in section 4 fails with an access
error for that shop. So:

- run the hook when `app/scopes_update` arrives (subscribe to it in
  `[webhooks]`), not only on first install;
- show "approve the new permissions to enable wholesale checkout pricing" in
  the TackQuote app until the granted scopes include all four.

`optional_scopes` would avoid prompting merchants who never use wholesale
checkout. It is the documented alternative (same page), and it means the app
requests the scopes itself when the feature is switched on.

## 3. `$app` metafield definitions

Add these to `shopify.app.toml`. The documented form is
`[<owner_type>.metafields.app.<key>]`
(https://shopify.dev/docs/apps/build/custom-data/declarative-custom-data-definitions).
The owner-type keys below are the ones the CLI accepted when run against
this file. `product_variant`, which looks natural, is **rejected** with
"Unsupported section(s) in app configuration: product_variant". The
variant owner key is `variant`.

```toml
[variant.metafields.app.price_tiers]
type = "json"
name = "TackQuote price tiers"
description = "Wholesale unit prices per buyer group, written by TackQuote. Read by the TackQuote wholesale pricing discount."
access.admin = "merchant_read"
access.storefront = "none"
access.customer_account = "none"

[variant.metafields.app.order_limits]
type = "json"
name = "TackQuote order limits"
description = "Minimum, maximum and case-pack quantities per buyer group, written by TackQuote. Read by the TackQuote order limits validation."
access.admin = "merchant_read"
access.storefront = "none"
access.customer_account = "none"

[customer.metafields.app.buyer]
type = "json"
name = "TackQuote buyer"
description = "Links this customer to a TackQuote buyer: groups, own prices and limits. Written by TackQuote."
access.admin = "merchant_read"
access.storefront = "none"
access.customer_account = "none"

[validation.metafields.app.cart_limits]
type = "json"
name = "TackQuote cart limits"
description = "Shop-wide order minimums and maximums for linked TackQuote buyers, written by TackQuote. Read by the TackQuote order limits validation."
access.admin = "merchant_read"
```

Why each access value was chosen:

- `merchant_read`: merchants can see the values but not edit them. An edit in
  the admin would bypass TackQuote and be overwritten by the next push.
- `storefront = "none"`: B2B price books are confidential, and the functions
  do not read through the Storefront API. The theme's price block uses the
  app proxy.

Functions read `$app` metafields through their input query regardless of
storefront access. That is the documented pattern
(https://shopify.dev/docs/apps/build/functions/input-output/metafields-for-input-queries).
It still needs a live-store check (UNVERIFIED).

The shape of each value is in `METAFIELD_CONTRACT.md`.

## 4. Install hook

Run the hook after install, after `app/scopes_update`, and whenever the
merchant turns "wholesale checkout pricing" on. It must be idempotent, so it
looks before it creates.

### 4.1 Find what already exists

```graphql
query TackQuoteInstalledFunctionObjects {
  discountNodes(first: 10, query: "type:app") {
    nodes {
      id
      discount {
        ... on DiscountAutomaticApp {
          title
          appDiscountType {
            functionId
            appKey
          }
        }
      }
    }
  }
  validations(first: 25) {
    nodes {
      id
      title
      enabled
      shopifyFunction {
        id
        apiType
        app {
          title
        }
      }
    }
  }
}
```

Required scopes (MCP-reported): `read_discounts`, `read_validations`. Both are
covered by the write scopes above. Store the `discountId` and the validation
`id` against the TackQuote Shopify connection. If either already exists,
update it with `discountAutomaticAppUpdate` / `validationUpdate` instead of
creating a second one.

### 4.2 Create the automatic app discount

```graphql
mutation TackQuoteWholesaleDiscountCreate($discount: DiscountAutomaticAppInput!) {
  discountAutomaticAppCreate(automaticAppDiscount: $discount) {
    automaticAppDiscount {
      discountId
      title
      status
      discountClasses
      combinesWith {
        orderDiscounts
        productDiscounts
        shippingDiscounts
      }
    }
    userErrors {
      field
      message
      code
    }
  }
}
```

```json
{
  "discount": {
    "title": "Wholesale price",
    "functionHandle": "tackquote-wholesale-pricing",
    "discountClasses": ["PRODUCT"],
    "startsAt": "<now, ISO 8601>",
    "combinesWith": {
      "orderDiscounts": false,
      "productDiscounts": false,
      "shippingDiscounts": false
    }
  }
}
```

How each field was chosen:

- `functionHandle` is the extension `handle`. `functionId` is deprecated
  (https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/DiscountAutomaticAppInput).
- `discountClasses: ["PRODUCT"]`. The function returns nothing unless the
  product class is present (`a_discount_without_the_product_class_does_nothing`).
- `combinesWith` is the documented default: every field `false`
  (https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/DiscountCombinesWithInput).
  It is passed explicitly so that the choice is visible. The consequence for
  merchants: the wholesale price does not stack with other product, order or
  shipping discounts, and Shopify applies whichever is better for the
  customer. A merchant who wants stacking can change it in the admin.
- `title` is what customers see. Candidates carry no `message`, to stay under
  the 20 kB output limit (see section 6), so the title is the label.
- `endsAt` and `context` are left out: the discount is open-ended and
  available to all buyers. The function itself limits it to linked TackQuote
  buyers.
- `appliesOnSubscription` defaults to `true`. Leave it unless TackQuote
  pricing must not reach subscriptions, which is a product decision.

MCP-reported scopes: `write_discounts`, `read_discounts`.

### 4.3 Create and activate the validation

```graphql
mutation TackQuoteOrderLimitsValidationCreate($validation: ValidationCreateInput!) {
  validationCreate(validation: $validation) {
    validation {
      id
      title
      enabled
      blockOnFailure
    }
    userErrors {
      field
      message
      code
    }
  }
}
```

```json
{
  "validation": {
    "functionHandle": "tackquote-order-limits",
    "title": "TackQuote order limits",
    "enable": true,
    "blockOnFailure": false,
    "metafields": [
      { "namespace": "$app", "key": "cart_limits", "type": "json", "value": "<encodeShopLimits(...)>" }
    ]
  }
}
```

How each field was chosen:

- `enable: true` is what activates the validation. The default is `false`.
- `blockOnFailure: false` is the documented default. "Validation errors always
  block checkout progress. The blockOnFailure field controls whether runtime
  exceptions, such as timeouts, also block checkout"
  (https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/validationCreate).
  A function crash therefore lets checkout continue rather than stranding
  every buyer. `true` is a merchant option to offer, not a default.
- Leave `metafields` out when the tenant has no shop-wide rules. Later edits
  go through `validationUpdate` (below) or through `metafieldsSet` with the
  validation `id` as `ownerId`.

```graphql
mutation TackQuoteValidationConfigUpdate($id: ID!, $validation: ValidationUpdateInput!) {
  validationUpdate(id: $id, validation: $validation) {
    validation {
      id
      enabled
    }
    userErrors {
      field
      message
      code
    }
  }
}
```

MCP-reported scopes: `write_validations`, `read_validations`.

### 4.4 Push the metafields

```graphql
mutation TackQuoteMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields {
      key
      namespace
      ownerType
      compareDigest
    }
    userErrors {
      field
      message
      code
    }
  }
}
```

Each call takes at most 25 metafields and is atomic
(https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/metafieldsSet).
Every `value` must come from the reference encoders. They refuse anything
over 10,000 bytes, and every refusal must be surfaced as truncated. Who writes
what, and when, is in `METAFIELD_CONTRACT.md` section 4.

### 4.5 Any userError is a failure

Treat any `userErrors` entry, or a `null` payload object, as a failure, and
name the failing step. Never report "installed" on an empty `userErrors`
alone. Re-read the discount or validation `id` and confirm `status` /
`enabled` (CLAUDE.md, defect shape 2).

## 5. Uninstall

- **Definitions**: "When a user uninstalls your app, Shopify deletes its
  app-owned metafield definitions and temporarily retains the metafields and
  their values without a definition"
  (https://shopify.dev/docs/apps/build/custom-data/declarative-custom-data-definitions).
  TOML definitions come back with new GIDs on reinstall, so never store a
  definition GID.
- **The app can do no cleanup.** The offline token is revoked at uninstall.
  The existing `app/uninstalled` handler should only mark the stored
  `discountId` and validation `id` as stale and stop the push pipeline for
  that shop.
- **The discount and validation objects**: the Shopify docs searched for this
  work do not say what happens to an uninstalled app's function-backed
  discount and validation, or whether its functions stop running.
  UNVERIFIED. Check it on a dev store: install, create both, uninstall, then
  look at Discounts and Settings > Checkout.
- **Reinstall**: run section 4 from 4.1, which is why the hook looks before it
  creates, then do a full metafield push. Retained values may be stale. The
  contract's `"v"` envelope keeps a stale value readable, but only a fresh
  push makes it correct.

## 6. Measured resource headroom

Limits for carts up to 200 lines: 11M instructions, 128 kB input, 20 kB
output, 256 kB module (https://shopify.dev/docs/api/functions/2026-07).

The measurements used `function-runner` 9.2.2 (bundled with CLI 4.8.2) on the
release wasm after Shopify's `shopify-function-trampoline` v2.0.1. The
trampoline is the same step `shopify app function build` applies, and the
binary's sha256 was checked against the release's `.sha256`.

| Case | Instructions | Input | Output |
|---|---|---|---|
| pricing, 1 line, 8.7 kB price book | 162,236 | 10 kB | 210 B |
| pricing, 200 lines, 3-audience ladders, buyer with 40 overrides | 8,531,634 | 67 kB | 2.1 kB |
| pricing, 200 lines, all different amounts, ~100-character line ids | **9,202,162** | 67.5 kB | **15.0 kB** |
| pricing, guest | 9,364 | | |
| limits, 200 lines, 25 errors | 6,730,924 | 53.7 kB | 2.6 kB |
| limits, 200 lines, every line failing | **7,018,371** | 56 kB | 2.8 kB |
| limits, 200 lines, all passing | 6,469,730 | 53.7 kB | 17 B |

| Module | Size before trampoline | Size after trampoline |
|---|---|---|
| `tackquote-wholesale-pricing.wasm` | 88,086 B | 85,513 B |
| `tackquote-order-limits.wasm` | 100,978 B | 98,704 B |

Instruction headroom at 200 lines is **16%** (pricing) and **36%** (limits).
Reading the cart lines alone costs about 4M instructions at 200 lines, so
that is the floor. The first version of these functions measured 25.9M and
23.0M. Three changes brought it down, and the reason for each is recorded in
the code:

- lazy metafield reads (`contract.rs` header);
- numeric map keys;
- a capped, lazily formatted error list.

Pricing output grows with cart-line id length, because each discounted line
is one target. The real length of production cart line ids is UNVERIFIED.
With ~100-character ids and 200 lines at all-different amounts, output was
15.0 kB of the 20 kB limit.

## 7. Wave 4: wholesale shipping and catalog visibility (contract v2)

Two more Functions ship from this directory, and the order-limits validation
gains catalog visibility. The main repository's `shopify.app.toml` change below
is committed on its `feat/wave4-checkout-extras` branch; it passed
`shopify app config validate --json` (CLI 4.8.2, `"valid": true`), and
`shopify app build` built all five extensions from a scratch copy.

### 7.1 Symlinks

```text
extensions/tackquote-wholesale-shipping          -> ../../tack-ecommerce-extensions/shopify/functions/tackquote-wholesale-shipping
extensions/tackquote-wholesale-shipping-discount -> ../../tack-ecommerce-extensions/shopify/functions/tackquote-wholesale-shipping-discount
```

Both `uid`s were written by `shopify app generate extension` (CLI 4.8.2) and
are committed in each `shopify.extension.toml`.

### 7.2 Scope: `write_delivery_customizations`, not `write_shipping`

`deliveryCustomizationCreate` / `deliveryCustomizationUpdate`, and
`metafieldsSet` on a `DeliveryCustomization` owner, need
`write_delivery_customizations` (MCP-reported for both mutations,
https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/deliveryCustomizationCreate).
`write_shipping` edits delivery profiles and carrier services; nothing here
does, so it is not requested. The shipping discount is covered by the existing
`write_discounts`; product and customer metafields by `write_products` and
`write_customers`.

```toml
scopes = "write_app_proxy,write_customers,write_delivery_customizations,write_discounts,write_draft_orders,read_orders,write_orders,write_products,write_validations"
```

Adding it re-prompts every existing install (section 2, "Re-authorization").
Checkout pricing does not need it and keeps working until the merchant
approves; the extras report `needs_scopes` until then.

### 7.2a Scope: `read_companies` (owner approved 2026-09-30)

Not used by any Function or block here. The TackQuote API reads Shopify B2B
companies when it creates a draft order, so an order for a buyer who is a
company contact is placed for that company location and carries its payment
terms (main repository: `shopify-draft-order-terms.ts`, and
`docs/integrations/SHOPIFY.md` section 7). The reads are
`Customer.companyContactProfiles`, `CompanyContact.roleAssignments` and
`CompanyLocation.buyerExperienceConfiguration.paymentTermsTemplate`, for which
`validate_graphql_codeblocks` (Admin 2026-07) reports "Required scopes:
read_customers, read_companies". Read-only; no company mutation is called.
https://shopify.dev/docs/api/usage/access-scopes

It is declared OPTIONAL (App Store requirement 3.2 recommends optional scopes
for what not every merchant needs; Shopify B2B is Plus-only), so no install is
re-prompted. The merchant allows it from the embedded app, which calls App
Bridge `shopify.scopes.request(['read_companies'])`; that only works for a
scope in `optional_scopes`
(https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes).
`shopify app config validate --json` (CLI 4.8.2) returned `"valid": true`.

```toml
scopes = "write_app_proxy,write_customers,write_delivery_customizations,write_discounts,write_draft_orders,read_orders,write_orders,write_products,write_validations"
optional_scopes = [ "read_companies" ]
```

Fields read: `Customer.companyContactProfiles { id company { id }
roleAssignments { companyLocation { id } } }` and `CompanyLocation { id
company { id } buyerExperienceConfiguration { paymentTermsTemplate { id name
dueInDays paymentTermsType } } }`. No contact names, emails or phones. Until
the merchant allows it, the API reads the granted scopes
(`currentAppInstallation.accessScopes`) and creates draft orders exactly as before.

### 7.3 Definitions

```toml
[product.metafields.app.visibility]
type = "json"
name = "TackQuote visibility"
description = "Which TackQuote buyer groups may buy this product. Written by TackQuote. Read by the TackQuote order limits validation and theme blocks."
access.admin = "merchant_read"
access.storefront = "public_read"
access.customer_account = "none"

[customer.metafields.app.groups]
type = "json"
name = "TackQuote buyer groups"
description = "This customer's TackQuote buyer-group codes, so the storefront can show wholesale-only products. Written by TackQuote."
access.admin = "merchant_read"
access.storefront = "public_read"
access.customer_account = "none"

[delivery_customization.metafields.app.shipping_rules]
type = "json"
name = "TackQuote shipping rules"
description = "Wholesale shipping rules per buyer group, written by TackQuote. Read by the TackQuote wholesale shipping customization."
access.admin = "merchant_read"

[discount.metafields.app.shipping_rules]
type = "json"
name = "TackQuote shipping rates"
description = "Wholesale shipping rates per buyer group, written by TackQuote. Read by the TackQuote wholesale shipping rate discount."
access.admin = "merchant_read"
```

`visibility` and `groups` are `public_read` so the theme blocks can read them
in Liquid (METAFIELD_CONTRACT.md §2.6, §2.8). They carry audience codes only.
`$app:buyer`, which carries prices, stays `storefront = "none"`.

### 7.4 Install

Run after the checkout-pricing hook, on the merchant toggle and nightly:

- `deliveryCustomizationCreate` with `functionHandle:
  "tackquote-wholesale-shipping"`, `enabled: true`;
- `discountAutomaticAppCreate` with `functionHandle:
  "tackquote-wholesale-shipping-discount"`, `discountClasses: ["SHIPPING"]`,
  `combinesWith: { productDiscounts: true, orderDiscounts: false,
  shippingDiscounts: false }`;
- then `metafieldsSet` of `$app:shipping_rules` on BOTH ids.

Both objects are found by function id before anything is created, and the
result is confirmed by re-reading (main repo `checkout-extras-install.ts`).

**Stacking with the wholesale price.** A discount applies alongside another
only when each allows the other's class. The shipping discount allows product
discounts; the wholesale pricing discount (section 4.2) is created with
`shippingDiscounts: false`, so until that is changed a buyer gets either the
wholesale product price or the wholesale shipping rate, whichever Shopify
finds better. Changing it is an owner decision (it also lets the wholesale
price stack with the merchant's own shipping codes). UNVERIFIED on a live
store.

### 7.5 Measured resource use

`function-runner` 9.2.2 on the release wasm built by `shopify app function
build` (CLI 4.8.2). Inputs are in `shopify-listing/wave4/bench/` (not in
this repository).

| Case | Instructions | Input | Output |
|---|---|---|---|
| limits, 200 lines, every product restricted and failing, buyer + shop limits | **9,163,320** | 80.2 kB | 4.3 kB |
| limits, 200 lines, guest, every product restricted | 5,913,541 | 80.1 kB | 4.9 kB |
| limits, 200 lines, no visibility | 7,188,464 | 71.0 kB | 3.3 kB |
| shipping customization, 35-rule document (8.7 kB), 5 groups x 25 options, 65-character handles | 3,900,583 | 29.4 kB | 14.1 kB (budgeted) |
| shipping discount, same document and cart | 4,513,886 | 29.5 kB | 10.5 kB (budgeted) |

| Module | Size |
|---|---|
| `tackquote-order-limits.wasm` | 107,352 B |
| `tackquote-wholesale-shipping.wasm` | 86,684 B |
| `tackquote-wholesale-shipping-discount.wasm` | 88,323 B |
| `tackquote-wholesale-pricing.wasm` | 81,270 B |

Validation headroom at 200 lines is now 17% (it was 36%): the product
visibility read costs about 2M instructions at 200 lines. Both shipping
Functions budget their output to 15,000 estimated bytes and log
`output_budget` when they stop, in an order that never drops the move that
keeps the cheapest option first.
