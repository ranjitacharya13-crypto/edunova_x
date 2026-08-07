#!/usr/bin/env bash
# Script to build and "install" (build) the application locally

set -e

echo "Building EduNova X..."

# Install root dependencies
npm install

# Build Frontend
echo "Building Frontend..."
cd frontend
npm install
npm run build

# If you want to build Android
if [ "$1" == "--android" ]; then
    echo "Building Android APK..."
    npx cap sync android
    cd android
    ./gradlew assembleDebug
    echo "Android APK built at: frontend/android/app/build/outputs/apk/debug/app-debug.apk"
    cd ..
fi

# If you want to build Windows
if [ "$1" == "--windows" ]; then
    echo "Building Windows EXE..."
    npm run electron:build
    echo "Windows EXE built in: frontend/dist-electron/"
fi

echo "Build complete!"
