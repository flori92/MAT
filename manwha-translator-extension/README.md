# 🌸 Manwha Auto Translator

Extension de navigateur pour traduire automatiquement les scans de manwha/manga de l'anglais vers le français.

## 🧱 Architecture

Le projet est maintenant séparé en trois briques :

- `manwha-translator-extension/` : extension Chromium, détection DOM et rendu
- `../backend/` : gateway backend pour traduction, cache, orchestration et secrets providers
- `../backend/ocr-pipeline/` : pipeline Python spécialisé manga pour `PaddleOCR`, `docTR` et `MangaOCR`

Principe :

1. l’extension ne contacte plus directement Gemini/OpenAI/MyMemory/LibreTranslate
2. le `background` ne parle qu’au backend
3. toute la pile OCR lourde vit côté backend Python

## ✨ Fonctionnalités

- **Traduction automatique** : Détecte et traduit automatiquement les bulles de dialogue
- **Multi-sites** : Concu pour les lecteurs webtoon/manwha les plus courants
- **3 modes d'affichage** :
  - **Superposé** : Affiche la traduction au survol
  - **Remplacer** : Remplace le texte original
  - **Bulles FR** : Crée des bulles de dialogue en français
- **OCR backend spécialisé** : `PaddleOCR` + `docTR` + `MangaOCR`
- **Backend unique** : Toute la partie réseau passe par une seule API
- **Mode automatique** : Traduit les nouvelles images dès qu'elles apparaissent

## 📦 Installation

### Chrome / Edge / Brave

1. Téléchargez et décompressez l'extension
2. Lancez le backend local dans `../backend`
3. Lancez le pipeline OCR dans `../backend/ocr-pipeline`
4. Ouvrez `chrome://extensions/` (ou `edge://extensions/`, `brave://extensions/`)
5. Activez le **Mode développeur** (coin supérieur droit)
6. Cliquez sur **"Charger l'extension non empaquetée"**
7. Sélectionnez le dossier `manwha-translator-extension`

### Backend local

```bash
cd ../backend
cp .env.example .env
export $(grep -v '^#' .env | xargs)
npm start
```

Le backend écoute par défaut sur `http://127.0.0.1:8787`.

### Pipeline OCR local

```bash
cd ../backend/ocr-pipeline
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8788
```

### Firefox

Support experimental. La cible principale du projet est Chromium (`Chrome`, `Edge`, `Brave`).

## 🚀 Utilisation

### Méthode 1 : Via le popup
1. Cliquez sur l'icône de l'extension 🌸 dans la barre d'outils
2. Cliquez sur **"Traduire cette page"**
3. Attendez que la traduction se termine

### Méthode 2 : Clic droit
1. Faites un clic droit sur une image de manwha
2. Sélectionnez **"🌸 Traduire cette image"**

### Démo locale
Une page de test locale est disponible dans `demo/reader-test.html`.
Le popup permet de configurer l’URL et le jeton du backend.

## ⚙️ Options

### Mode d'affichage
- **Superposé** : Traduction visible au survol de la souris
- **Remplacer** : Remplace définitivement le texte original
- **Bulles FR** : Crée de nouvelles bulles de dialogue

### Traduction automatique
Activez cette option pour traduire automatiquement les nouvelles images lors du défilement.

## 🌐 Sites compatibles

L'extension vise surtout les lecteurs avec :
- grandes images verticales
- DOM simple de lecture chapitre
- images accessibles depuis la page

Exemples de sites compatibles :
- Asura Scans
- Reaper Scans
- Flame Scans
- Void Scans
- TCB Scans
- Et bien d'autres...

## 🔧 Fonctionnement technique

1. **Détection** : L'extension analyse la page pour trouver les images de scans
2. **OCR backend** : Utilise la stack manga (`PaddleOCR` / `docTR` / `MangaOCR`) si elle est disponible
3. **Backend** : Gère aussi la traduction contextuelle et les fallbacks providers
4. **Affichage** : Superpose ou remplace le texte selon le mode choisi

## 📝 Notes

- La traduction peut prendre quelques secondes par image selon la charge du backend OCR
- Certaines images peuvent etre ignorees si elles ressemblent a des banners, covers ou pubs
- La qualité de l'OCR dépend de la résolution et de la clarté du scan
- Les traductions sont mises en cache pour éviter les appels API répétés
- La vraie pile OCR manga vit côté backend Python, pas dans l’extension

## 🔒 Confidentialité

- Les images peuvent transiter vers ton backend si l’OCR IA est activé
- Les traductions sont mises en cache localement dans l’extension
- Les clés providers doivent rester côté backend
- Les utilisateurs finaux n'ont pas a fournir de clé API

## 🐛 Dépannage

### L'extension ne détecte pas les images
- Rafraîchissez la page
- Vérifiez que les images sont suffisamment grandes (min 400px)
- Essayez de scroller pour charger toutes les images

### La traduction ne fonctionne pas
- Vérifiez que le backend répond sur l’URL configurée dans le popup
- Vérifiez que le pipeline OCR Python répond sur `http://127.0.0.1:8788`
- Vérifiez que vos variables `GEMINI_API_KEY` / `OPENAI_API_KEY` sont bien présentes côté backend si vous utilisez les fallbacks providers
- Vérifiez que le moteur OCR sélectionné dans le popup est bien disponible côté backend

### Le texte traduit est mal positionné
- Changez le mode d'affichage
- Ajustez le zoom de la page

## 📄 Licence

MIT License - Libre d'utilisation et de modification

---

**Profitez de vos manwhas en français ! 🇫🇷✨**
