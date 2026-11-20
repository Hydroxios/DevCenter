//! Fichiers `.env*` d'un projet : lecture, édition (commentaires, ordre et guillemets conservés),
//! écriture atomique et profil actif injecté dans les scripts lancés par DevCenter.
//!
//! Les valeurs sont des secrets : elles ne sont jamais écrites dans le journal ni dans un message
//! d'erreur (les erreurs de commande sont journalisées). Seuls les noms de fichiers et de clés le sont.

use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::database::Database;
use crate::error::{AppError, AppResult};

/// Taille maximale d'un fichier `.env` lu ou écrit.
const MAX_FILE_SIZE: u64 = 1024 * 1024;

// ---------------------------------------------------------------- Analyse / sérialisation

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Quote {
    None,
    Single,
    Double,
    Backtick,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    /// Indentation et éventuel `export ` avant la clé.
    prefix: String,
    key: String,
    /// Séparateur tel qu'écrit (`=`, ` = `…).
    sep: String,
    /// Valeur brute (guillemets compris), telle qu'écrite dans le fichier.
    raw: String,
    /// Valeur décodée.
    value: String,
    quote: Quote,
    /// Espaces et commentaire après la valeur (` # …`).
    trailing: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Line {
    /// Ligne vide, commentaire ou ligne non reconnue : recopiée telle quelle.
    Raw(String),
    Entry(Entry),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Document {
    lines: Vec<Line>,
    crlf: bool,
    final_newline: bool,
    bom: bool,
}

fn is_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-'
}

pub fn valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(is_key_char)
        && key.len() <= 200
}

/// Position du guillemet fermant (non échappé pour `"`), dans `s` qui suit le guillemet ouvrant.
fn closing_quote(s: &str, quote: char) -> Option<usize> {
    let mut escaped = false;
    for (i, c) in s.char_indices() {
        if quote == '"' && escaped {
            escaped = false;
            continue;
        }
        if quote == '"' && c == '\\' {
            escaped = true;
            continue;
        }
        if c == quote {
            return Some(i);
        }
    }
    None
}

fn unescape_double(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('"') => out.push('"'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

fn escape_double(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out
}

/// Encode une valeur en gardant si possible le style de guillemets d'origine.
fn encode_value(value: &str, preferred: Quote) -> (String, Quote) {
    let bare_ok = !value
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '#' | '"' | '\'' | '`'));
    let single_ok = !value.contains('\'') && !value.contains('\n') && !value.contains('\r');
    let backtick_ok = !value.contains('`') && !value.contains('\n') && !value.contains('\r');
    match preferred {
        Quote::Single if single_ok => (format!("'{value}'"), Quote::Single),
        Quote::Backtick if backtick_ok => (format!("`{value}`"), Quote::Backtick),
        Quote::None if bare_ok => (value.to_string(), Quote::None),
        _ => (format!("\"{}\"", escape_double(value)), Quote::Double),
    }
}

/// Analyse une entrée `KEY=valeur` à partir de `lines[i]` ; renvoie l'entrée et le nombre de
/// lignes consommées (une valeur entre guillemets peut s'étendre sur plusieurs lignes).
fn parse_entry(lines: &[&str], i: usize, sep_nl: &str) -> Option<(Entry, usize)> {
    let line = lines[i];
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let indent = &line[..line.len() - trimmed.len()];
    let (export, rest) = match trimmed.strip_prefix("export") {
        Some(r) if r.starts_with([' ', '\t']) => {
            let r2 = r.trim_start();
            (&trimmed[..trimmed.len() - r2.len()], r2)
        }
        _ => ("", trimmed),
    };
    let key_len = rest.find(|c: char| !is_key_char(c)).unwrap_or(rest.len());
    let key = &rest[..key_len];
    if !valid_key(key) {
        return None;
    }
    let after_key = &rest[key_len..];
    let eq = after_key.find('=')?;
    if !after_key[..eq].chars().all(|c| c == ' ' || c == '\t') {
        return None;
    }
    let after_eq = &after_key[eq + 1..];
    let value_part = after_eq.trim_start_matches([' ', '\t']);
    let sep = &after_key[..eq + 1 + (after_eq.len() - value_part.len())];
    let prefix = format!("{indent}{export}");

    let quote = match value_part.chars().next() {
        Some('"') => Quote::Double,
        Some('\'') => Quote::Single,
        Some('`') => Quote::Backtick,
        _ => Quote::None,
    };
    if quote != Quote::None {
        let q = value_part.chars().next().unwrap_or('"');
        // Valeur entre guillemets, éventuellement sur plusieurs lignes.
        let mut body = value_part[1..].to_string();
        let mut consumed = 1;
        loop {
            if let Some(end) = closing_quote(&body, q) {
                let inner = &body[..end];
                let trailing = &body[end + 1..];
                // Après le guillemet : seulement des espaces et un commentaire.
                let t = trailing.trim_start();
                if !(t.is_empty() || t.starts_with('#')) {
                    break;
                }
                let raw = format!("{q}{inner}{q}");
                let value = match quote {
                    Quote::Double => unescape_double(inner),
                    _ => inner.to_string(),
                };
                return Some((
                    Entry {
                        prefix,
                        key: key.into(),
                        sep: sep.into(),
                        raw,
                        value,
                        quote,
                        trailing: trailing.into(),
                    },
                    consumed,
                ));
            }
            if i + consumed >= lines.len() {
                break;
            }
            body.push_str(sep_nl);
            body.push_str(lines[i + consumed]);
            consumed += 1;
        }
        // Guillemet jamais fermé : valeur brute sur la seule première ligne.
        let raw = value_part.trim_end().to_string();
        let trailing = value_part[raw.len()..].to_string();
        return Some((
            Entry {
                prefix,
                key: key.into(),
                sep: sep.into(),
                value: raw.clone(),
                raw,
                quote: Quote::None,
                trailing,
            },
            1,
        ));
    }

    // Sans guillemets : un `#` précédé d'un espace commence un commentaire.
    let mut cut = value_part.len();
    let bytes = value_part.as_bytes();
    for (idx, b) in bytes.iter().enumerate() {
        if *b == b'#' && (idx == 0 || bytes[idx - 1] == b' ' || bytes[idx - 1] == b'\t') {
            cut = idx;
            break;
        }
    }
    let raw = value_part[..cut].trim_end_matches([' ', '\t']);
    let trailing = &value_part[raw.len()..];
    Some((
        Entry {
            prefix,
            key: key.into(),
            sep: sep.into(),
            raw: raw.into(),
            value: raw.into(),
            quote: Quote::None,
            trailing: trailing.into(),
        },
        1,
    ))
}

fn parse(text: &str) -> Document {
    let bom = text.starts_with('\u{feff}');
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let crlf = text.contains("\r\n");
    let final_newline = text.ends_with('\n');
    let nl = if crlf { "\r\n" } else { "\n" };
    let body = text
        .strip_suffix(nl)
        .or_else(|| text.strip_suffix('\n'))
        .unwrap_or(text);
    let raw_lines: Vec<&str> = if body.is_empty() && text.is_empty() {
        Vec::new()
    } else if crlf {
        body.split("\r\n").collect()
    } else {
        body.split('\n').collect()
    };
    let mut lines = Vec::new();
    let mut i = 0;
    while i < raw_lines.len() {
        match parse_entry(&raw_lines, i, nl) {
            Some((entry, n)) => {
                lines.push(Line::Entry(entry));
                i += n;
            }
            None => {
                lines.push(Line::Raw(raw_lines[i].to_string()));
                i += 1;
            }
        }
    }
    Document {
        lines,
        crlf,
        final_newline,
        bom,
    }
}

fn serialize(doc: &Document) -> String {
    let nl = if doc.crlf { "\r\n" } else { "\n" };
    let mut out = String::new();
    if doc.bom {
        out.push('\u{feff}');
    }
    for (i, line) in doc.lines.iter().enumerate() {
        if i > 0 {
            out.push_str(nl);
        }
        match line {
            Line::Raw(s) => out.push_str(s),
            Line::Entry(e) => {
                out.push_str(&e.prefix);
                out.push_str(&e.key);
                out.push_str(&e.sep);
                out.push_str(&e.raw);
                out.push_str(&e.trailing);
            }
        }
    }
    if doc.final_newline && !doc.lines.is_empty() {
        out.push_str(nl);
    }
    out
}

impl Document {
    fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.lines.iter().filter_map(|l| match l {
            Line::Entry(e) => Some(e),
            Line::Raw(_) => None,
        })
    }

    fn vars(&self) -> Vec<(String, String)> {
        self.entries()
            .map(|e| (e.key.clone(), e.value.clone()))
            .collect()
    }

    /// Applique les modifications : `updates` liste les entrées voulues, dans l'ordre affiché ;
    /// `index` renvoie à l'entrée d'origine (rang parmi les entrées du fichier), `None` pour une
    /// nouvelle clé (ajoutée à la fin). Les entrées absentes sont supprimées.
    fn apply(&mut self, updates: &[EnvUpdate]) -> AppResult<()> {
        let mut seen = HashSet::new();
        for u in updates {
            let key = u.key.trim();
            if !valid_key(key) {
                return Err(AppError::InvalidInput(format!(
                    "nom de variable invalide : « {key} »"
                )));
            }
            if !seen.insert(key.to_string()) {
                return Err(AppError::InvalidInput(format!(
                    "variable en double : {key}"
                )));
            }
            if u.value.contains('\0') {
                return Err(AppError::InvalidInput(format!(
                    "valeur invalide pour {key}"
                )));
            }
        }
        let count = self.entries().count();
        let mut by_index: Vec<Option<&EnvUpdate>> = vec![None; count];
        for u in updates {
            if let Some(i) = u.index {
                let slot = by_index.get_mut(i).ok_or_else(|| {
                    AppError::InvalidInput(format!("entrée {i} inconnue : rechargez le fichier"))
                })?;
                if slot.is_some() {
                    return Err(AppError::InvalidInput(format!(
                        "entrée {i} modifiée deux fois"
                    )));
                }
                *slot = Some(u);
            }
        }

        let mut ordinal = 0;
        let old = std::mem::take(&mut self.lines);
        for line in old {
            match line {
                Line::Raw(_) => self.lines.push(line),
                Line::Entry(mut e) => {
                    let update = by_index[ordinal];
                    ordinal += 1;
                    let Some(u) = update else { continue }; // supprimée
                    e.key = u.key.trim().to_string();
                    if e.value != u.value {
                        let (raw, quote) = encode_value(&u.value, e.quote);
                        e.raw = raw;
                        e.quote = quote;
                        e.value = u.value.clone();
                    }
                    self.lines.push(Line::Entry(e));
                }
            }
        }
        for u in updates.iter().filter(|u| u.index.is_none()) {
            let (raw, quote) = encode_value(&u.value, Quote::None);
            self.lines.push(Line::Entry(Entry {
                prefix: String::new(),
                key: u.key.trim().to_string(),
                sep: "=".into(),
                raw,
                value: u.value.clone(),
                quote,
                trailing: String::new(),
            }));
        }
        if !self.lines.is_empty() {
            self.final_newline = true;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------- Fichiers

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvFileInfo {
    pub name: String,
    pub entries: usize,
    /// Modèle (`.env.example`, `.env.sample`, `.env.template`) : référence des clés attendues.
    pub is_example: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvOverview {
    pub files: Vec<EnvFileInfo>,
    /// Fichier injecté dans les scripts lancés depuis DevCenter.
    pub active: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvEntry {
    /// Rang de l'entrée dans le fichier (à renvoyer tel quel à l'enregistrement).
    pub index: usize,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvFile {
    pub name: String,
    pub entries: Vec<EnvEntry>,
    /// Clés présentes dans le modèle mais absentes de ce fichier.
    pub missing: Vec<String>,
    /// Nom du modèle comparé (`None` s'il n'y en a pas).
    pub example: Option<String>,
    /// Empreinte du contenu lu : l'enregistrement est refusé si le fichier a changé depuis.
    pub revision: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvUpdate {
    pub index: Option<usize>,
    pub key: String,
    pub value: String,
}

const EXAMPLE_SUFFIXES: &[&str] = &["example", "sample", "template", "dist"];

fn is_example(name: &str) -> bool {
    name.rsplit('.')
        .next()
        .is_some_and(|s| EXAMPLE_SUFFIXES.iter().any(|e| e.eq_ignore_ascii_case(s)))
        && name != ".env"
}

/// Nom de fichier accepté : `.env` ou `.env.<suffixe>` (lettres, chiffres, `_`, `-`, `.`),
/// sans séparateur de chemin : aucune sortie du dossier du projet n'est possible.
pub fn valid_name(name: &str) -> bool {
    if name == ".env" {
        return true;
    }
    let Some(suffix) = name.strip_prefix(".env.") else {
        return false;
    };
    !suffix.is_empty()
        && name.len() <= 100
        && suffix.split('.').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
}

/// Chemin d'un fichier `.env*` du projet, confiné au dossier (pas de lien symbolique).
fn resolve(dir: &Path, name: &str) -> AppResult<PathBuf> {
    if !valid_name(name) {
        return Err(AppError::InvalidInput(format!(
            "nom de fichier .env invalide : « {name} »"
        )));
    }
    let path = dir.join(name);
    if path.parent() != Some(dir) {
        return Err(AppError::InvalidInput("chemin hors du projet".into()));
    }
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(AppError::InvalidInput(format!(
                "{name} n'est pas un fichier ordinaire"
            )));
        }
    }
    Ok(path)
}

fn read_text(path: &Path) -> AppResult<String> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_FILE_SIZE {
        return Err(AppError::InvalidInput(
            "fichier .env trop volumineux".into(),
        ));
    }
    let bytes = std::fs::read(path)?;
    String::from_utf8(bytes).map_err(|_| AppError::InvalidInput("fichier .env non UTF-8".into()))
}

fn revision(text: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Écrit via un fichier temporaire du même dossier puis le renomme : jamais de fichier à moitié écrit.
fn write_atomic(path: &Path, text: &str) -> AppResult<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .ok_or_else(|| AppError::InvalidInput("chemin invalide".into()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.devcenter-{}.tmp", std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(result?)
}

fn list_names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| valid_name(n))
        .collect();
    // `.env` d'abord, puis les variantes, les modèles en dernier.
    names.sort_by_key(|n| (n != ".env", is_example(n), n.to_lowercase()));
    names
}

fn example_of(dir: &Path) -> Option<String> {
    list_names(dir).into_iter().find(|n| is_example(n))
}

pub fn overview(db: &Database, project_id: i64, dir: &Path) -> AppResult<EnvOverview> {
    let files = list_names(dir)
        .into_iter()
        .map(|name| {
            let entries = resolve(dir, &name)
                .and_then(|p| read_text(&p))
                .map(|t| parse(&t).entries().count())
                .unwrap_or(0);
            EnvFileInfo {
                is_example: is_example(&name),
                name,
                entries,
            }
        })
        .collect();
    Ok(EnvOverview {
        files,
        active: active_name(db, project_id)?,
    })
}

pub fn read(dir: &Path, name: &str) -> AppResult<EnvFile> {
    let path = resolve(dir, name)?;
    let text = read_text(&path)?;
    let doc = parse(&text);
    let entries: Vec<EnvEntry> = doc
        .entries()
        .enumerate()
        .map(|(index, e)| EnvEntry {
            index,
            key: e.key.clone(),
            value: e.value.clone(),
        })
        .collect();
    let example = example_of(dir).filter(|e| e != name);
    let missing = match &example {
        Some(ex) => {
            let keys: HashSet<&str> = entries.iter().map(|e| e.key.as_str()).collect();
            let ex_text = resolve(dir, ex)
                .and_then(|p| read_text(&p))
                .unwrap_or_default();
            let mut missing = Vec::new();
            for e in parse(&ex_text).entries() {
                if !keys.contains(e.key.as_str()) && !missing.contains(&e.key) {
                    missing.push(e.key.clone());
                }
            }
            missing
        }
        None => Vec::new(),
    };
    Ok(EnvFile {
        name: name.to_string(),
        entries,
        missing,
        example,
        revision: revision(&text),
    })
}

pub fn save(
    dir: &Path,
    name: &str,
    revision_seen: &str,
    updates: &[EnvUpdate],
) -> AppResult<EnvFile> {
    let path = resolve(dir, name)?;
    let text = read_text(&path)?;
    if revision(&text) != revision_seen {
        return Err(AppError::InvalidInput(format!(
            "{name} a été modifié sur le disque : rechargez-le avant d'enregistrer"
        )));
    }
    let mut doc = parse(&text);
    doc.apply(updates)?;
    let out = serialize(&doc);
    if out.len() as u64 > MAX_FILE_SIZE {
        return Err(AppError::InvalidInput(
            "fichier .env trop volumineux".into(),
        ));
    }
    write_atomic(&path, &out)?;
    log::info!(target: "env", "{name} enregistré ({} variables)", doc.entries().count());
    read(dir, name)
}

/// Crée un fichier `.env*` vide, ou copie d'un autre fichier du projet (souvent le modèle).
pub fn create(dir: &Path, name: &str, copy_from: Option<&str>) -> AppResult<EnvFile> {
    let path = resolve(dir, name)?;
    if path.exists() {
        return Err(AppError::InvalidInput(format!("{name} existe déjà")));
    }
    let text = match copy_from {
        Some(src) => read_text(&resolve(dir, src)?)?,
        None => String::new(),
    };
    write_atomic(&path, &text)?;
    log::info!(target: "env", "{name} créé");
    read(dir, name)
}

// ---------------------------------------------------------------- Profil actif

fn active_name(db: &Database, project_id: i64) -> AppResult<Option<String>> {
    db.with(|conn| {
        Ok(conn.query_row(
            "SELECT env_file FROM projects WHERE id = ?1",
            params![project_id],
            |r| r.get::<_, Option<String>>(0),
        )?)
    })
}

pub fn set_active(
    db: &Database,
    project_id: i64,
    dir: &Path,
    name: Option<&str>,
) -> AppResult<EnvOverview> {
    if let Some(n) = name {
        let path = resolve(dir, n)?;
        if !path.is_file() {
            return Err(AppError::InvalidInput(format!("{n} introuvable")));
        }
    }
    db.with(|conn| {
        conn.execute(
            "UPDATE projects SET env_file = ?1 WHERE id = ?2",
            params![name, project_id],
        )?;
        Ok(())
    })?;
    overview(db, project_id, dir)
}

/// Variables du profil actif, à injecter dans un script lancé depuis DevCenter.
/// `Ok(None)` si aucun profil n'est choisi ; le nom du fichier accompagne les variables.
pub fn script_env(
    db: &Database,
    project_id: i64,
    dir: &Path,
) -> AppResult<Option<(String, Vec<(String, String)>)>> {
    let Some(name) = active_name(db, project_id)? else {
        return Ok(None);
    };
    let text = read_text(&resolve(dir, &name)?)?;
    Ok(Some((name, parse(&text).vars())))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "# Configuration\n\
        export API_URL=https://api.example.com # prod\n\
        SECRET = \"a b \\\"c\\\"\\n\"\n\
        SINGLE='x#y $z'\n\
        \n\
        EMPTY=\n\
        MULTI=\"line1\n\
        line2\"\n\
        not a var\n\
        PLAIN=value#nocomment\n";

    #[test]
    fn round_trips_unchanged() {
        let doc = parse(SAMPLE);
        assert_eq!(serialize(&doc), SAMPLE);
        let crlf = SAMPLE.replace('\n', "\r\n");
        assert_eq!(serialize(&parse(&crlf)), crlf);
        let no_final = "A=1\nB=2";
        assert_eq!(serialize(&parse(no_final)), no_final);
        assert_eq!(serialize(&parse("")), "");
    }

    #[test]
    fn decodes_values() {
        let doc = parse(SAMPLE);
        let vars = doc.vars();
        let get = |k: &str| {
            vars.iter()
                .find(|(key, _)| key == k)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("API_URL"), Some("https://api.example.com"));
        assert_eq!(get("SECRET"), Some("a b \"c\"\n"));
        assert_eq!(get("SINGLE"), Some("x#y $z"));
        assert_eq!(get("EMPTY"), Some(""));
        assert_eq!(get("MULTI"), Some("line1\nline2"));
        assert_eq!(get("PLAIN"), Some("value#nocomment"));
        assert_eq!(vars.len(), 6);
    }

    #[test]
    fn edits_preserve_comments_order_and_quotes() {
        let mut doc = parse(SAMPLE);
        let updates = vec![
            EnvUpdate {
                index: Some(0),
                key: "API_URL".into(),
                value: "http://localhost:3000".into(),
            },
            EnvUpdate {
                index: Some(1),
                key: "TOKEN".into(),
                value: "a b \"c\"\n".into(),
            }, // renommée
            EnvUpdate {
                index: Some(2),
                key: "SINGLE".into(),
                value: "it's".into(),
            }, // ' impossible en simple
            // EMPTY (3) supprimée
            EnvUpdate {
                index: Some(4),
                key: "MULTI".into(),
                value: "line1\nline2".into(),
            },
            EnvUpdate {
                index: Some(5),
                key: "PLAIN".into(),
                value: "has space".into(),
            },
            EnvUpdate {
                index: None,
                key: "NEW_KEY".into(),
                value: "new".into(),
            },
        ];
        doc.apply(&updates).unwrap();
        let out = serialize(&doc);
        assert_eq!(
            out,
            "# Configuration\n\
            export API_URL=http://localhost:3000 # prod\n\
            TOKEN = \"a b \\\"c\\\"\\n\"\n\
            SINGLE=\"it's\"\n\
            \n\
            MULTI=\"line1\n\
            line2\"\n\
            not a var\n\
            PLAIN=\"has space\"\n\
            NEW_KEY=new\n"
        );
        // Relu à l'identique.
        let again = parse(&out);
        assert_eq!(serialize(&again), out);
        assert_eq!(
            again.vars().iter().find(|(k, _)| k == "SINGLE").unwrap().1,
            "it's"
        );
    }

    #[test]
    fn encoded_values_round_trip() {
        for value in [
            "",
            "simple",
            "with space",
            "q\"uote",
            "back\\slash",
            "new\nline",
            "#hash",
            "'single'",
            "tab\there",
        ] {
            for quote in [Quote::None, Quote::Single, Quote::Double, Quote::Backtick] {
                let (raw, _) = encode_value(value, quote);
                let doc = parse(&format!("K={raw}\n"));
                assert_eq!(
                    doc.vars(),
                    vec![("K".to_string(), value.to_string())],
                    "{value:?} / {quote:?} → {raw}"
                );
            }
        }
    }

    #[test]
    fn rejects_bad_updates() {
        let mut doc = parse("A=1\nB=2\n");
        let dup = vec![
            EnvUpdate {
                index: Some(0),
                key: "A".into(),
                value: "1".into(),
            },
            EnvUpdate {
                index: None,
                key: "A".into(),
                value: "2".into(),
            },
        ];
        assert!(doc.apply(&dup).is_err());
        assert!(
            doc.apply(&[EnvUpdate {
                index: None,
                key: "1BAD".into(),
                value: String::new()
            }])
            .is_err()
        );
        assert!(
            doc.apply(&[EnvUpdate {
                index: Some(9),
                key: "A".into(),
                value: String::new()
            }])
            .is_err()
        );
    }

    #[test]
    fn validates_file_names() {
        for ok in [
            ".env",
            ".env.local",
            ".env.development.local",
            ".env.example",
            ".env.staging",
        ] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in [
            "env",
            ".envrc",
            ".env.",
            ".env..x",
            ".env/../x",
            "..\\.env",
            ".env.a/b",
            ".env.a\\b",
            "../.env",
            ".env. x",
        ] {
            assert!(!valid_name(bad), "{bad}");
        }
        assert!(is_example(".env.example"));
        assert!(!is_example(".env.local"));
    }

    #[test]
    fn saves_atomically_and_lists_missing_keys() {
        let dir = std::env::temp_dir().join(format!("devcenter-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".env.example"), "A=\nB=\nC=\n").unwrap();
        std::fs::write(dir.join(".env"), "# c\nA=1\n").unwrap();
        assert_eq!(
            list_names(&dir),
            vec![".env".to_string(), ".env.example".to_string()]
        );

        let file = read(&dir, ".env").unwrap();
        assert_eq!(file.missing, vec!["B".to_string(), "C".to_string()]);
        let saved = save(
            &dir,
            ".env",
            &file.revision,
            &[
                EnvUpdate {
                    index: Some(0),
                    key: "A".into(),
                    value: "2".into(),
                },
                EnvUpdate {
                    index: None,
                    key: "B".into(),
                    value: "x y".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(saved.missing, vec!["C".to_string()]);
        assert_eq!(
            std::fs::read_to_string(dir.join(".env")).unwrap(),
            "# c\nA=2\nB=\"x y\"\n"
        );
        assert!(save(&dir, ".env", &file.revision, &[]).is_err()); // révision périmée
        assert!(read(&dir, "../.env").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
