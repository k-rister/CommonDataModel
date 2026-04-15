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
echo "Resolving cdmq dependencies..."
npm install --no-fund --no-audit 2>&1 | tail -1

# Build the web UI if source exists
if [ -d "web-ui" ] && [ -f "web-ui/package.json" ]; then
    echo "Building web UI..."
    pushd web-ui >/dev/null
    npm install --no-fund --no-audit 2>&1 | tail -1
    node node_modules/.bin/vite build 2>&1
    build_rc=$?
    popd >/dev/null
    if [ $build_rc -ne 0 ]; then
        echo "Warning: web UI build failed (rc=$build_rc), server will start without UI"
    else
        echo "Web UI built successfully"
    fi
fi

while true; do
    echo "Starting server.js..."
    node ./server.js "$@"
    rc=$?
    echo "server.js exited with rc=$rc, restarting..."
    sleep 1
done
