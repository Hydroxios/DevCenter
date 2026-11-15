//! Lancement de programmes externes (git, gestionnaires de paquets, éditeur).

use std::ffi::OsStr;
use std::path::PathBuf;
use std::process::Command;

/// Crée une commande qui n'ouvre pas de fenêtre console sous Windows.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Ouvre un terminal externe dans `dir` : Windows Terminal s'il est installé, sinon PowerShell.
pub fn open_terminal(dir: &std::path::Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Some(wt) = which(&["wt.exe"]) {
            // `-d` : dossier de départ du nouvel onglet.
            return Command::new(wt).arg("-d").arg(dir).spawn().map(|_| ());
        }
        // Programme console : il lui faut sa propre fenêtre (pas CREATE_NO_WINDOW).
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let shell = which(&["pwsh.exe"]).map(|p| p.into_os_string()).unwrap_or_else(|| "powershell.exe".into());
        Command::new(shell).arg("-NoLogo").current_dir(dir).creation_flags(CREATE_NEW_CONSOLE).spawn().map(|_| ())
    }
    #[cfg(not(windows))]
    {
        let term = std::env::var("TERMINAL").unwrap_or_else(|_| "x-terminal-emulator".into());
        Command::new(term).current_dir(dir).spawn().map(|_| ())
    }
}

/// Cherche un exécutable dans le PATH (premier nom trouvé).
pub fn which(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}

/// Nom de l'exécutable d'un gestionnaire de paquets sur la plateforme courante.
pub fn package_manager_program(pm: &str) -> Option<&'static str> {
    let windows = cfg!(windows);
    Some(match pm {
        "pnpm" if windows => "pnpm.cmd",
        "npm" if windows => "npm.cmd",
        "yarn" if windows => "yarn.cmd",
        "bun" if windows => "bun.exe",
        "pnpm" => "pnpm",
        "npm" => "npm",
        "yarn" => "yarn",
        "bun" => "bun",
        _ => return None,
    })
}

/// Gradle d'un projet : le wrapper `gradlew` du dossier en priorité, sinon `gradle` du PATH.
pub fn gradle_program(dir: &std::path::Path) -> Option<PathBuf> {
    let wrapper = dir.join(if cfg!(windows) { "gradlew.bat" } else { "gradlew" });
    if wrapper.is_file() {
        return Some(wrapper);
    }
    which(if cfg!(windows) { &["gradle.bat", "gradle.cmd", "gradle.exe"] } else { &["gradle"] })
}

/// Supprime les séquences d'échappement ANSI (couleurs, curseur) d'une ligne de log.
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    // CSI : paramètres jusqu'à une lettre finale.
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // OSC : jusqu'à BEL ou ESC \
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' {
                            break;
                        }
                        if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {
                    chars.next();
                }
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_sequences() {
        assert_eq!(strip_ansi("\u{1b}[32m✓\u{1b}[39m ready\r"), "✓ ready");
        assert_eq!(strip_ansi("\u{1b}]8;;http://x\u{7}lien\u{1b}]8;;\u{7}"), "lien");
    }
}

#[cfg(test)]
mod machine_tests {
    use super::*;

    /// Vérifie qu'un gestionnaire de paquets `.cmd` se lance sans passer par un shell.
    #[test]
    fn spawns_package_manager_cmd() {
        if which(&["pnpm.cmd", "pnpm"]).is_none() {
            return; // pnpm absent sur cette machine
        }
        let out = command(package_manager_program("pnpm").unwrap()).arg("--version").output().unwrap();
        assert!(out.status.success());
        eprintln!("pnpm {}", String::from_utf8_lossy(&out.stdout).trim());
        eprintln!("éditeur détecté : {:?}", crate::modules::editor::detect());
    }
}
