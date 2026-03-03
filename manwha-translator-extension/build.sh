#!/bin/bash

# Build script for Manwha Translator Extension
# Creates a distributable ZIP file

echo "MAT - Build Script"
echo "===================================="
echo ""

# Get version from manifest
VERSION=$(grep '"version"' manifest.json | cut -d'"' -f4)
echo "Building version: $VERSION"

# Create build directory
BUILD_DIR="build"
mkdir -p "$BUILD_DIR"

# Copy all files
echo "📦 Copying files..."
cp manifest.json "$BUILD_DIR/"
cp popup.html "$BUILD_DIR/"
cp popup.js "$BUILD_DIR/"
cp site-adapters.js "$BUILD_DIR/"
cp content.js "$BUILD_DIR/"
cp background.js "$BUILD_DIR/"
cp styles.css "$BUILD_DIR/"
cp README.md "$BUILD_DIR/"

# Copy directories
cp -r icons "$BUILD_DIR/"
cp -r branding "$BUILD_DIR/"
cp -r demo "$BUILD_DIR/"

# Create ZIP
echo "📦 Creating ZIP archive..."
ZIP_NAME="manwha-translator-v${VERSION}.zip"
cd "$BUILD_DIR"
zip -r "../$ZIP_NAME" .
cd ..

# Cleanup
rm -rf "$BUILD_DIR"

echo ""
echo "✅ Build complete!"
echo "📁 Output: $ZIP_NAME"
echo ""
echo "📋 Next steps:"
echo "   1. Upload $ZIP_NAME to Chrome Web Store (if publishing)"
echo "   2. Or load as unpacked extension in developer mode"
echo ""

# Show file size
if command -v du &> /dev/null; then
    SIZE=$(du -h "$ZIP_NAME" | cut -f1)
    echo "📊 File size: $SIZE"
fi
