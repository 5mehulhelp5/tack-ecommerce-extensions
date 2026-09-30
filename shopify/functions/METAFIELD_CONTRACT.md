# TackQuote checkout-pricing metafield contract, version 1

This contract is how TackQuote passes wholesale prices and order limits to the
two Shopify Functions in this directory:

| Function | Target | Reads |
|---|---|---|
| `tackquote-wholesale-pricing` (Discount) | `cart.lines.discounts.generate.run` | customer `$app:buyer`, variant `$app:price_tiers` |
| `tackquote-order-limits` (Cart and Checkout Validation) | `cart.validations.generate.run` | validation `$app:cart_limits`, customer `$app:buyer`, variant `$app:order_limits` |

The functions have no network access. A public app's function cannot call
TackQuote at checkout, so every value a function needs is pushed into Shopify
ahead of time. The executable versions of this document are:

- `contract/contract.rs`: the reader. It is copied byte for byte into both crates.
- `contract/reference-writer/contract.js` and `encode.js`: the writer, which
  validates whole documents. The TackQuote API's push pipeline must behave
  exactly like it.

If this document and those files disagree, the code is right and this
document needs fixing.

## 1. Rules that apply to every metafield

- **Namespace** is `$app`, the app-reserved namespace. Only TackQuote can write it
  (https://shopify.dev/docs/apps/build/custom-data/ownership). It is expanded to
  `app--<app id>` in the Admin API. The functions query it literally as
  `metafield(namespace: "$app", key: ...)`.
- **Type** is `json`. The functions read `jsonValue`.
- **Envelope**: every value is a JSON object with `"v": 1`. A value without it,
  with a different version, or that is not an object at all is treated as
  **malformed**.
- **Absent vs malformed.** If a value is absent, the function behaves as if
  TackQuote has no rule. If a value is present but breaks this contract, it is
  **omitted and logged**, never defaulted. A malformed price book never becomes a
  price, and it never falls through to a different book. A malformed limit is
  not enforced, and it never falls back to a default.
- **Unknown keys are malformed.** A future field needs `"v": 2`.
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

A breaking change bumps `v`. A function built for `v: 1` treats `v: 2` as
malformed (logged `*_version`) and falls back to retail and no limit. To
migrate, deploy functions that read both versions, then switch the writer,
then remove v1 reading.
