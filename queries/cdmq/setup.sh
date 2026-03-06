#!/bin/bash
# Setup script for cdmq - install Node.js dependencies
set -e
script_dir=$(cd "$(dirname "$0")" && pwd)
cd "$script_dir"

if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is not installed. Please install Node.js and npm." >&2
    exit 1
fi

echo "Node version: $(node --version)"
echo "npm version: $(npm --version)"
echo "Installing dependencies..."
npm install --no-fund --no-audit --loglevel verbose
echo "Setup complete."
