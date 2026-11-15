# DevCenter

Application desktop (Tauri 2 + React + TypeScript) : centre de contrôle pour développeur — projets, monitoring système, serveurs et automatisation.

## Démarrer

```bash
pnpm install
pnpm tauri dev
```

- `pnpm dev` seul lance l'interface dans un navigateur (sans les commandes Rust).
- `cd src-tauri && cargo test` lance les tests du backend.
- Builds de dev allégés (pas de cache incrémental, pas de symboles pour les dépendances, crate `rlib` uniquement) pour limiter l'espace disque.

## État de la roadmap

**Phase 1 — Fondations : faite**

- Tauri 2 + React 19 + TypeScript + Vite
- Tailwind CSS v4 + composants style shadcn/ui (`components.json` configuré : `pnpm dlx shadcn@latest add <composant>`)
- Sidebar + navigation (`react-router`, registre dans `src/app/navigation.ts`)
- Thème clair / sombre / système et paramètres persistants (SQLite)
- SQLite (`rusqlite`, fichier `devcenter.db` dans le dossier de données de l'app, migrations versionnées)
- Couche de services Rust (`modules/`) + commandes IPC fines (`commands/`)
- Icône dans la barre système, réduction dans la barre à la fermeture, instance unique
- Dashboard CPU / RAM / disques / uptime en temps réel (`sysinfo`)

**Phase 2 — System Manager : faite**

- GPU (modèle, utilisation, VRAM) et températures (souvent vides sous Windows sans droits administrateur)
- Liste des processus : recherche, tri, rafraîchissement toutes les 2 s (uniquement quand la fenêtre est visible)
- Arrêt de processus avec confirmation ; Rust vérifie l'heure de démarrage (PID non réattribué) et refuse les processus système critiques et DevCenter lui-même
- Lancement d'applications : raccourcis `.exe` / `.lnk` choisis via l'explorateur et enregistrés en SQLite ; le frontend ne peut lancer qu'un raccourci enregistré, jamais un chemin libre

**Phase 3 — Project Manager : faite**

- Ajout manuel (sélection de dossiers) et détection automatique dans un répertoire (4 niveaux, ignore `node_modules`, `target`, dossiers cachés…)
- Détection des langages, frameworks (Next.js, React, Vue, Svelte, Astro, Tauri, NestJS, Django…) et du gestionnaire de paquets (`packageManager` puis fichiers de verrouillage)
- Ouverture dans l'éditeur : Cursor puis VS Code détectés automatiquement, ou exécutable choisi dans Paramètres
- Git (CLI) : branche, avance/retard, fichiers indexés/modifiés/non suivis, dernier commit
- Scripts npm/pnpm/yarn/bun : lancement, logs en direct, URL locale détectée (`http://localhost:…`), arrêt de tout l'arbre de processus ; tous les scripts sont arrêtés à la fermeture de DevCenter

**Phase 4 — Workspace Manager : faite**

- Profils de travail composés d'étapes ordonnées : ouvrir un projet dans l'éditeur, ouvrir son dossier, lancer un script (avec ouverture du navigateur quand le serveur est prêt), lancer une application, ouvrir une URL
- Démarrage en un clic : les étapes s'enchaînent, un échec n'arrête pas les suivantes et il est affiché
- Arrêt propre : tous les scripts de la session (arbre de processus) et les applications `.exe` marquées « fermer à l'arrêt » ; à la fermeture de DevCenter, les sessions sont clôturées
- Favoris (en tête de liste et démarrage rapide depuis le Dashboard) et historique des sessions (SQLite) ; une session restée ouverte après un arrêt brutal est marquée « interrompue »

Limite : une application qui se relance elle-même (Cursor, Chrome…) change de PID et ne peut pas être fermée automatiquement.

**Phase 5 — Server Manager : faite**

- Serveurs SSH enregistrés (nom, hôte ou alias `~/.ssh/config`, port, utilisateur, clé privée) ; statut en ligne + latence
- Connexion via le client OpenSSH de Windows : clés, agent et `~/.ssh/config` réutilisés ; **aucun mot de passe stocké**, authentification par clé (`BatchMode`) pour les commandes
- Monitoring distant (un seul aller-retour SSH toutes les 5 s) : CPU, charge, RAM, swap, disques, uptime, OS
- Terminal SSH intégré (xterm.js + ConPTY), conservé quand on change d'onglet, fermé avec DevCenter
- Services systemd : liste, démarrer / arrêter / redémarrer (`sudo -n`), logs `journalctl`
- Docker : conteneurs, démarrer / arrêter / redémarrer, logs

**Phase 6 — Automation Engine : faite**

- Déclencheurs : manuel, toutes les N minutes, chaque jour à heure fixe (jours choisis, rattrapage de 10 min), au démarrage de DevCenter
- Actions : démarrer/arrêter un workspace, lancer/arrêter un script, ouvrir éditeur/dossier/application/URL, notification Windows, pause, attente d'un port TCP
- Conditions « continuer seulement si… » : processus lancé, serveur joignable, workspace actif, port ouvert, CPU/RAM au-dessus d'un seuil, plage horaire (chacune inversable)
- Enchaînement, gestion d'erreur (arrêter ou continuer), durée maximale, une seule exécution simultanée par workflow
- Historique détaillé (étape par étape, durées) et bibliothèque de modèles (démarrer la journée, fin de journée, surveiller un serveur, relancer le serveur de dev, Docker puis workspace, alerte CPU)

**Phase 7 — Remote et extensions : en partie**

Fait :
- Tableau de bord mobile sur le réseau local (désactivé par défaut) : métriques, workspaces (démarrer/arrêter), automatisations (exécuter). Appairage par code à 6 chiffres (5 min, 5 essais, usage unique), jeton de 256 bits par appareil (seule son empreinte SHA-256 est stockée), révocation, adresses de réseau privé uniquement (LAN, Tailscale).
- Synchronisation optionnelle par fichier : export/import JSON de toute la configuration, sans secret, fusion sans doublons et réécriture des identifiants ; les automatisations importées arrivent désactivées. Le même mécanisme sert de « packs » de workflows et workspaces à partager.

- **Appli iPhone / Android (PWA)** : le tableau de bord mobile s'installe sur l'écran d'accueil (icône, plein écran) et reçoit des **notifications push** (iOS 16.4+) : échec d'automatisation, script qui plante, workspace démarré avec des erreurs, étapes « Notifier ». Chiffrement Web Push de bout en bout (RFC 8291, clés VAPID locales), envoi via `curl.exe`, services de push limités à Apple/Google/Mozilla/Microsoft.
- **HTTPS via Tailscale** (`tailscale serve`) : requis par iOS ; accès hors du Wi-Fi, réservé aux appareils du réseau Tailscale. Prérequis : activer « HTTPS Certificates » dans la console Tailscale (DNS).

Non fait (volontairement) :
- **Agent pour machines distantes** : les serveurs Linux sont gérés sans agent, via SSH (phase 5) ; un agent séparé n'apporterait que de la surface d'attaque pour l'instant.
- **Système de plugins exécutant du code** : demande un vrai modèle de sécurité (permissions, signature des plugins). Les packs JSON couvrent le partage de workflows sans exécuter de code tiers.

**Bêta — fiabilité et distribution : faite**

- Projets : ouvrir un terminal dans le dossier (Windows Terminal, sinon PowerShell), dernier commit cliquable (ouvre l'historique), branches (changer, créer depuis une autre), détection Gradle (Java/Kotlin, Spring Boot, Android, Paper, Fabric…) avec lecture des vraies tâches (`gradlew tasks --all`, en cache) et Maven
- Cache des données Git : statut relu quand le dépôt change (ou après 30 s), graphe relu quand les refs bougent, détail des commits gardé ; côté interface, projets affichés aussitôt depuis le dernier état connu
- Automatisations : étape « Requête HTTP » (méthode, en-têtes, corps, codes attendus) ; historique paginé (chargé au défilement)
- Interface : gabarit commun à toutes les pages (liste + détail, onglets), modales en fondu, icônes de l'application
- Écran d'erreur à la place d'un écran noir (par page, la navigation reste utilisable)
- Journal `devcenter.log` (3 × 2 Mo) : erreurs des commandes, de l'interface et plantages Rust ; Paramètres › À propos › Ouvrir le dossier
- Mises à jour automatiques signées depuis les Releases GitHub (vérification au démarrage puis toutes les 6 h, installation en un clic)

## Publier une version

1. Mettre la même version dans `package.json`, `src-tauri/Cargo.toml` et `src-tauri/tauri.conf.json`.
2. Secrets du dépôt GitHub (une seule fois) : `TAURI_SIGNING_PRIVATE_KEY` = contenu de la clé privée de signature, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = son mot de passe (vide si aucun).
3. `git tag v0.1.0 && git push --tags` : le workflow `Release` construit l'installeur signé et crée une Release en **brouillon** avec `latest.json`.
4. Relire puis publier le brouillon : les DevCenter installés proposent alors la mise à jour.

La clé privée de signature n'est **jamais** versionnée (`*.key` dans `.gitignore`). Sans elle, plus aucune mise à jour ne peut être publiée pour les installations existantes : la sauvegarder.

Build local de l'installeur : `pnpm tauri build` avec `TAURI_SIGNING_PRIVATE_KEY` défini (installeur dans `src-tauri/target/release/bundle/nsis/`).

## Architecture

```text
src/
├── app/navigation.ts        registre des modules (sidebar)
├── components/ui/           composants de base (shadcn/ui)
├── components/layout/       sidebar, layout, gabarit de page (Page.tsx)
├── components/ErrorBoundary écran d'erreur (au lieu d'un écran noir)
├── lib/logger.ts            envoi des erreurs de l'interface vers le journal
├── modules/<module>/        une page par module
├── hooks/                   useApplyTheme, usePolling
├── stores/                  état global (Zustand)
├── services/tauri.ts        SEUL point d'appel vers Rust (invoke typé)
└── types/                   miroir des structures Rust

src-tauri/src/
├── lib.rs                   bootstrap : plugins, état, tray, événements fenêtre
├── commands/                commandes IPC (aucune logique métier)
├── modules/<domaine>/       services métier (system, settings, …)
├── database/                connexion SQLite + migrations
├── state.rs                 AppState partagé
├── tray.rs                  barre système
└── error.rs                 AppError sérialisée vers le frontend
```

### Ajouter un module

1. Rust : `modules/<nom>/mod.rs` (service) → l'ajouter à `AppState` → commandes dans `commands/` → `generate_handler!` dans `lib.rs`.
2. Frontend : types dans `types/`, appels dans `services/tauri.ts`, page dans `modules/<nom>/`, entrée dans `app/navigation.ts` + route dans `App.tsx`.
3. Nouvelle table SQLite : ajouter une entrée **à la fin** de `MIGRATIONS` (`database/mod.rs`), ne jamais modifier une migration existante.

### Sécurité

- Le frontend ne peut appeler que les commandes listées dans `generate_handler!` ; les permissions Tauri sont limitées à `core:default`, `opener:default`, `dialog:allow-open` et `dialog:allow-save`.
- Accès à distance : HTTP non chiffré sur le réseau local ; à réserver à un réseau de confiance (ou Tailscale). Le pare-feu Windows doit l'autoriser sur les réseaux **privés** uniquement.
- Les objets GPU/capteurs (COM/WMI) vivent sur un thread dédié (`devcenter-hardware`) car ils ne peuvent pas changer de thread.
- `run_script` ne lance qu'un script déclaré dans le `package.json` du projet, via le gestionnaire de paquets détecté : aucune commande libre.
- SSH : hôte, utilisateur, noms de services et de conteneurs validés (pas d'option `-o…` déguisée, pas de métacaractères shell) puis cités ; commandes distantes construites à partir de modèles fixes ; première connexion en `StrictHostKeyChecking=accept-new` (une empreinte modifiée est refusée).
- `set_setting` n'accepte qu'une liste fermée de clés, avec des valeurs validées côté Rust.
- CSP stricte dans `tauri.conf.json`.
- Mises à jour : paquets signés (minisign) vérifiés par l'application avant installation ; seule la clé publique est dans le dépôt.
- Requêtes HTTP des automatisations : URL `http(s)` uniquement, en-têtes validés, passées à `curl.exe` sans shell (`--` avant l'URL).
