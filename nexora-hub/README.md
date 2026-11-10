# NEXORA Hub — Control Center 24/7

Dashboard unique "one-stop-shop" pour NEXORA : chatbox central + panneaux de
contrôle (portefeuille, réseaux sociaux, opérations, routeur IA), installable
en PWA sur iPhone/Mac via Tailscale, avec routage IA à deux niveaux (gratuit
par défaut, Claude Pro en fallback pour les tâches complexes).

Zéro dépendance runtime (`node:http`, `node:fs`, `node:path`, `node:url`,
`fetch` global) — Node ≥ 18 suffit, en local comme en conteneur.

## Architecture

```
┌─────────────────────────┐   HTTP/SSE   ┌──────────────────────────┐
│  Browser / PWA (iPhone,  │─────────────▶│  nexora-hub (server.js)  │
│  Mac, via Tailscale)     │◀─────────────│  :3001 (ou $PORT)        │
└─────────────────────────┘               └───────────┬──────────────┘
                                                        │ /api/chat → LiteLLM
                                                        ▼
                                           ┌──────────────────────────┐
                                           │ LiteLLM proxy :31140      │
                                           │ (launchd, host-run)       │
                                           │  nexora-free  → Groq /    │
                                           │                 Gemini /  │
                                           │                 Ollama    │
                                           │  nexora-pro   → Claude    │
                                           └──────────────────────────┘
```

Le Hub choisit lui-même l'alias `nexora-free` ou `nexora-pro` (voir
`pickModel()` dans `server.js`) ; LiteLLM ne fait que load-balancer et
basculer entre fournisseurs à l'intérieur de chaque niveau (voir
`../litellm-config.yaml`).

## Lancer en local (sans Docker)

```bash
cd nexora-hub
PORT=3001 \
LITELLM_BASE_URL=http://127.0.0.1:31140 \
LITELLM_MASTER_KEY=sk-nexora-local-1234 \
node server.js
```

Prérequis : le proxy LiteLLM doit déjà tourner (démon launchd existant,
`launchd/start-litellm.sh`, port 31140).

## Lancer via Docker Compose (ajout additif)

Un service `nexora-hub` a été ajouté au `docker-compose.yml` racine, **sans
toucher** aux services `openclaw-gateway` / `openclaw-cli` existants (approche
hybride : démons launchd pour Ollama/LiteLLM sur l'hôte + Hub en conteneur).

```bash
cd /Users/halimbelkacem/Halim-AI
docker compose build nexora-hub
docker compose up -d nexora-hub
```

Le conteneur atteint le LiteLLM hôte via `host.docker.internal:31140`
(mapping `extra_hosts: host.docker.internal:host-gateway`, nécessaire sous
Linux Docker Engine — automatique sous Docker Desktop macOS).

Variables surchargeable via `.env` à la racine : `NEXORA_HUB_PORT` (port
publié, défaut `3001`), `LITELLM_BASE_URL`, `LITELLM_MASTER_KEY`.

## Commandes de test final

```bash
# 1. Santé du serveur
curl -s http://localhost:3001/healthz | python3 -m json.tool

# 2. Statut du routeur IA (modèle actif, niveau, coût estimé)
curl -s http://localhost:3001/api/router/status | python3 -m json.tool

# 3. Chat (streaming SSE) — niveau auto
curl -N -s http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Dis bonjour en une phrase."}],"tier":"auto"}'

# 4. Forcer le niveau Pro (Claude)
curl -N -s http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Analyse stratégique en 3 points."}],"tier":"pro"}'

# 5. Widgets du dashboard
curl -s http://localhost:3001/api/widgets/github  | python3 -m json.tool
curl -s http://localhost:3001/api/widgets/reddit  | python3 -m json.tool
curl -s http://localhost:3001/api/widgets/finance | python3 -m json.tool
curl -s http://localhost:3001/api/widgets/social  | python3 -m json.tool
curl -s http://localhost:3001/api/widgets/team    | python3 -m json.tool

# 6. PWA : manifest + service worker servis correctement
curl -sI http://localhost:3001/manifest.json | head -1
curl -sI http://localhost:3001/sw.js         | head -1
```

Tous doivent renvoyer `200 OK`. `/api/chat` doit streamer des tokens (SSE) ;
si LiteLLM n'est pas joignable, le Hub renvoie une erreur explicite au lieu
de bloquer silencieusement.

## Installation PWA (iPhone / Mac via Tailscale)

1. Démarrer le Hub (local ou Docker) et vérifier qu'il est joignable sur le
   nom Tailscale de la machine (ex. `http://mac-de-halim.tailXXXX.ts.net:3001`).
2. Sur iPhone (Safari) : ouvrir l'URL Tailscale → bouton Partager → **Sur
   l'écran d'accueil**. L'icône NEXORA (192/512px) et le mode standalone
   (sans barre d'adresse) sont déjà configurés via `manifest.json`.
3. Sur Mac (Chrome/Edge) : ouvrir l'URL → icône d'installation dans la barre
   d'adresse → **Installer**.
4. Le service worker (`sw.js`) met en cache le shell statique (HTML/CSS/JS/
   icônes) pour un chargement instantané ; les appels `/api/*` et `/healthz`
   ne sont **jamais** interceptés, donc le streaming et les données live du
   dashboard restent toujours à jour.

## Équipe Utrecht — Disponibilité (widget team)

Le panneau **"Équipe Utrecht — Disponibilité"** du dashboard (`#widgetTeam`,
route `/api/widgets/team`) est un **miroir en lecture seule** du Google Sheet
*"TEAM AVAILABILITY MANAGEMENT SYSTEM"* :

```
https://docs.google.com/spreadsheets/d/1ikUvLkxX45taYpzC_Ams4BRWNjCelzfu6w9O742QT5Y
```

### Modèle d'autorité : Google Apps Script reste maître

**Google Apps Script v6.8** (déployé dans le Sheet) reste la **seule
source de vérité** et le **seul moteur d'automatisation** — nexora-hub ne
lit jamais ni n'écrit jamais directement dans le Sheet pendant son
fonctionnement normal. Le Hub se contente de lire un instantané JSON statique
en cache : `public/data/team-availability.json`, régénéré périodiquement (voir
plus bas). Toute logique de verrouillage, de reset hebdomadaire, de rappel ou
d'envoi d'e-mail continue de vivre exclusivement côté Apps Script.

Onglets du classeur : `Sheet1` (grille de disponibilité hebdomadaire),
`vaction plan` et `Copy of vaction plan` (planning des congés).

**Managers** :

| Nom | Rôle | Email |
|---|---|---|
| Belkacem Halim | TL | halimbelkacem27@gmail.com |
| Storozhuk Natalia | STL | Storozhuk.natasha0333@gmail.com |

### Déclencheurs Apps Script (dans le Sheet, inchangés)

| Trigger | Quand | Rôle |
|---|---|---|
| `resetSchedule` | Lundi 09:00 | Nouvelle semaine : reset des colonnes Lundi→Dimanche + Pourcentage, lève les protections de lignes, envoie les e-mails du lundi |
| `sendSaturdayReminder` | Samedi 10:00 | Relance les employés n'ayant pas encore rempli leur disponibilité |
| `lockSchedule` | Samedi 16:00 | Calcule les pourcentages finaux, protège les lignes, envoie le rapport final aux managers |
| `autoDeleteSentEmails` | Dimanche 22:00 | Nettoie les e-mails `[AUTO]` envoyés, rapporte le total aux managers |

### Synchronisation nexora-hub (cache JSON côté Hub)

Deux tâches planifiées Cowork maintiennent `public/data/team-availability.json`
à jour, calées juste après les deux moments clés du Sheet :

| Tâche planifiée | Horaire (heure locale) | Déclenche après |
|---|---|---|
| `nexora-team-availability-sync-monday` | Lundi 09:15 | `resetSchedule` (09:00) — grille fraîche, normal qu'elle soit quasi vide |
| `nexora-team-availability-sync` | Samedi 16:30 | `lockSchedule` (16:00) — grille finale verrouillée de la semaine |

Chaque exécution relit le Sheet onglet par onglet (jamais un export complet du
classeur en un seul appel, pour éviter toute troncature silencieuse),
reconstruit le JSON dans le schéma existant (`generatedAt`, `source`, `week`,
`managers`, `employees`, `vacationPlan`, `automation`), valide le résultat et
**n'écrase jamais** le fichier existant si la lecture semble incomplète.

Gérer ces tâches : `mcp__scheduled-tasks__list_scheduled_tasks` /
`update_scheduled_task` (ou l'équivalent dans l'UI Cowork).

## Statut des tâches de déploiement

- [x] `litellm-config.yaml` — routage gratuit en priorité, Claude en fallback
- [x] Backend `nexora-hub` (serveur, routage, proxy SSE, widgets)
- [x] Frontend unifié (chat + dashboard à panneaux)
- [x] PWA (manifest, icônes, meta tags, service worker enregistré)
- [x] Dockerfile + service `docker-compose.yml` (ajout additif)
- [x] Commandes de test final + documentation (ce fichier)
- [x] Widget "Équipe Utrecht — Disponibilité" (miroir lecture seule du Sheet + vacation plan)
- [x] Synchronisation automatique du cache JSON (2 tâches planifiées Cowork, lundi/samedi)
