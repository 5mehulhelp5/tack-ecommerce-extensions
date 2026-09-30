// Customer-facing validation messages, per checkout language.
//
// "Shopify provides the current locale to function input queries as part of
// the Localization object ... Your function should use this locale to provide
// translated content in function output for any messages that display to
// customers" (https://shopify.dev/docs/apps/build/functions/localization-practices-shopify-functions).
// The languages are the theme app extension's: en, fr, de, es, it, nl, pt-BR,
// ja. Any other language gets English. The typegen hands `LanguageCode` over
// as its GraphQL enum name, a string such as "PT_BR".
//
// `{name}` is a product label and `{n}` a quantity, count or amount. Each
// language quotes `{name}` the way it is written there. English keeps the
// exact wording the checkout has always shown.

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Msg {
    Max,
    Min,
    Step,
    More,
    MaxItems,
    MaxUnique,
    MinItems,
    MinUnique,
    MaxTotal,
    MinTotal,
    RestrictedGuest,
    Restricted,
}

pub const LANGUAGES: [&str; 8] = ["EN", "FR", "DE", "ES", "IT", "NL", "PT_BR", "JA"];

/// Languages that write 100,00 rather than 100.00.
pub fn decimal_comma(lang: &str) -> bool {
    matches!(lang, "FR" | "DE" | "ES" | "IT" | "NL" | "PT_BR" | "PT")
}

pub fn template(lang: &str, m: Msg) -> &'static str {
    use Msg::*;
    match lang {
        "FR" => match m {
            Max => "La quantité de « {name} » ne peut pas dépasser {n}.",
            Min => "La quantité de « {name} » doit être d’au moins {n}.",
            Step => "La quantité de « {name} » doit être un multiple de {n}.",
            More => "{n} autres problèmes de limites de commande. Ajustez les quantités ci-dessus, puis vérifiez à nouveau votre panier.",
            MaxItems => "La commande ne peut pas contenir plus de {n} articles.",
            MaxUnique => "La commande ne peut pas comporter plus de {n} produits différents.",
            MinItems => "La commande doit contenir au moins {n} articles.",
            MinUnique => "La commande doit comporter au moins {n} produits différents.",
            MaxTotal => "Le montant de la commande ne peut pas dépasser {n}.",
            MinTotal => "Le montant de la commande doit être d’au moins {n}.",
            RestrictedGuest => "« {name} » est réservé aux comptes professionnels approuvés. Connectez-vous ou retirez-le de votre panier.",
            Restricted => "« {name} » n’est pas disponible pour votre compte. Retirez-le de votre panier pour continuer.",
        },
        "DE" => match m {
            Max => "Die Menge für „{name}“ darf höchstens {n} betragen.",
            Min => "Die Menge für „{name}“ muss mindestens {n} betragen.",
            Step => "Die Menge für „{name}“ muss ein Vielfaches von {n} sein.",
            More => "{n} weitere Probleme mit Bestellgrenzen. Passen Sie die Mengen oben an und prüfen Sie Ihren Warenkorb erneut.",
            MaxItems => "Die Bestellung darf höchstens {n} Artikel enthalten.",
            MaxUnique => "Die Bestellung darf höchstens {n} verschiedene Produkte enthalten.",
            MinItems => "Die Bestellung muss mindestens {n} Artikel enthalten.",
            MinUnique => "Die Bestellung muss mindestens {n} verschiedene Produkte enthalten.",
            MaxTotal => "Der Bestellwert darf höchstens {n} betragen.",
            MinTotal => "Der Bestellwert muss mindestens {n} betragen.",
            RestrictedGuest => "„{name}“ ist nur für freigegebene Geschäftskunden erhältlich. Melden Sie sich an oder entfernen Sie den Artikel aus dem Warenkorb.",
            Restricted => "„{name}“ ist für Ihr Konto nicht verfügbar. Entfernen Sie den Artikel aus dem Warenkorb, um fortzufahren.",
        },
        "ES" => match m {
            Max => "La cantidad de «{name}» no puede superar {n}.",
            Min => "La cantidad de «{name}» debe ser de al menos {n}.",
            Step => "La cantidad de «{name}» debe ser múltiplo de {n}.",
            More => "{n} problemas más con los límites del pedido. Ajusta las cantidades anteriores y vuelve a revisar el carrito.",
            MaxItems => "El pedido puede contener como máximo {n} artículos.",
            MaxUnique => "El pedido puede incluir como máximo {n} productos distintos.",
            MinItems => "El pedido debe contener al menos {n} artículos.",
            MinUnique => "El pedido debe incluir al menos {n} productos distintos.",
            MaxTotal => "El total del pedido no puede superar {n}.",
            MinTotal => "El total del pedido debe ser de al menos {n}.",
            RestrictedGuest => "«{name}» solo está disponible para cuentas mayoristas aprobadas. Inicia sesión o elimínalo del carrito.",
            Restricted => "«{name}» no está disponible para tu cuenta. Elimínalo del carrito para continuar.",
        },
        "IT" => match m {
            Max => "La quantità di «{name}» non può superare {n}.",
            Min => "La quantità di «{name}» deve essere almeno {n}.",
            Step => "La quantità di «{name}» deve essere un multiplo di {n}.",
            More => "Altri {n} problemi con i limiti dell’ordine. Modifica le quantità indicate sopra, poi controlla di nuovo il carrello.",
            MaxItems => "L’ordine può contenere al massimo {n} articoli.",
            MaxUnique => "L’ordine può includere al massimo {n} prodotti diversi.",
            MinItems => "L’ordine deve contenere almeno {n} articoli.",
            MinUnique => "L’ordine deve includere almeno {n} prodotti diversi.",
            MaxTotal => "Il totale dell’ordine non può superare {n}.",
            MinTotal => "Il totale dell’ordine deve essere almeno {n}.",
            RestrictedGuest => "«{name}» è riservato agli account business approvati. Accedi o rimuovilo dal carrello.",
            Restricted => "«{name}» non è disponibile per il tuo account. Rimuovilo dal carrello per continuare.",
        },
        "NL" => match m {
            Max => "Het aantal voor “{name}” mag maximaal {n} zijn.",
            Min => "Het aantal voor “{name}” moet minimaal {n} zijn.",
            Step => "Het aantal voor “{name}” moet een veelvoud van {n} zijn.",
            More => "Nog {n} problemen met bestellimieten. Pas de aantallen hierboven aan en controleer je winkelwagen opnieuw.",
            MaxItems => "De bestelling mag maximaal {n} artikelen bevatten.",
            MaxUnique => "De bestelling mag maximaal {n} verschillende producten bevatten.",
            MinItems => "De bestelling moet minimaal {n} artikelen bevatten.",
            MinUnique => "De bestelling moet minimaal {n} verschillende producten bevatten.",
            MaxTotal => "Het bestelbedrag mag maximaal {n} zijn.",
            MinTotal => "Het bestelbedrag moet minimaal {n} zijn.",
            RestrictedGuest => "“{name}” is alleen beschikbaar voor goedgekeurde zakelijke accounts. Log in of verwijder het uit je winkelwagen.",
            Restricted => "“{name}” is niet beschikbaar voor je account. Verwijder het uit je winkelwagen om door te gaan.",
        },
        "PT_BR" | "PT" => match m {
            Max => "A quantidade de “{name}” deve ser no máximo {n}.",
            Min => "A quantidade de “{name}” deve ser de pelo menos {n}.",
            Step => "A quantidade de “{name}” deve ser um múltiplo de {n}.",
            More => "Mais {n} problemas com os limites do pedido. Ajuste as quantidades acima e revise o carrinho novamente.",
            MaxItems => "O pedido pode conter no máximo {n} itens.",
            MaxUnique => "O pedido pode incluir no máximo {n} produtos diferentes.",
            MinItems => "O pedido deve conter pelo menos {n} itens.",
            MinUnique => "O pedido deve incluir pelo menos {n} produtos diferentes.",
            MaxTotal => "O total do pedido deve ser no máximo {n}.",
            MinTotal => "O total do pedido deve ser de pelo menos {n}.",
            RestrictedGuest => "“{name}” está disponível apenas para contas de atacado aprovadas. Entre na sua conta ou remova o item do carrinho.",
            Restricted => "“{name}” não está disponível para a sua conta. Remova o item do carrinho para continuar.",
        },
        "JA" => match m {
            Max => "「{name}」の数量は{n}以下にしてください。",
            Min => "「{name}」の数量は{n}以上にしてください。",
            Step => "「{name}」の数量は{n}の倍数にしてください。",
            More => "ほかに注文制限の問題が{n}件あります。上記の数量を調整してから、もう一度カートをご確認ください。",
            MaxItems => "1回のご注文は{n}点までです。",
            MaxUnique => "1回のご注文に含められる商品は{n}種類までです。",
            MinItems => "ご注文は{n}点以上からとなります。",
            MinUnique => "ご注文には{n}種類以上の商品が必要です。",
            MaxTotal => "ご注文の合計金額は{n}以下にしてください。",
            MinTotal => "ご注文の合計金額は{n}以上にしてください。",
            RestrictedGuest => "「{name}」は承認済みの法人アカウント専用の商品です。ログインするか、カートから削除してください。",
            Restricted => "「{name}」はお客様のアカウントではご購入いただけません。続行するにはカートから削除してください。",
        },
        _ => match m {
            Max => "Quantity for \"{name}\" must be at most {n}.",
            Min => "Quantity for \"{name}\" must be at least {n}.",
            Step => "Quantity for \"{name}\" must be a multiple of {n}.",
            More => "{n} more order-limit problems. Adjust the quantities above, then review your cart again.",
            MaxItems => "Order may contain at most {n} items.",
            MaxUnique => "Order may include at most {n} unique products.",
            MinItems => "Order must contain at least {n} items.",
            MinUnique => "Order must include at least {n} unique products.",
            MaxTotal => "Order total must be at most {n}.",
            MinTotal => "Order total must be at least {n}.",
            RestrictedGuest => "\"{name}\" is available to approved wholesale accounts only. Sign in, or remove it from your cart.",
            Restricted => "\"{name}\" is not available for your account. Remove it from your cart to continue.",
        },
    }
}

/// A message with its placeholders filled. `{n}` is substituted after
/// `{name}`, so a product title that happens to contain "{n}" is left alone.
pub fn message(lang: &str, m: Msg, name: Option<&str>, n: &str) -> String {
    let t = template(lang, m);
    let (head, tail) = match t.find("{name}") {
        Some(i) => (&t[..i], &t[i + "{name}".len()..]),
        None => (t, ""),
    };
    let mut out = head.replace("{n}", n);
    if t.contains("{name}") {
        out.push_str(name.unwrap_or(""));
        out.push_str(&tail.replace("{n}", n));
    }
    out
}
