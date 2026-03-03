# Backend

Le backend est maintenant separe en deux couches :

- `server.mjs` : gateway HTTP pour l'extension
- `ocr-pipeline/` : service Python dedie a l'OCR manga

## Ce que fait le gateway

- auth extension -> backend
- traduction reseau
- cache de traduction
- orchestration OCR
- fallback Gemini/OpenAI vision seulement si le pipeline OCR local n'est pas disponible
- aucune cle API demandee aux utilisateurs finaux
- fallback de traduction publique active par defaut pour un premier usage sans cle API

## Ce que fait `ocr-pipeline`

- detection/reconnaissance locale multi-moteurs
- fusion de blocs OCR
- raffinement MangaOCR
- scoring de qualite et signal de fallback vision
- retour de blocs normalises au gateway

## Demarrage local

### 1. Gateway Node

```bash
cd backend
cp .env.example .env
npm start
```

`server.mjs` charge automatiquement `backend/.env` si le fichier existe.
Par defaut, le gateway vise `http://127.0.0.1:8788` comme pipeline OCR local.

### 2. Pipeline OCR Python

```bash
cd backend/ocr-pipeline
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8788
```

## Demarrage compose

```bash
cd backend
docker compose up --build
```

## Endpoints

- `GET /health`
- `GET /v1/ocr/engines`
- `POST /v1/translate`
- `POST /v1/ai-ocr`

## Variables utiles

- `BACKEND_AUTH_TOKEN`
- `OCR_PIPELINE_URL`
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `ENABLE_PUBLIC_TRANSLATION_FALLBACK`

## Recommandation de prod

- ne plus mettre de cle provider dans l'extension
- ne jamais demander de cle API aux utilisateurs finaux
- les clés eventuelles Gemini/OpenAI vivent uniquement sur votre backend
- pour un usage local immediat, garder `ENABLE_PUBLIC_TRANSLATION_FALLBACK=true`
- en production, remplacer progressivement ce fallback public par un moteur de traduction gere par votre backend
- utiliser le pipeline OCR local comme premiere source
- laisser le gateway arbitrer `PaddleOCR` + `docTR` + raffinement `MangaOCR`
- reserver Gemini/OpenAI vision comme secours ou arbitrage haut de gamme
- utiliser Neon comme base Postgres principale pour glossaires, adaptateurs et contexte durable
