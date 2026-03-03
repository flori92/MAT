# Architecture cible

## Objectif

Construire une extension manga/manhwa :

- rapide sur les sites reels
- robuste aux CORS et protections de lecteurs
- sans secret provider dans le navigateur
- avec un vrai pipeline OCR specialise manga
- avec traduction contextuelle et memoire de chapitre

## Vue d'ensemble

### 1. Extension Chromium

Responsabilites :

- detecter le lecteur et la vraie image affichee
- capturer les cas `img`, `srcset`, `blob:`, lazy-load, canvas
- appliquer le rendu FR
- appeler uniquement le backend metier

### 2. Gateway API

Responsabilites :

- auth extension -> backend
- rate limiting
- cache de traduction
- orchestration OCR
- memoire de contexte
- routing vers translateurs et providers vision de secours

### 3. OCR Pipeline Python

Responsabilites :

- detection de texte multi-moteurs
- fusion et arbitrage de blocs
- raffinement avec recognizer specialise manga
- retour de blocs normalises

### 4. Data plane

- glossaires par oeuvre / personnage
- adaptateurs lecteurs par domaine
- historique de jobs
- observabilite et traces

## Stack OCR recommande

### Coeur

- `PaddleOCR` pour le premier passage de detection/reco
- `docTR` comme fallback tertiaire
- `MangaOCR` comme raffinement sur crops individuels

### Ce qui ne doit pas etre le coeur de prod

- `WORD-pytorch` : reference experimentale
- `manga_text_bubble_detect_translate` : inspiration pipeline, pas dependance centrale

## Pipeline recommande

1. l'extension recupere l'image effective du lecteur
2. le gateway envoie l'image au pipeline OCR Python
3. le pipeline lance `PaddleOCR`
4. il utilise `docTR` pour cartouches et narration propres
5. il raffine les crops japonais avec `MangaOCR`
6. le gateway traduit les blocs avec contexte/glossaire
7. l'extension compose et affiche le rendu FR

## Infra ideale

### Edge + orchestration

- API edge : Cloudflare Workers
- etat coherent par utilisateur/chapitre : Durable Objects
- cache global chaud : KV
- blobs et artefacts : R2
- retries/jobs asynchrones : Queues

### Donnees durables

- Neon Postgres pour utilisateurs, series, glossaires, adaptateurs, quotas, telemetry metier
- branching Neon pour environnements `dev`, `staging`, benchmarks OCR et tests de glossaires
- Hyperdrive si l'API edge tourne sur Cloudflare

### OCR lourd

- workers Python separes pour les engines OCR
- profil CPU pour Paddle/docTR
- profil GPU optionnel si vous poussez plus tard des models vision plus lourds dans des workers separes

### Observabilite

- Sentry pour erreurs, traces, performance et appels provider

## Strategie d'adaptateurs lecteurs

Chaque adaptateur doit definir :

- domaines supportes
- racines de lecteur
- selecteurs image
- resolution `src/srcset/data-src`
- cas `blob:`
- cas `canvas`
- regles de scroll/hydration si necessaire

## Phases conseillees

### Phase 1

- extension + gateway + pipeline OCR local
- tests sur sites Madara, Toonily-like, webtoon-like

### Phase 2

- deploiement edge
- auth
- cache distribue
- memoire/glossaire persistant
- Neon comme source durable principale

### Phase 3

- adaptateurs pilotes depuis la base
- scoring OCR par domaine
- modele de traduction specialise par oeuvre/personnage
