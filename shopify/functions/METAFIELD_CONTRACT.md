# TackQuote checkout metafield contract, version 2

This contract is how TackQuote passes wholesale prices, order limits, catalog
visibility and wholesale shipping rules to the four Shopify Functions in this
directory, and to the theme app extension's product blocks:

| Function | Target | Reads |
|---|---|---|
| `tackquote-wholesale-pricing` (Discount) | `cart.lines.discounts.generate.run` | customer `$app:buyer`, variant `$app:price_tiers` |
| `tackquote-order-limits` (Cart and Checkout Validation) | `cart.validations.generate.run` | validation `$app:cart_limits`, customer `$app:buyer`, variant `$app:order_limits`, product `$app:visibility` |
| `tackquote-wholesale-shipping` (Delivery Customization) | `cart.delivery-options.transform.run` | delivery customization `$app:shipping_rules`, customer `$app:buyer` |
| `tackquote-wholesale-shipping-discount` (Discount, delivery class) | `cart.delivery-options.discounts.generate.run` | discount `$app:shipping_rules`, customer `$app:buyer` |
| theme app extension, product blocks (`snippets/tackquote-visibility.liquid`) | storefront Liquid | product `$app:visibility`, customer `$app:groups` |

## 0. What version 2 changed, and what it did not

Version 2 is **additive**. It adds three metafields (sections 2.6 to 2.8) and
changes nothing version 1 defined:

- Every version 1 metafield keeps its `"v": 1` envelope, its keys and its
  rules byte for byte. A function or writer built against version 1 keeps
  working unchanged; it never queries the new keys.
- The new metafields carry `"v": 2`. Each metafield is valid at exactly one
  envelope version: a v1 reader given a `"v": 2` value, or a v2 reader given a
  `"v": 1` value, treats it as malformed (`*_version`). Both directions are
  pinned by `contract-v2.test.mjs` and the crates' tests.
- `contract.rs` keeps `CONTRACT_VERSION = 1.0` for the v1 metafields and adds
  `CONTRACT_V2 = 2.0` for the new ones.

The functions have no network access. A public app's function cannot call
TackQuote at checkout, so every value a function needs is pushed into Shopify
ahead of time. The executable versions of this document are:

- `contract/contract.rs`: the reader. It is copied byte for byte into all four
  crates (`scripts/sync-contract.mjs`; `contract-copies.test.mjs` fails on drift).
- `contract/reference-writer/contract.js` and `encode.js`: the writer, which
  validates whole documents. The TackQuote API's push pipeline must behave
  exactly like it.

- `contract/conformance/shipping-rules.json`: the shared corpus for shipping
  rule resolution. The JS reference (`conformance.test.mjs`), the Rust reader
  (`tackquote-wholesale-shipping` tests) and TackQuote's own
  `evaluateShippingRules` (main repo) are each run against it.

If this document and those files disagree, the code is right and this
document needs fixing.

## 1. Rules that apply to every metafield

- **Namespace** is `$app`, the app-reserved namespace. Only TackQuote can write it
  (https://shopify.dev/docs/apps/build/custom-data/ownership). It is expanded to
  `app--<app id>` in the Admin API. The functions query it literally as
  `metafield(namespace: "$app", key: ...)`.
- **Type** is `json`. The functions read `jsonValue`.
- **Envelope**: every value is a JSON object with a `"v"` version: `"v": 1`
  for the version 1 metafields (2.1 to 2.4), `"v": 2` for the ones contract
  version 2 added (2.6 to 2.8). A value without it, with a different version, or
  that is not an object at all is treated as **malformed**.
- **Absent vs malformed.** If a value is absent, the function behaves as if
  TackQuote has no rule. If a value is present but breaks this contract, it is
  **omitted and logged**, never defaulted. A malformed price book never becomes a
  price, and it never falls through to a different book. A malformed limit is
  not enforced, and it never falls back to a default.
- **Unknown keys are malformed.** A future field needs a new envelope version
  for that metafield, or a new metafield (section 5).
- **Money** is a JSON number, `>= 0`, with **at most four decimal places**. This
  matches TackQuote's `DECIMAL(14,4)`. The functions use integer 1/10,000ths
  internally, so subtracting a tier price from retail adds no float error. A
  price sent as a string (`"8.00"`) is malformed.
- **Money is in the SHOP currency**, and each document says which currency that
  is (`c`, ISO 4217, upper case). Function input money is in the buyer's
  presentment currency, so the function multiplies by `presentmentCurrencyRate`
  (https://shopify.dev/docs/apps/build/functions/localization-practices-shopify-functions).
  The `c` field lets the function catch a writer that used the wrong currency:
  - if the rate is 1, the presentment currency must equal `c`;
  - if the rate is not 1, the presentment currency must differ from `c`.

  If either check fails, that line or rule is omitted with `currency_mismatch`.
- **Quantities** are integers from 1 to 1,000,000,000.
- **Audience keys** are TackQuote buyer-group codes (see section 4), or `"*"`.
  `"*"` means **any linked TackQuote buyer**. It never means a guest, and it
  never means a signed-in Shopify customer who has no `$app:buyer` metafield.
- **Variant keys** (in `$app:buyer`) are the numeric tail of the variant GID:
  `"gid://shopify/ProductVariant/4412" -> "4412"`.
- **Logging.** Each run writes at most one line, capped at 900 bytes. Shopify
  truncates function logs at 1 kB
  (https://shopify.dev/docs/apps/build/functions/test-debug-functions). The
  line holds only reason codes and numeric variant ids, never customer data.
  Example: `tackquote-wholesale-pricing omitted: tiers_tier_list=4412;`.

### What the reader checks and what the writer checks

The functions read the lazy input directly and look up **only the keys this
cart needs**: the buyer's groups, then `"*"`, and then this variant in `p` and
`q`. Building a full JSON tree cost about 50,000 instructions per cart line.
That pushed a 200-line cart to 14.9M instructions, over the 11M limit
(https://shopify.dev/docs/api/functions/2026-07, "Resource limits").

As a result:

- The **reader** fully checks the envelope, the top-level keys, `c`, `g`, `d`
  and `l`, plus every ladder or limit entry it looks up. It never sees a
  broken entry under an audience the buyer is not in.
- The **writer** (`encode.js`) checks the whole document before writing it.
  It runs its own output back through the full parser in
  `reference-writer/contract.js`. So nothing is written that a later cart
  could look up and find malformed.

## 2. The metafields

### 2.1 `ProductVariant` `$app:price_tiers`

Wholesale unit prices for one variant, per audience. In the shop currency.

```json
{ "v": 1, "c": "USD", "t": { "gold": [[1, 9], [10, 8], [50, 7]], "*": [[1, 9.5]] } }
```

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "tackquote:price_tiers:v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["v", "c", "t"],
  "properties": {
    "v": { "const": 1 },
    "c": { "type": "string", "pattern": "^[A-Z]{3}$" },
    "t": {
      "type": "object",
      "minProperties": 1,
      "propertyNames": { "minLength": 1, "maxLength": 100 },
      "additionalProperties": { "$ref": "#/$defs/ladder" }
    }
  },
  "$defs": {
    "ladder": {
      "description": "[[minQty, unitPrice], ...], minQty strictly ascending",
      "type": "array", "minItems": 1, "maxItems": 50,
      "items": {
        "type": "array", "minItems": 2, "maxItems": 2,
        "prefixItems": [
          { "type": "integer", "minimum": 1, "maximum": 1000000000 },
          { "type": "number", "minimum": 0, "multipleOf": 0.0001 }
        ]
      }
    }
  }
}
```

Two rules JSON Schema cannot express: `minQty` must be strictly ascending
within a ladder, and `maxLength` counts characters while the size budget
counts UTF-8 bytes.

**How the price is chosen.** The tier is chosen on the variant's total
quantity **across all cart lines**, because one variant can sit on two lines
with different line attributes. The first rule that matches wins:

1. The buyer's own override for this variant: `$app:buyer` `p["<variant id>"]`.
2. Each of the buyer's groups, in the order of `$app:buyer` `g`.
3. `"*"`.

Inside a ladder, the highest break whose `minQty <= quantity` applies. A
ladder with no qualifying break falls through to the next level. A malformed
ladder stops the lookup and logs `buyer_tier_list` or `tiers_tier_list`.

**What the function outputs.** One `productDiscountsAdd` operation with
`selectionStrategy: ALL`. It contains one candidate per distinct per-unit
amount, and each candidate targets every line that gets that amount. The
value is
`fixedAmount { amount = retail - tier x presentmentCurrencyRate, appliesToEachItem: true }`.
Lines where that amount is `<= 0` are skipped: a discount can only lower a
price. Candidates carry no `message`. The automatic discount's title labels
the discount at checkout.

### 2.2 `ProductVariant` `$app:order_limits`

Per-variant quantity rules, per audience.

```json
{ "v": 1, "l": { "gold": { "min": 12, "max": 480, "step": 12 }, "*": { "min": 6, "step": 6 } } }
```

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "tackquote:order_limits:v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["v", "l"],
  "properties": {
    "v": { "const": 1 },
    "l": {
      "type": "object",
      "minProperties": 1,
      "propertyNames": { "minLength": 1, "maxLength": 100 },
      "additionalProperties": { "$ref": "#/$defs/limit" }
    }
  },
  "$defs": {
    "qty": { "type": "integer", "minimum": 1, "maximum": 1000000000 },
    "limit": {
      "type": "object", "additionalProperties": false, "minProperties": 1,
      "properties": { "min": { "$ref": "#/$defs/qty" }, "max": { "$ref": "#/$defs/qty" }, "step": { "$ref": "#/$defs/qty" } }
    }
  }
}
```

`step` means **the quantity must be a multiple of `step`**. This is the same
rule as TackQuote's `packSize` (`qty % packSize === 0` in
`CatalogService.assertQuantityRules`). The writer should also make `min` a
multiple of `step`, or no quantity can satisfy both.

Two dimensions are checked, and **both** are enforced, the way TackQuote's
order-limit service applies every rule that matches:

- **Product:** the first of the buyer's groups that has an entry, then `"*"`,
  then the shop-wide default `d` from `$app:cart_limits`.
- **Customer:** `$app:buyer` `q["<variant id>"]`, otherwise `$app:buyer` `d`.

If a malformed entry is found, that dimension is dropped for that variant and
the entry is logged (`limits_limit_entry` or `buyer_limit_entry`).

### 2.3 `Customer` `$app:buyer`

This metafield is what makes a Shopify customer a **linked TackQuote buyer**.
If it is absent, the customer gets retail prices and no limits.

```json
{ "v": 1, "g": ["gold", "net30"], "c": "USD",
  "p": { "4412": [[1, 7.25], [24, 6.9]] },
  "q": { "4412": { "max": 240 } },
  "d": { "max": 1000 },
  "l": { "minTotal": 500, "minUnique": 2 } }
```

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "tackquote:buyer:v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["v", "g"],
  "properties": {
    "v": { "const": 1 },
    "g": {
      "description": "buyer-group codes in PRECEDENCE order; not '*'; no duplicates",
      "type": "array", "maxItems": 50, "uniqueItems": true,
      "items": { "type": "string", "minLength": 1, "maxLength": 100, "not": { "const": "*" } }
    },
    "c": { "type": "string", "pattern": "^[A-Z]{3}$" },
    "p": { "type": "object", "propertyNames": { "pattern": "^[0-9]+$" },
           "additionalProperties": { "$ref": "tackquote:price_tiers:v1#/$defs/ladder" } },
    "q": { "type": "object", "propertyNames": { "pattern": "^[0-9]+$" },
           "additionalProperties": { "$ref": "tackquote:order_limits:v1#/$defs/limit" } },
    "d": { "$ref": "tackquote:order_limits:v1#/$defs/limit" },
    "l": { "$ref": "#/$defs/cartLimits" }
  },
  "dependentRequired": { "p": ["c"] },
  "$defs": {
    "money": { "type": "number", "minimum": 0, "multipleOf": 0.0001 },
    "count": { "type": "integer", "minimum": 1, "maximum": 1000000000 },
    "cartLimits": {
      "type": "object", "additionalProperties": false, "minProperties": 1,
      "properties": {
        "minTotal": { "$ref": "#/$defs/money" }, "maxTotal": { "$ref": "#/$defs/money" },
        "minQty": { "$ref": "#/$defs/count" }, "maxQty": { "$ref": "#/$defs/count" },
        "minUnique": { "$ref": "#/$defs/count" }, "maxUnique": { "$ref": "#/$defs/count" }
      }
    }
  }
}
```

`c` is also required when `l` contains `minTotal` or `maxTotal`, because
money without a currency cannot be converted. The reader checks this rule;
JSON Schema cannot express it.

### 2.4 `Validation` `$app:cart_limits`

Shop-wide rules for every linked buyer. This metafield is stored on the
validation object that `validationCreate` returns, not on the shop.

```json
{ "v": 1, "c": "USD", "l": { "minTotal": 250, "maxUnique": 400 }, "d": { "step": 1 } }
```

This uses the same schema as `$app:buyer`, but only `v`, `c`, `l` and `d` are
allowed. `d` is the per-variant default in the product dimension. It applies
only when the variant has no group entry and no `"*"` entry.

Cart rules come from this metafield **and** from `$app:buyer` `l`, and both
are enforced. `minTotal` and `maxTotal` are compared with
`cart.cost.subtotalAmount`, after converting with `presentmentCurrencyRate`.
`minQty` and `maxQty` count the total quantity of product-variant lines.
`minUnique` and `maxUnique` count distinct variants.

### 2.5 When the validation runs each rule

| `buyerJourney.step` | Rules enforced |
|---|---|
| `CART_INTERACTION` | maximums only |
| `CHECKOUT_INTERACTION`, `CHECKOUT_COMPLETION` | everything |
| absent | everything (fail closed) |

Catalog visibility (2.6) is enforced at every step, `CART_INTERACTION`
included: unlike a minimum, adding more cannot fix it, so refusing the add is
right. It is also the one rule that applies to guests and unlinked customers.

At cart interaction, a validation error makes the cart mutation itself fail.
`cartLinesAdd` returns `cart: null` with `VALIDATION_CUSTOM`
(https://shopify.dev/docs/apps/build/checkout/cart-checkout-validation/create-admin-ui-validation).
A minimum enforced at that step would stop a buyer from ever building a cart
up to the minimum. Every error targets `$.cart`, which is the only cart-level
target in the documented list
(https://shopify.dev/docs/api/functions/2026-07/cart-and-checkout-validation).
Each run lists at most 25 messages. The last one counts the problems that were
not listed, so checkout stays blocked and nothing is hidden. The cap keeps the
output under the 20 kB limit.

### 2.6 `Product` `$app:visibility` (v2)

Catalog visibility: which linked buyers may buy a product. Absent means
unrestricted.

```json
{ "v": 2, "a": ["gold", "platinum"] }
{ "v": 2, "d": ["*"] }
{ "v": 2, "a": ["*"], "d": ["retail-only"] }
```

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "tackquote:visibility:v2",
  "type": "object",
  "additionalProperties": false,
  "required": ["v"],
  "anyOf": [{ "required": ["a"] }, { "required": ["d"] }],
  "properties": {
    "v": { "const": 2 },
    "a": { "$ref": "#/$defs/audiences" },
    "d": { "$ref": "#/$defs/audiences" }
  },
  "$defs": {
    "audiences": {
      "description": "audience keys; '*' allowed; sorted by the writer",
      "type": "array", "minItems": 1, "maxItems": 50, "uniqueItems": true,
      "items": { "type": "string", "minLength": 1, "maxLength": 100 }
    }
  }
}
```

**Who may buy** (`is_entitled` in `contract.rs`, `isEntitled` in `contract.js`,
and the same rule in the theme snippet `tackquote-visibility.liquid`):

1. **Deny first.** A linked buyer with any audience (their `g` groups, or `"*"`)
   in `d` may not buy it.
2. **Then allow.** If `a` is present, only a linked buyer with an audience in
   `a` may buy it. A guest, a signed-in customer without `$app:buyer`, and a
   customer whose `$app:buyer` is malformed never pass an allow-list.
3. Only `d`, and not denied: anyone may buy it, a retail shopper included.

**What enforces it.** The validation Function blocks checkout (at every
`buyerJourney` step, `CART_INTERACTION` included: adding more cannot fix it)
with one message per product, naming it, in the checkout language. The theme
blocks that offer a price or a quote control render nothing for a shopper who
may not buy the product, and show a note in the theme editor. A malformed value
is omitted and logged (`visibility_<reason>`), never enforced.

`$app:visibility` is declared `access.storefront = "public_read"` so the theme
can read it (it holds audience codes, never a price); the blocks read the
buyer's side from `$app:groups` (2.8). That Liquid reads an app-reserved
metafield through `product.metafields['$app']` is the documented
reserved-prefix syntax
(https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration);
that it needs `public_read` to do so is the reading of "The access.storefront
setting controls customer visibility"
(https://shopify.dev/docs/apps/build/metafields/definitions). A live-store
check is still UNVERIFIED. If Liquid cannot read either value, the snippet
fails closed for allow-listed products (the blocks hide for everyone) and
checkout still enforces the rule.

**How TackQuote derives it** (main repo, `checkout-extras` push). From
`catalog_products.visibility`, exactly the buyer-portal model in
`CatalogService.visibleProductIds`:

| TackQuote | Written |
|---|---|
| `all` | nothing (the metafield is deleted) |
| `b2b_only` | `a`: the audiences of every enabled `b2b_catalogs` row listing it: scope `all`/`b2b_only` is `"*"`, scope `group` is the group's code |
| `b2c_only`, `hidden` | `d: ["*"]`: no linked buyer may buy it; retail is unaffected |

A catalog with a linked Shopify collection (`b2b_catalogs.shopify_collection_id`)
restricts every product in that collection the same way. A `company`-scoped
catalog cannot be expressed (no company key reaches a Function) and is refused
as truncated, never written as "no restriction".

### 2.7 `DeliveryCustomization` and `DiscountAutomaticApp` `$app:shipping_rules` (v2)

Wholesale shipping. The same document is written to both owners: the Delivery
Customization renames, sorts and hides; the delivery-class discount prices.

```json
{ "v": 2, "c": "USD", "r": [
  { "a": ["gold"], "k": ["US", "CA"], "t": "flat", "f": 12, "fa": 500,
    "m": ["ground"], "n": "Wholesale ground", "h": ["express"], "s": "price" },
  { "a": ["*"], "t": "free", "fa": 1000 }
] }
```

| Key | Meaning |
|---|---|
| `a` | audiences the rule applies to, 1 to 50, `"*"` allowed (required) |
| `k` | destination countries, upper-case ISO 3166-1 alpha-2, 1 to 250. Absent: any destination |
| `t` | `none`, `free`, `flat`, `pct` or `tier` (required) |
| `f` | `flat` only (required there): the rate, money |
| `fa` | free above: a subtotal at or over it ships free. Not allowed with `none` |
| `p` | `pct` only (required there): 0 to 100 percent of the subtotal, 4 decimals |
| `tr` | `tier` only (required there): 1 to 50 `[min, max or null, amount]`, inclusive both ends, `max >= min` |
| `m` | option titles the rule targets (case-insensitive "contains"), 1 to 20 of 1 to 100 characters. Absent: the default option, the cheapest |
| `n` | new title for the targeted options (1 to 100 characters). Shopify always prepends the carrier name and the API cannot remove it, so "Wholesale ground" shows as e.g. "UPS Wholesale ground" (Delivery Customization "Limitations", https://shopify.dev/docs/apps/build/checkout/delivery-shipping/delivery-options/build-function) |
| `h` | hide options whose titles match, 1 to 20 |
| `s` | `"price"`: sort the options by price, ascending |

Each `t` takes exactly its own amount key; any other combination, and any
unknown key, is malformed. `r` is 1 to 50 rules in TackQuote priority order
(`priority DESC, name ASC`); the writer never sorts it.

**Resolution** (`resolve_shipping` in `contract.rs`, `resolveShipping` in
`contract.js`) is TackQuote's `evaluateShippingRules`
(`apps/api/src/modules/shipping-rules/shipping-rule-evaluation.ts`), rule for
rule, per delivery group:

- a rule applies to a linked buyer with an audience in `a`, and, when it has
  `k`, only to a known destination in the list;
- `none` never prices (TackQuote skips it too); `fa` met is free whatever the
  type; `free` with an unmet `fa` does not apply; `pct` is that share of the
  subtotal, rounded to 4 decimals; `tier` is the first tier holding the
  subtotal and no tier means the rule does not apply; else `flat`;
- the **rate** is the first rule that prices; the **presentation** is the first
  rule that applies (`none` always does) and has `n`, `h` or `s`.

Money is in the shop currency (`c`) and converted with
`presentmentCurrencyRate`, with the same mismatch check as section 1; a
mismatch applies nothing (`currency_mismatch`). The subtotal is
`cart.cost.subtotalAmount`.

**The cheapest option stays the default.** Shopify App Store requirement
1.1.10: "Shipping must default to the lowest-priced option"
(https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices), and
the Delivery Customization schema: "The cheapest shipping delivery option must
always be the first option selected"
(https://shopify.dev/docs/api/functions/2026-07/delivery-customization). So:

- the Delivery Customization never hides the cheapest SHIPPING option
  (`hide_cheapest_kept`), and whenever it reorders a group the first move puts
  the cheapest option first;
- the discount only ever lowers a price, and never lowers a non-default option
  below the default option's final price.

Only `SHIPPING` options are considered; pickup and local delivery are never
touched. A group that mixes methods is renamed and hidden but not reordered.
A Delivery Customization cannot set a price at all (same page), which is why
the rate is a discount.

### 2.8 `Customer` `$app:groups` (v2)

The buyer's audience codes, and nothing else: the buyer's `tier` and the
`code` of every buyer group the buyer or the buyer's company belongs to, each
lower-cased (the same derivation as `CatalogService.resolveGroupCodes`, and
the same codes `$app:buyer` `g` carries, without its price-book keys). The
order carries no meaning: the only question asked of it is "is this code in
the list". It exists for one reason: the theme's product blocks
must apply catalog visibility, and `$app:buyer` is never exposed to the
storefront because it carries the buyer's own prices. `$app:groups` is
declared `access.storefront = "public_read"`; Liquid's `customer` object is
only ever the signed-in customer, so a buyer can read their own group codes
and nobody else's. No Function reads it: they read `$app:buyer`.

```json
{ "v": 2, "g": ["gold", "net30", "tier-a"] }
```

Same shape rules as `$app:buyer` `g` (no `"*"`, no duplicates, at most 50,
each 1 to 100 characters), plus `"v": 2` and no other key. The writer sorts
it, so an unchanged membership writes the same bytes. It is written, and deleted on
unlink, together with `$app:buyer`.

## 3. Size budget

Shopify delivers any metafield value **over 10,000 bytes** to a function as
null (https://shopify.dev/docs/apps/build/metafields/metafield-limits). The
function cannot tell null from absent, so an oversize price book would
silently become retail. For that reason:

- **The writer refuses** any value over 10,000 UTF-8 bytes. It throws
  `ContractSizeError`, and the caller reports it as truncated. It never trims
  tiers to fit (`encode.test.mjs`).
- The reader's own caps (50 tiers, 50 groups) do **not** keep a value under
  the limit. 50 audiences of 50 breaks each still parses but is far over it.
  This is pinned by `the_parser_caps_alone_do_not_keep_a_value_under_the_limit`.

| Metafield | Documented budget | Measured |
|---|---|---|
| `price_tiers` | 20 audiences (12-character codes) x 20 breaks, 7-digit quantities, prices up to 99,999.9999 | **8,752 bytes**, parses and prices (`the_documented_worst_case_fits_under_10000_bytes_and_still_prices`) |
| `price_tiers`, typical | 11 audiences x 5 breaks | < 1,000 bytes (`encode.test.mjs`) |
| `order_limits` | 20 audiences with `min`, `max` and `step` | 1,202 bytes |
| `buyer` | about 270 per-variant price overrides of 2 breaks each (~36 bytes per override) | 1,000 overrides are refused (`encode.test.mjs`) |
| `cart_limits` | fixed shape | < 200 bytes |
| `visibility` (v2) | 50 audiences of 100 characters | < 6,000 bytes (`contract-v2.test.mjs`) |
| `groups` (v2) | 50 codes of 100 characters | < 6,000 bytes |
| `shipping_rules` (v2) | 35 rules, each with 20 countries, 3 tiers, rename, hide and sort (~250 bytes per rule) | **8,703 bytes**; 50 such rules are refused (`contract-v2.test.mjs`) |

A buyer who needs more per-variant overrides than fit needs a buyer group
instead. Put the price in the variant's `price_tiers` under a group code only
that buyer belongs to. This is a writer decision, and the contract does not
change.

Function input is capped at 128 kB and output at 20 kB for carts up to 200
lines (https://shopify.dev/docs/api/functions/2026-07). The measured headroom
is in `APP_TOML_AND_SCOPES.md` section 6.

## 4. Who writes each metafield, and when

Every value is written by the **TackQuote API** (main repo, not in this
repository), using `metafieldsSet`. Each call sets up to 25 metafields and is
atomic
(https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/metafieldsSet).
Pass `compareDigest` so that two concurrent pushes cannot interleave.

| Metafield | Owner id | Written when |
|---|---|---|
| `$app:price_tiers` | `ProductVariant` GID of the mapped variant | a price book, tier, group price or product mapping changes; after a `products/update` webhook; nightly reconcile |
| `$app:order_limits` | `ProductVariant` GID | a pack size, MOQ/max or group setting changes; nightly reconcile |
| `$app:buyer` | `Customer` GID linked to the TackQuote buyer | a buyer is linked, their groups, company or tier change, their overrides change; on unlink, **delete** the metafield (`metafieldsDelete`) |
| `$app:cart_limits` | `Validation` GID from `validationCreate` | an order-limit rule with scope `all` changes; right after install |
| `$app:visibility` (v2) | `Product` GID of a mapped product | a catalog product's visibility, a `b2b_catalogs` row, its products or its linked collection changes; nightly reconcile. **Delete** it when the product becomes unrestricted |
| `$app:groups` (v2) | `Customer` GID linked to the TackQuote buyer | whenever `$app:buyer` is; on unlink, **delete** it |
| `$app:shipping_rules` (v2) | the `DeliveryCustomization` GID and the shipping `DiscountAutomaticApp` GID | a shipping rule changes; right after install; nightly reconcile |

If a write fails, or is refused for size, it must be surfaced as truncated in
TackQuote, never swallowed. The function falls back to retail and no limit,
which is safe for the shop but wrong for the buyer.

### Buyer-group codes are derived at runtime

The audience keys in `t` and `l` and the entries in `g` are **not** a fixed
list. They are derived at push time from the tenant's own TackQuote data, the
same way `CatalogService.resolveGroupCodes` does it:

- the buyer's `tier`, **lower-cased**;
- plus the `code` of every `buyer_groups` row the buyer, or the buyer's
  company, belongs to (`buyer_group_members`), **lower-cased**.
  `buyer_groups.code` is `VARCHAR(100)`, which is where the 100-character
  cap comes from.

Keys are compared **exactly** (case-sensitive) in the function. The writer
must therefore lower-case both sides, exactly as `resolveGroupCodes` does, or
nothing will match.

**`g` order is precedence, and TackQuote does not define one yet.**
`resolveGroupCodes` returns a `Set` built from a query with no `ORDER BY`.
`resolvePackSettings` then merges per field with **last match wins**. For a
buyer in two groups with conflicting settings, TackQuote's own answer
therefore depends on row order. Before the writer ships, the main repo must
define an explicit group priority and write `g` in that order. The functions
use first-match-wins over `g`, so the writer should also merge the product
base values into each group entry field by field before writing it. That
reproduces TackQuote's per-field override.

## 5. Versioning

A breaking change to a metafield bumps that metafield's `v`. A function built
for `v: 1` treats `v: 2` as malformed (logged `*_version`) and falls back to
retail and no limit. To migrate, deploy functions that read both versions,
then switch the writer, then remove v1 reading.

Contract version 2 used the other route, which needs no migration: new data
went into NEW metafields with their own envelope version (section 0), so no v1
value changed shape.
