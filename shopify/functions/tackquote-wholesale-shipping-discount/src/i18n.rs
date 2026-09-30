// Customer-facing text for the wholesale shipping discount.
//
// "Shopify provides the current locale to function input queries as part of
// the Localization object ... Your function should use this locale to provide
// translated content in function output for any messages that display to
// customers" (https://shopify.dev/docs/apps/build/functions/localization-practices-shopify-functions).
// The languages are the theme app extension's: en, fr, de, es, it, nl, pt-BR,
// ja. Any other language gets English. The typegen hands `LanguageCode` over
// as its GraphQL enum name, a string such as "PT_BR".

/// The candidate message shown with the discounted shipping rate.
pub fn wholesale_shipping(lang: &str) -> &'static str {
    match lang {
        "FR" => "Tarif de livraison professionnel",
        "DE" => "Großhandelsversand",
        "ES" => "Envío mayorista",
        "IT" => "Spedizione all’ingrosso",
        "NL" => "Groothandelsverzending",
        "PT_BR" | "PT" => "Frete de atacado",
        "JA" => "卸売向け配送",
        _ => "Wholesale shipping",
    }
}
