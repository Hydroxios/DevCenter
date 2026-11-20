//! Détection du type de projet, des frameworks, du gestionnaire de paquets et des scripts.

use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Script {
    pub name: String,
    pub command: String,
    /// Groupe de la tâche (Gradle) : « Build », « Verification », groupes du projet…
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    /// Écosystèmes : Node, Rust, Python, Go, PHP, Java, Kotlin.
    pub languages: Vec<String>,
    pub frameworks: Vec<String>,
    pub package_manager: Option<String>,
    /// Scripts `package.json`, ou tâches Gradle courantes (seuls scripts exécutables depuis DevCenter).
    pub scripts: Vec<Script>,
    pub has_git: bool,
    /// Faux tant que les tâches Gradle réelles n'ont pas été lues (`scripts` est alors une estimation).
    pub tasks_loaded: bool,
}

/// Fichiers qui signalent la racine d'un projet.
pub const PROJECT_MARKERS: &[&str] = &[
    ".git",
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "composer.json",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "pom.xml",
];

/// Plugin ou dépendance Gradle → framework affiché.
const GRADLE_FRAMEWORKS: &[(&str, &str)] = &[
    ("org.springframework.boot", "Spring Boot"),
    ("com.android.application", "Android"),
    ("com.android.library", "Android"),
    ("io.ktor", "Ktor"),
    ("io.quarkus", "Quarkus"),
    ("io.micronaut", "Micronaut"),
    ("org.jetbrains.compose", "Compose"),
    ("fabric-loom", "Fabric"),
    ("net.minecraftforge", "Forge"),
    ("net.neoforged", "NeoForge"),
    ("io.papermc", "Paper"),
    ("javafx", "JavaFX"),
];

/// Fichiers Gradle lus : racine et module `app/` (projets Android).
const GRADLE_FILES: &[&str] = &[
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "app/build.gradle",
    "app/build.gradle.kts",
    "gradle/libs.versions.toml",
];

pub fn is_project_dir(dir: &Path) -> bool {
    PROJECT_MARKERS.iter().any(|m| dir.join(m).exists())
}

/// Dépendance npm → nom affiché. L'ordre définit l'ordre d'affichage.
const NODE_FRAMEWORKS: &[(&str, &str)] = &[
    ("next", "Next.js"),
    ("nuxt", "Nuxt"),
    ("@sveltejs/kit", "SvelteKit"),
    ("astro", "Astro"),
    ("@remix-run/react", "Remix"),
    ("@angular/core", "Angular"),
    ("expo", "Expo"),
    ("react-native", "React Native"),
    ("react", "React"),
    ("vue", "Vue"),
    ("svelte", "Svelte"),
    ("solid-js", "Solid"),
    ("@nestjs/core", "NestJS"),
    ("express", "Express"),
    ("fastify", "Fastify"),
    ("hono", "Hono"),
    ("electron", "Electron"),
    ("@tauri-apps/api", "Tauri"),
    ("vite", "Vite"),
    ("tailwindcss", "Tailwind"),
    ("prisma", "Prisma"),
];

fn push_unique(list: &mut Vec<String>, value: &str) {
    if !list.iter().any(|v| v == value) {
        list.push(value.to_string());
    }
}

fn read(dir: &Path, file: &str) -> Option<String> {
    std::fs::read_to_string(dir.join(file)).ok()
}

pub fn detect(dir: &Path) -> ProjectMeta {
    let mut meta = ProjectMeta {
        has_git: dir.join(".git").exists(),
        tasks_loaded: true,
        ..Default::default()
    };

    if let Some(text) = read(dir, "package.json") {
        push_unique(&mut meta.languages, "Node");
        if let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&text) {
            let has_dep = |name: &str| {
                ["dependencies", "devDependencies", "peerDependencies"]
                    .iter()
                    .any(|k| pkg.get(k).and_then(|d| d.get(name)).is_some())
            };
            for (dep, label) in NODE_FRAMEWORKS {
                if has_dep(dep) {
                    push_unique(&mut meta.frameworks, label);
                }
            }
            if has_dep("typescript") || dir.join("tsconfig.json").exists() {
                push_unique(&mut meta.languages, "TypeScript");
            }
            if let Some(scripts) = pkg.get("scripts").and_then(|s| s.as_object()) {
                meta.scripts = scripts
                    .iter()
                    .filter_map(|(k, v)| {
                        v.as_str().map(|c| Script {
                            name: k.clone(),
                            command: c.to_string(),
                            group: None,
                        })
                    })
                    .collect();
            }
            // Champ `packageManager` (Corepack) : prioritaire sur les fichiers de verrouillage.
            if let Some(pm) = pkg.get("packageManager").and_then(|v| v.as_str()) {
                let name = pm.split('@').next().unwrap_or("");
                if ["pnpm", "npm", "yarn", "bun"].contains(&name) {
                    meta.package_manager = Some(name.to_string());
                }
            }
        }
        if meta.package_manager.is_none() {
            meta.package_manager = Some(
                if dir.join("pnpm-lock.yaml").exists() {
                    "pnpm"
                } else if dir.join("yarn.lock").exists() {
                    "yarn"
                } else if dir.join("bun.lockb").exists() || dir.join("bun.lock").exists() {
                    "bun"
                } else {
                    "npm"
                }
                .to_string(),
            );
        }
    }

    let cargo = read(dir, "Cargo.toml").or_else(|| read(dir, "src-tauri/Cargo.toml"));
    if let Some(text) = cargo {
        push_unique(&mut meta.languages, "Rust");
        for (dep, label) in [
            ("tauri", "Tauri"),
            ("axum", "Axum"),
            ("actix-web", "Actix"),
            ("bevy", "Bevy"),
        ] {
            if text.contains(dep) {
                push_unique(&mut meta.frameworks, label);
            }
        }
        if meta.package_manager.is_none() {
            meta.package_manager = Some("cargo".into());
        }
    }

    let python = [read(dir, "pyproject.toml"), read(dir, "requirements.txt")]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    if !python.is_empty() {
        push_unique(&mut meta.languages, "Python");
        let all = python.join("\n").to_lowercase();
        for (dep, label) in [
            ("django", "Django"),
            ("fastapi", "FastAPI"),
            ("flask", "Flask"),
        ] {
            if all.contains(dep) {
                push_unique(&mut meta.frameworks, label);
            }
        }
        if meta.package_manager.is_none() {
            meta.package_manager = Some(
                if dir.join("uv.lock").exists() {
                    "uv"
                } else if dir.join("poetry.lock").exists() {
                    "poetry"
                } else {
                    "pip"
                }
                .into(),
            );
        }
    }

    if dir.join("go.mod").exists() {
        push_unique(&mut meta.languages, "Go");
        meta.package_manager.get_or_insert_with(|| "go".into());
    }

    let gradle: Vec<(&str, String)> = GRADLE_FILES
        .iter()
        .filter_map(|f| read(dir, f).map(|t| (*f, t)))
        .collect();
    if gradle.iter().any(|(f, _)| !f.ends_with(".toml")) {
        detect_gradle(dir, &gradle, &mut meta);
    } else if let Some(text) = read(dir, "pom.xml") {
        push_unique(&mut meta.languages, "Java");
        if text.contains("kotlin-maven-plugin") {
            push_unique(&mut meta.languages, "Kotlin");
        }
        if text.contains("spring-boot") {
            push_unique(&mut meta.frameworks, "Spring Boot");
        }
        if text.contains("quarkus") {
            push_unique(&mut meta.frameworks, "Quarkus");
        }
        meta.package_manager.get_or_insert_with(|| "maven".into());
    }

    if let Some(text) = read(dir, "composer.json") {
        push_unique(&mut meta.languages, "PHP");
        if text.contains("laravel/framework") {
            push_unique(&mut meta.frameworks, "Laravel");
        }
        meta.package_manager
            .get_or_insert_with(|| "composer".into());
    }

    meta
}

fn detect_gradle(dir: &Path, files: &[(&str, String)], meta: &mut ProjectMeta) {
    let all = files
        .iter()
        .map(|(_, t)| t.as_str())
        .collect::<Vec<_>>()
        .join(
            "
",
        );
    let kotlin = all.contains("kotlin(\"jvm\")")
        || all.contains("org.jetbrains.kotlin")
        || all.contains("kotlin-android")
        || dir.join("src/main/kotlin").is_dir()
        || dir.join("app/src/main/kotlin").is_dir();
    let java = dir.join("src/main/java").is_dir()
        || dir.join("app/src/main/java").is_dir()
        || all.contains("java");
    if java || !kotlin {
        push_unique(&mut meta.languages, "Java");
    }
    if kotlin {
        push_unique(&mut meta.languages, "Kotlin");
    }
    for (needle, label) in GRADLE_FRAMEWORKS {
        if all.contains(needle) {
            push_unique(&mut meta.frameworks, label);
        }
    }
    push_unique(&mut meta.frameworks, "Gradle");

    // Les tâches ne sont proposées que si aucun package.json ne fournit déjà de scripts.
    if meta.package_manager.is_some() {
        return;
    }
    meta.package_manager = Some("gradle".into());
    if let Some(tasks) = super::gradle::cached(dir) {
        meta.scripts = tasks;
        return;
    }
    // Estimation en attendant `gradlew tasks --all` (voir `gradle::load`).
    meta.tasks_loaded = false;
    let has = |label: &str| meta.frameworks.iter().any(|f| f == label);
    let mut tasks: Vec<(&str, &str)> = Vec::new();
    if has("Spring Boot") {
        tasks.push(("bootRun", "Lance l'application Spring Boot"));
    }
    if has("Android") {
        tasks.push(("assembleDebug", "Construit l'APK de debug"));
        tasks.push(("installDebug", "Installe l'APK sur l'appareil connecté"));
    }
    if has("Fabric") || has("Forge") || has("NeoForge") {
        tasks.push(("runClient", "Lance le client Minecraft de développement"));
        tasks.push(("runServer", "Lance le serveur Minecraft de développement"));
    }
    if has("Paper") && all.contains("run-paper") {
        tasks.push(("runServer", "Lance un serveur Paper de test"));
    }
    if has("Ktor")
        || has("Compose")
        || ["\"application\"", "'application'", "`application`"]
            .iter()
            .any(|p| all.contains(p))
    {
        tasks.push(("run", "Lance l'application"));
    }
    if has("Quarkus") {
        tasks.push(("quarkusDev", "Mode développement Quarkus"));
    }
    tasks.extend([
        ("build", "Compile et teste"),
        ("test", "Lance les tests"),
        ("clean", "Supprime les sorties de build"),
    ]);
    let wrapper = dir.join("gradlew").exists() || dir.join("gradlew.bat").exists();
    let exe = if wrapper { "gradlew" } else { "gradle" };
    for (task, about) in tasks {
        if !meta.scripts.iter().any(|s| s.name == task) {
            meta.scripts.push(Script {
                name: task.into(),
                command: format!("{exe} {task} · {about}"),
                group: None,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_this_repository() {
        // Le dépôt DevCenter lui-même : pnpm + React + Tauri + Rust.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let meta = detect(root);
        assert_eq!(meta.package_manager.as_deref(), Some("pnpm"));
        assert!(meta.frameworks.contains(&"React".to_string()));
        assert!(meta.frameworks.contains(&"Tauri".to_string()));
        assert!(meta.languages.contains(&"Rust".to_string()));
        assert!(meta.scripts.iter().any(|s| s.name == "dev"));
    }

    #[test]
    fn detects_gradle_projects() {
        let dir = std::env::temp_dir().join(format!("devcenter-gradle-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src/main/kotlin")).unwrap();
        std::fs::write(
            dir.join("build.gradle.kts"),
            "plugins {
  kotlin(\"jvm\") version \"2.0.0\"
  id(\"org.springframework.boot\") version \"3.3.0\"
}
",
        )
        .unwrap();
        std::fs::write(dir.join("gradlew.bat"), "").unwrap();
        assert!(is_project_dir(&dir));
        let meta = detect(&dir);
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(meta.package_manager.as_deref(), Some("gradle"));
        assert!(meta.languages.contains(&"Kotlin".to_string()));
        assert!(meta.frameworks.contains(&"Spring Boot".to_string()));
        assert_eq!(
            meta.scripts.first().map(|s| s.name.as_str()),
            Some("bootRun")
        );
        assert!(
            meta.scripts
                .iter()
                .any(|s| s.name == "build" && s.command.starts_with("gradlew build"))
        );
    }
}
