# Analyse OCR manga

## Ce que je retiens

### PaddleOCR

- a garder comme base de production pour la detection/reconnaissance generaliste
- tres bon point d'entree pour du texte de page reel
- utile sur webtoon/manhwa avec texte latin ou multilingue

### MangaOCR

- a garder absolument, mais pas comme detecteur de page
- excellent pour raffiner la reconnaissance sur des crops japonais manga
- doit etre place apres une etape de detection

### docTR

- a garder comme fallback tertiaire
- plus document OCR que manga OCR
- utile pour cartouches narratifs, panneaux ou texte plus propre

## Ce que je ne retiens pas comme coeur de prod

### WORD-pytorch

- projet interessant pour la detection orientee "word"
- pas le meilleur socle central pour une stack manga moderne complete
- a garder comme reference experimentale, pas comme moteur principal

### VincentQQu / manga_text_bubble_detect_translate

- bon prototype d'assemblage bulle + OCR + traduction
- utile comme inspiration pipeline
- pas assez robuste comme dependance coeur de prod pour notre extension

## Pipeline recommande

1. detection primaire avec PaddleOCR
2. fallback docTR sur cartouches/narration/texte droit
3. raffinement MangaOCR sur chaque crop japonais ou bloc douteux
4. orchestration et fusion des blocs au backend
5. traduction contextuelle separee, avec glossaire et memoire de chapitre

## Decision produit

Le meilleur systeme n'est pas "tout utiliser en meme temps partout".
Le meilleur systeme est :

- un detecteur principal stable
- un moteur de secours stable
- un recognizer specialise manga la ou il excelle
- un arbitre backend qui choisit le meilleur bloc final

## MMOCR

`MMOCR` reste une piste interessante, mais je le sors de la stack active ici. La raison est pragmatique: son installation locale a pollue l'environnement Python principal via `openmim` sur cette machine. Si vous voulez le tester plus tard, faites-le dans un worker ou un venv separe.
