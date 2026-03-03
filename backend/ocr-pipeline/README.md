# OCR pipeline manga

Service Python dedie a l'OCR manga/manhwa.

## Role

- detection et reconnaissance locale multi-moteurs
- orchestration `PaddleOCR` + `docTR`
- raffinement `MangaOCR` sur les crops les plus pertinents
- renvoi de blocs normalises au backend gateway

## Pourquoi cette separation

Les bibliotheques OCR manga serieuses vivent majoritairement dans l'ecosysteme Python. Les garder dans un service dedie evite d'alourdir l'extension et permet de faire evoluer la stack OCR sans toucher au front.

## Endpoints

- `GET /health`
- `GET /ocr/engines`
- `POST /ocr/manga`

## Demarrage minimal

```bash
cd backend/ocr-pipeline
./install_engines.sh core
source .venv312/bin/activate
uvicorn app:app --host 127.0.0.1 --port 8788
```

## Engines optionnels

Le service demarre sans les moteurs OCR lourds. Il expose alors `engines: false` dans `/health`.

Installer ensuite les engines que vous voulez activer :

```bash
./install_engines.sh paddle
./install_engines.sh mangaocr
./install_engines.sh doctr
```

Ou tout tenter d'un coup :

```bash
./install_engines.sh full
```

## Strategie recommande

- `PaddleOCR` : moteur generaliste principal de detection
- `docTR` : secours pour cartouches / narration / texte plus document-like
- `MangaOCR` : raffinement sur crops individuels, pas detection de page

## Benchmark

```bash
source .venv312/bin/activate
python benchmark.py \
  --images /chemin/vers/un/chapitre \
  --engines auto,paddle,doctr,mangaocr
```

Avec references :

```json
{
  "images": [
    {
      "path": "001.jpg",
      "site": "asura",
      "expected_text": "Are you sure about this plan?"
    }
  ]
}
```

## Remarque importante

Ce service est un orchestrateur local propre. `MMOCR` a ete retire de la stack active pour garder un environnement Python stable sur cette machine. Si vous voulez le reintroduire un jour, faites-le dans un worker separe, pas dans le venv principal.
