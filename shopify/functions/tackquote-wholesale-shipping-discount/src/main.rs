use shopify_function::prelude::*;
use std::process;

pub mod cart_delivery_options_discounts_generate_run;
pub mod contract;
pub mod i18n;

#[typegen("schema.graphql")]
pub mod schema {
    // Both metafields are read lazily from the input rather than as a
    // materialised JsonValue tree; see the header of contract.rs.
    #[query(
        "src/cart_delivery_options_discounts_generate_run.graphql",
        custom_scalar_overrides = {
            "Input.discount.shippingRules.jsonValue" => ::shopify_function::wasm_api::Value,
            "Input.cart.buyerIdentity.customer.buyer.jsonValue" => ::shopify_function::wasm_api::Value,
        }
    )]
    pub mod cart_delivery_options_discounts_generate_run {}
}

fn main() {
    log!("Please invoke a named export.");
    process::abort();
}
