//! Variables `{{nom}}` disponibles dans les étapes d'un workflow (requête HTTP, notification).
//!
//! Chaque exécution reçoit des variables de base (automatisation, origine, date…) et, quand elle
//! est lancée par un événement, celles de l'événement (projet, branche, commit, serveur…).

use std::collections::BTreeMap;

pub type Vars = BTreeMap<String, String>;

/// Variables présentes dans toutes les exécutions.
pub fn base(automation: &str, origin: &str, context: Option<&str>) -> Vars {
    let now = chrono::Local::now();
    let mut v = Vars::new();
    v.insert("automation".into(), automation.into());
    v.insert("origin".into(), origin.into());
    v.insert("context".into(), context.unwrap_or_default().into());
    v.insert("date".into(), now.format("%d/%m/%Y").to_string());
    v.insert("time".into(), now.format("%H:%M").to_string());
    v.insert(
        "datetime".into(),
        now.to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
    );
    v
}

/// Construit un jeu de variables à partir de paires (les valeurs vides sont gardées).
pub fn of<const N: usize>(pairs: [(&str, String); N]) -> Vars {
    pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
}

/// Comment insérer une valeur dans le texte cible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Escape {
    /// Texte brut (notification, corps non JSON).
    Raw,
    /// À l'intérieur d'une chaîne JSON : guillemets, antislashs et caractères de contrôle échappés.
    Json,
    /// Dans une URL : encodage pourcent de tout ce qui n'est pas « non réservé ».
    Url,
    /// Valeur d'en-tête HTTP : retours à la ligne supprimés.
    Header,
}

/// Remplace chaque `{{nom}}` (espaces tolérés) par sa valeur échappée. Une variable inconnue
/// devient une chaîne vide ; un texte qui ne ressemble pas à une variable est laissé tel quel.
pub fn render(template: &str, vars: &Vars, escape: Escape) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let name = after.find("}}").map(|end| (end, after[..end].trim()));
        match name {
            Some((end, name)) if is_name(name) => {
                out.push_str(&escape_value(
                    vars.get(name).map(String::as_str).unwrap_or_default(),
                    escape,
                ));
                rest = &after[end + 2..];
            }
            _ => {
                // Pas une variable : on avance d'une seule accolade (gère « {{{nom}}} »).
                out.push('{');
                rest = &rest[start + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn is_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn escape_value(value: &str, escape: Escape) -> String {
    match escape {
        Escape::Raw => value.to_string(),
        Escape::Header => value
            .chars()
            .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
            .collect(),
        Escape::Url => {
            let mut s = String::new();
            for b in value.bytes() {
                if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                    s.push(b as char);
                } else {
                    s.push_str(&format!("%{b:02X}"));
                }
            }
            s
        }
        Escape::Json => {
            let mut s = String::with_capacity(value.len());
            for c in value.chars() {
                match c {
                    '"' => s.push_str("\\\""),
                    '\\' => s.push_str("\\\\"),
                    '\n' => s.push_str("\\n"),
                    '\r' => s.push_str("\\r"),
                    '\t' => s.push_str("\\t"),
                    c if (c as u32) < 0x20 => s.push_str(&format!("\\u{:04x}", c as u32)),
                    c => s.push(c),
                }
            }
            s
        }
    }
}

/// Le corps est-il du JSON (en-tête Content-Type ou forme du texte) ?
pub fn body_is_json(headers: &[(String, String)], body: &str) -> bool {
    headers.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("content-type") && v.to_ascii_lowercase().contains("json")
    }) || matches!(body.trim_start().chars().next(), Some('{') | Some('['))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> Vars {
        of([
            ("project", "DevHub".into()),
            ("message", "fix: \"quotes\" \\ et\nligne".into()),
            ("branch", "feat/x y".into()),
        ])
    }

    #[test]
    fn renders_and_escapes() {
        let v = vars();
        assert_eq!(
            render("{{project}} · {{ branch }}", &v, Escape::Raw),
            "DevHub · feat/x y"
        );
        assert_eq!(
            render(r#"{"content":"{{message}}"}"#, &v, Escape::Json),
            r#"{"content":"fix: \"quotes\" \\ et\nligne"}"#
        );
        assert_eq!(
            render("https://x.test/?b={{branch}}", &v, Escape::Url),
            "https://x.test/?b=feat%2Fx%20y"
        );
        assert_eq!(
            render("{{message}}", &v, Escape::Header),
            "fix: \"quotes\" \\ et ligne"
        );
    }

    #[test]
    fn unknown_and_malformed() {
        let v = vars();
        assert_eq!(render("a{{inconnue}}b", &v, Escape::Raw), "ab");
        assert_eq!(
            render("{{ pas une var }} {{", &v, Escape::Raw),
            "{{ pas une var }} {{"
        );
        assert_eq!(render("{{{project}}}", &v, Escape::Raw), "{DevHub}");
        assert_eq!(render("x {{ }} y", &v, Escape::Raw), "x {{ }} y");
    }

    #[test]
    fn detects_json_body() {
        assert!(body_is_json(
            &[("Content-Type".into(), "application/json".into())],
            "x"
        ));
        assert!(body_is_json(&[], "  {\"a\":1}"));
        assert!(!body_is_json(&[], "texte"));
    }
}
