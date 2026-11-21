//! Édition des scripts `package.json`.
//!
//! Seul le bloc `"scripts"` est réécrit : le reste du fichier (ordre des clés, indentation,
//! fin de ligne, BOM) est conservé à l'octet près.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use super::env::{revision, write_atomic};

const MAX_FILE_SIZE: u64 = 1024 * 1024;
const MAX_SCRIPTS: usize = 300;
const MAX_NAME_LEN: usize = 100;
const MAX_COMMAND_LEN: usize = 4000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeScript {
    pub name: String,
    pub command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeScripts {
    /// Empreinte du package.json lu : une sauvegarde est refusée s'il a changé entre-temps.
    pub revision: String,
    /// Dans l'ordre du fichier.
    pub scripts: Vec<NodeScript>,
}

fn package_path(dir: &Path) -> AppResult<PathBuf> {
    let path = dir.join("package.json");
    match std::fs::symlink_metadata(&path) {
        Ok(m) if m.is_file() => Ok(path),
        Ok(_) => Err(AppError::InvalidInput(
            "package.json n'est pas un fichier ordinaire".into(),
        )),
        Err(_) => Err(AppError::InvalidInput(
            "aucun package.json dans ce projet".into(),
        )),
    }
}

fn read_text(path: &Path) -> AppResult<String> {
    if std::fs::metadata(path)?.len() > MAX_FILE_SIZE {
        return Err(AppError::InvalidInput(
            "package.json trop volumineux".into(),
        ));
    }
    String::from_utf8(std::fs::read(path)?)
        .map_err(|_| AppError::InvalidInput("package.json non UTF-8".into()))
}

fn invalid_json() -> AppError {
    AppError::InvalidInput("package.json invalide (JSON illisible)".into())
}

/// Scripts dans l'ordre du fichier (serde_json trie les clés, on relit donc le texte).
fn parse_scripts(body: &str) -> AppResult<Vec<NodeScript>> {
    let root = scan_root(body)?;
    let Some(span) = root.scripts else {
        return Ok(Vec::new());
    };
    let value = &body[span.0..span.1];
    if !value.starts_with('{') {
        return Err(AppError::InvalidInput(
            "le champ « scripts » du package.json n'est pas un objet".into(),
        ));
    }
    let mut out = Vec::new();
    for (key, val) in object_members(value)? {
        // Les valeurs non textuelles sont ignorées, comme à la détection.
        if let Ok(command) = serde_json::from_str::<String>(val) {
            out.push(NodeScript {
                name: serde_json::from_str(key).map_err(|_| invalid_json())?,
                command,
            });
        }
    }
    Ok(out)
}

pub fn read(dir: &Path) -> AppResult<NodeScripts> {
    let text = read_text(&package_path(dir)?)?;
    let body = text.strip_prefix('\u{FEFF}').unwrap_or(&text);
    Ok(NodeScripts {
        revision: revision(&text),
        scripts: parse_scripts(body)?,
    })
}

fn validate(scripts: &[NodeScript]) -> AppResult<()> {
    if scripts.len() > MAX_SCRIPTS {
        return Err(AppError::InvalidInput("trop de scripts".into()));
    }
    let mut seen = std::collections::HashSet::new();
    for s in scripts {
        let name = s.name.as_str();
        if name.trim().is_empty() || name.trim() != name {
            return Err(AppError::InvalidInput(format!(
                "nom de script invalide : « {name} »"
            )));
        }
        if name.chars().count() > MAX_NAME_LEN || name.chars().any(char::is_control) {
            return Err(AppError::InvalidInput(format!(
                "nom de script invalide : « {name} »"
            )));
        }
        if !seen.insert(name) {
            return Err(AppError::InvalidInput(format!(
                "script « {name} » en double"
            )));
        }
        if s.command.trim().is_empty() {
            return Err(AppError::InvalidInput(format!(
                "la commande du script « {name} » est vide"
            )));
        }
        if s.command.chars().count() > MAX_COMMAND_LEN {
            return Err(AppError::InvalidInput(format!(
                "commande du script « {name} » trop longue"
            )));
        }
    }
    Ok(())
}

/// Remplace tous les scripts du package.json par `scripts` (dans cet ordre).
pub fn save(dir: &Path, expected_revision: &str, scripts: &[NodeScript]) -> AppResult<NodeScripts> {
    validate(scripts)?;
    let path = package_path(dir)?;
    let text = read_text(&path)?;
    if revision(&text) != expected_revision {
        return Err(AppError::InvalidInput(
            "package.json a été modifié sur le disque depuis l'ouverture : rechargez les scripts"
                .into(),
        ));
    }
    let (bom, body) = match text.strip_prefix('\u{FEFF}') {
        Some(rest) => ("\u{FEFF}", rest),
        None => ("", text.as_str()),
    };
    let out = format!("{bom}{}", splice(body, scripts)?);
    // Garde-fou : le résultat doit être un JSON valide contenant exactement les scripts voulus.
    let body_out = out.strip_prefix('\u{FEFF}').unwrap_or(&out);
    serde_json::from_str::<serde_json::Value>(body_out).map_err(|_| invalid_json())?;
    if parse_scripts(body_out)? != scripts {
        return Err(AppError::InvalidInput(
            "réécriture du package.json incohérente : fichier laissé intact".into(),
        ));
    }
    if out != text {
        write_atomic(&path, &out)?;
    }
    Ok(NodeScripts {
        revision: revision(&out),
        scripts: scripts.to_vec(),
    })
}

// ---------------------------------------------------------------- Réécriture textuelle

fn splice(body: &str, scripts: &[NodeScript]) -> AppResult<String> {
    // Refuse d'écrire dans un fichier que l'on ne sait pas relire.
    serde_json::from_str::<serde_json::Value>(body).map_err(|_| invalid_json())?;
    let root = scan_root(body)?;
    let nl = if body.contains("\r\n") { "\r\n" } else { "\n" };
    let indent = detect_indent(body);
    let block = render(scripts, &indent, nl);
    Ok(match root.scripts {
        Some((start, end)) => format!("{}{block}{}", &body[..start], &body[end..]),
        // Ajouté après le dernier champ de l'objet racine.
        None => match root.last_value_end {
            Some(at) => format!(
                "{},{nl}{indent}\"scripts\": {block}{}",
                &body[..at],
                &body[at..]
            ),
            // Objet racine vide : `{}` devient `{ "scripts": … }` sur plusieurs lignes.
            None => format!(
                "{}{{{nl}{indent}\"scripts\": {block}{nl}}}{}",
                &body[..root.open],
                &body[root.close + 1..]
            ),
        },
    })
}

fn render(scripts: &[NodeScript], indent: &str, nl: &str) -> String {
    if scripts.is_empty() {
        return "{}".into();
    }
    let lines: Vec<String> = scripts
        .iter()
        .map(|s| {
            format!(
                "{indent}{indent}{}: {}",
                serde_json::to_string(&s.name).unwrap_or_default(),
                serde_json::to_string(&s.command).unwrap_or_default()
            )
        })
        .collect();
    format!("{{{nl}{}{nl}{indent}}}", lines.join(&format!(",{nl}")))
}

/// Indentation d'un niveau : celle de la première clé de l'objet racine (2 espaces par défaut).
fn detect_indent(body: &str) -> String {
    for line in body.lines().skip(1) {
        let trimmed = line.trim_start_matches([' ', '\t']);
        if trimmed.starts_with('"') {
            let ws = &line[..line.len() - trimmed.len()];
            if !ws.is_empty() {
                return ws.to_string();
            }
        }
    }
    "  ".into()
}

struct Root {
    open: usize,
    close: usize,
    /// Fin (exclue) de la valeur du dernier membre de l'objet racine.
    last_value_end: Option<usize>,
    /// Valeur du dernier champ `scripts` (comme serde_json : la dernière occurrence l'emporte).
    scripts: Option<(usize, usize)>,
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\n' | b'\r') {
        i += 1;
    }
    i
}

/// Fin (exclue) de la chaîne JSON qui commence en `i` (sur le guillemet ouvrant).
fn string_end(b: &[u8], mut i: usize) -> AppResult<usize> {
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return Ok(i + 1),
            _ => i += 1,
        }
    }
    Err(invalid_json())
}

/// Fin (exclue) de la valeur JSON qui commence en `i`.
fn value_end(b: &[u8], i: usize) -> AppResult<usize> {
    match b.get(i) {
        Some(b'"') => string_end(b, i),
        Some(b'{') | Some(b'[') => {
            let mut depth = 0usize;
            let mut j = i;
            while j < b.len() {
                match b[j] {
                    b'"' => {
                        j = string_end(b, j)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Ok(j + 1);
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            Err(invalid_json())
        }
        Some(_) => {
            let mut j = i;
            while j < b.len() && !matches!(b[j], b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r')
            {
                j += 1;
            }
            Ok(j)
        }
        None => Err(invalid_json()),
    }
}

/// Membres (clé brute avec guillemets, valeur brute) d'un objet JSON qui commence en 0.
fn object_members(obj: &str) -> AppResult<Vec<(&str, &str)>> {
    let b = obj.as_bytes();
    let mut out = Vec::new();
    let mut i = skip_ws(b, 1);
    if b.get(i) == Some(&b'}') {
        return Ok(out);
    }
    loop {
        if b.get(i) != Some(&b'"') {
            return Err(invalid_json());
        }
        let key_end = string_end(b, i)?;
        let colon = skip_ws(b, key_end);
        if b.get(colon) != Some(&b':') {
            return Err(invalid_json());
        }
        let vs = skip_ws(b, colon + 1);
        let ve = value_end(b, vs)?;
        out.push((&obj[i..key_end], &obj[vs..ve]));
        i = skip_ws(b, ve);
        match b.get(i) {
            Some(b',') => i = skip_ws(b, i + 1),
            Some(b'}') => return Ok(out),
            _ => return Err(invalid_json()),
        }
    }
}

fn scan_root(body: &str) -> AppResult<Root> {
    let b = body.as_bytes();
    let open = skip_ws(b, 0);
    if b.get(open) != Some(&b'{') {
        return Err(AppError::InvalidInput(
            "package.json doit contenir un objet JSON".into(),
        ));
    }
    let close = value_end(b, open)? - 1;
    let mut root = Root {
        open,
        close,
        last_value_end: None,
        scripts: None,
    };
    for (key, value) in object_members(&body[open..=close])? {
        // Positions relatives à `body` (les tranches pointent dans la même chaîne).
        let vs = value.as_ptr() as usize - body.as_ptr() as usize;
        let ve = vs + value.len();
        root.last_value_end = Some(ve);
        if serde_json::from_str::<String>(key).ok().as_deref() == Some("scripts") {
            root.scripts = Some((vs, ve));
        }
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(name: &str, command: &str) -> NodeScript {
        NodeScript {
            name: name.into(),
            command: command.into(),
        }
    }

    #[test]
    fn reads_scripts_in_file_order() {
        let body = r#"{"name":"x","scripts":{"zeta":"a","alpha":"b","bad":1}}"#;
        assert_eq!(
            parse_scripts(body).unwrap(),
            vec![s("zeta", "a"), s("alpha", "b")]
        );
    }

    #[test]
    fn replaces_only_the_scripts_block() {
        let body = "{\n    \"name\": \"app\",\n    \"scripts\": {\n        \"dev\": \"vite\"\n    },\n    \"dependencies\": {\"z\": \"1\", \"a\": \"2\"}\n}\n";
        let out = splice(body, &[s("dev", "vite --host"), s("build", "vite build")]).unwrap();
        assert_eq!(
            out,
            "{\n    \"name\": \"app\",\n    \"scripts\": {\n        \"dev\": \"vite --host\",\n        \"build\": \"vite build\"\n    },\n    \"dependencies\": {\"z\": \"1\", \"a\": \"2\"}\n}\n"
        );
    }

    #[test]
    fn adds_missing_scripts_and_keeps_crlf() {
        let body = "{\r\n  \"name\": \"app\"\r\n}\r\n";
        let out = splice(body, &[s("test", "vitest \"run\"")]).unwrap();
        assert_eq!(
            out,
            "{\r\n  \"name\": \"app\",\r\n  \"scripts\": {\r\n    \"test\": \"vitest \\\"run\\\"\"\r\n  }\r\n}\r\n"
        );
        assert_eq!(
            parse_scripts(&out).unwrap(),
            vec![s("test", "vitest \"run\"")]
        );
    }

    #[test]
    fn handles_empty_root_and_empty_list() {
        let out = splice("{}", &[s("dev", "node .")]).unwrap();
        assert_eq!(parse_scripts(&out).unwrap(), vec![s("dev", "node .")]);
        let out = splice(r#"{"scripts":{"a":"b"},"x":1}"#, &[]).unwrap();
        assert_eq!(out, r#"{"scripts":{},"x":1}"#);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(validate(&[s("a", "x"), s("a", "y")]).is_err());
        assert!(validate(&[s(" a", "x")]).is_err());
        assert!(validate(&[s("a", "  ")]).is_err());
        assert!(splice("[1]", &[]).is_err());
        assert!(splice("{\"a\":", &[]).is_err());
    }

    #[test]
    fn saves_with_revision_check() {
        let dir = std::env::temp_dir().join(format!("devcenter-scripts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            "\u{FEFF}{\n  \"scripts\": {\"dev\": \"vite\"}\n}\n",
        )
        .unwrap();
        let current = read(&dir).unwrap();
        assert_eq!(current.scripts, vec![s("dev", "vite")]);
        assert!(save(&dir, "stale", &[]).is_err());
        let saved = save(&dir, &current.revision, &[s("start", "node server.js")]).unwrap();
        let text = std::fs::read_to_string(dir.join("package.json")).unwrap();
        assert!(text.starts_with('\u{FEFF}'));
        assert_eq!(read(&dir).unwrap().revision, saved.revision);
        assert_eq!(
            read(&dir).unwrap().scripts,
            vec![s("start", "node server.js")]
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
