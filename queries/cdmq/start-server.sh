#!/bin/bash
# vim: autoindent tabstop=4 shiftwidth=4 expandtab softtabstop=4 filetype=bash
# -*- mode: sh; indent-tabs-mode: nil; sh-basic-offset: 4 -*-

# This script starts the CommonDataModel REST API server
# which provides metric data queries via HTTP endpoints

# Set up logging to match other crucible services (opensearch, image-sourcing).
# Log to /var/lib/crucible/logs/ if it exists, otherwise stdout only
# (journald captures container stdout via --log-driver=journald).
log_dir="/var/lib/crucible/logs"
log_file="${log_dir}/cdm-server-start.log"
if [ -d "${log_dir}" ] || mkdir -p "${log_dir}" 2>/dev/null; then
    exec > >(tee "${log_file}") 2>&1
fi

project_dir=$(dirname `readlink -e $0`)
pushd "$project_dir" >/dev/null
if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is not installed. Please install Node.js and npm." >&2
    popd >/dev/null
    exit 1
fi
# Install dependencies only when package-lock.json is newer than last install
if [ ! -f "node_modules/.install-stamp" ] || [ "package-lock.json" -nt "node_modules/.install-stamp" ]; then
    echo "Installing cdmq dependencies..."
    npm ci --no-fund --no-audit 2>&1 | tail -1
    touch node_modules/.install-stamp
else
    echo "cdmq dependencies up to date"
fi

# Build the web UI if source exists
if [ -d "web-ui" ] && [ -f "web-ui/package.json" ]; then
    pushd web-ui >/dev/null
    if [ ! -f "node_modules/.install-stamp" ] || [ "package-lock.json" -nt "node_modules/.install-stamp" ]; then
        echo "Installing web UI dependencies..."
        npm ci --no-fund --no-audit 2>&1 | tail -1
        touch node_modules/.install-stamp
    fi
    # Rebuild if any source file is newer than the dist
    if [ ! -d "dist" ] || [ -n "$(find src -newer dist/index.html 2>/dev/null | head -1)" ] || [ "package-lock.json" -nt "dist/index.html" ]; then
        echo "Building web UI..."
        node node_modules/.bin/vite build 2>&1
        build_rc=$?
        if [ $build_rc -ne 0 ]; then
            echo "Warning: web UI build failed (rc=$build_rc), server will start without UI"
        else
            echo "Web UI built successfully"
        fi
    else
        echo "Web UI build up to date"
    fi
    popd >/dev/null
fi

while true; do
    echo "Starting server.js..."
    #CDM_LOG_OS_CURL=1 node ./server.js "$@"
    node ./server.js "$@"
    rc=$?
    echo "server.js exited with rc=$rc, restarting..."
    sleep 1
done
