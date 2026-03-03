#!/bin/bash

# Installation script for Manwha Translator Extension
# This script helps install the extension on different browsers

echo "MAT - Installation Script"
echo "=========================================="
echo ""

# Detect OS
OS="unknown"
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="linux"
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    OS="windows"
fi

echo "Detected OS: $OS"
echo ""

# Function to install on Chrome
install_chrome() {
    echo "📦 Chrome Installation:"
    echo "1. Open Chrome and navigate to: chrome://extensions/"
    echo "2. Enable 'Developer mode' (toggle in top right)"
    echo "3. Click 'Load unpacked'"
    echo "4. Select this folder: $(pwd)"
    echo ""
    
    # Try to open Chrome
    if command -v google-chrome &> /dev/null; then
        google-chrome "chrome://extensions/" &
    elif command -v chromium &> /dev/null; then
        chromium "chrome://extensions/" &
    elif command -v chromium-browser &> /dev/null; then
        chromium-browser "chrome://extensions/" &
    fi
}

# Function to install on Firefox
install_firefox() {
    echo "📦 Firefox Installation:"
    echo "1. Open Firefox and navigate to: about:debugging#/runtime/this-firefox"
    echo "2. Click 'Load Temporary Add-on'"
    echo "3. Select the manifest.json file in this folder"
    echo ""
    
    # Try to open Firefox
    if command -v firefox &> /dev/null; then
        firefox "about:debugging#/runtime/this-firefox" &
    fi
}

# Function to install on Edge
install_edge() {
    echo "📦 Edge Installation:"
    echo "1. Open Edge and navigate to: edge://extensions/"
    echo "2. Enable 'Developer mode' (toggle in bottom left)"
    echo "3. Click 'Load unpacked'"
    echo "4. Select this folder: $(pwd)"
    echo ""
}

# Main menu
echo "Select your browser:"
echo "1) Chrome / Chromium"
echo "2) Firefox"
echo "3) Microsoft Edge"
echo "4) Brave"
echo "5) All browsers"
echo "6) Exit"
echo ""
read -p "Enter choice [1-6]: " choice

case $choice in
    1)
        install_chrome
        ;;
    2)
        install_firefox
        ;;
    3)
        install_edge
        ;;
    4)
        echo "📦 Brave Installation:"
        echo "1. Open Brave and navigate to: brave://extensions/"
        echo "2. Enable 'Developer mode'"
        echo "3. Click 'Load unpacked'"
        echo "4. Select this folder: $(pwd)"
        ;;
    5)
        install_chrome
        install_firefox
        install_edge
        ;;
    6)
        echo "Goodbye! 👋"
        exit 0
        ;;
    *)
        echo "Invalid choice. Please run the script again."
        exit 1
        ;;
esac

echo ""
echo "✅ Installation instructions displayed!"
echo ""
echo "💡 Tips:"
echo "   - Pin the extension to your toolbar for easy access"
echo "   - Click the MAT icon to open the translator"
echo "   - Use right-click on any image for quick translation"
echo ""
echo "📖 For more help, see README.md"
