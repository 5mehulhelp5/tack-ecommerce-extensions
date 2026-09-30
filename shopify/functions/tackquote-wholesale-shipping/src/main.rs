use shopify_function::prelude::*;
use std::process;

pub mod cart_delivery_options_transform_run;
pub mod contract;

#[typegen("schema.graphql")]
pub mod schema {
    // Both metafields are read lazily from the input rather than as a
    // materialised JsonValue tree; see the header of contract.rs.
    #[query(
        "src/cart_delivery_options_transform_run.graphql",
        custom_scalar_overrides = {
            "Input.deliveryCustomization.shippingRules.jsonValue" => ::shopify_function::wasm_api::Value,
            "Input.cart.buyerIdentity.customer.buyer.jsonValue" => ::shopify_function::wasm_api::Value,
        }
    )]
    pub mod cart_delivery_options_transform_run {}
}

fn main() {
    log!("Please invoke a named export.");
    process::abort();
}
