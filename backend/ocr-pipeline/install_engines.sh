#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PYTHON_BIN="${PYTHON_BIN:-python3.12}"
VENV_DIR="${VENV_DIR:-.venv312}"
PROFILE="${1:-core}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python introuvable: $PYTHON_BIN"
  exit 1
fi

"$PYTHON_BIN" -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"

python -m pip install --upgrade pip setuptools wheel
python -m pip install -r requirements.txt

case "$PROFILE" in
  core)
    echo "Profil core installe"
    ;;
  paddle)
    python -m pip install paddlepaddle paddleocr
    ;;
  mangaocr)
    python -m pip install manga-ocr
    ;;
  doctr)
    python -m pip install "python-doctr[torch]"
    ;;
  full)
    python -m pip install torch torchvision
    python -m pip install paddlepaddle paddleocr
    python -m pip install manga-ocr
    python -m pip install "python-doctr[torch]"
    ;;
  *)
    echo "Profil inconnu: $PROFILE"
    echo "Profils disponibles: core, paddle, mangaocr, doctr, full"
    exit 1
    ;;
esac

echo "Venv prete: $SCRIPT_DIR/$VENV_DIR"
