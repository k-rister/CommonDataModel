#!/bin/bash
# vim: autoindent tabstop=4 shiftwidth=4 expandtab softtabstop=4 filetype=bash
# -*- mode: sh; indent-tabs-mode: nil; sh-basic-offset: 4 -*-

# This script starts the CommonDataModel REST API server
# which provides metric data queries via HTTP endpoints

project_dir=$(dirname `readlink -e $0`)
pushd "$project_dir" >/dev/null
if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is not installed. Please install Node.js and npm." >&2
    popd >/dev/null
    exit 1
fi
echo "Resolving cdmq dependencies..." >&2
npm install --no-fund --no-audit 2>&1 | tail -1 >&2
node ./server.js "$@"
rc=$?
popd >/dev/null
exit $rc
