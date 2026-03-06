#!/bin/bash
# vim: autoindent tabstop=4 shiftwidth=4 expandtab softtabstop=4 filetype=bash
# -*- mode: sh; indent-tabs-mode: nil; sh-basic-offset: 4 -*-

# This script will query *all* runs and try to output the primary-metric
# for each of the benchmark iteration/samples.  It will also attempt
# to find any tools and list the metric_source (like sar), and for each
# metric_source, list the metric_types (like L2-Gbps).  Uncomment the
# "node get-metric-data ..." lines to output a specific tool metric

# This script assumes OpenSearch is installed on the same host
# and has data loaded from soemthing like crucible/rickshaw

project_dir=$(dirname `readlink -e $0`)
pushd "$project_dir" >/dev/null
if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm is not installed. Please install Node.js and npm." >&2
    popd >/dev/null
    exit 1
fi
echo "Resolving cdmq dependencies..." >&2
npm install --no-fund --no-audit 2>&1 | tail -1 >&2
node ./get-metric-data.js "$@"
rc=$?
popd >/dev/null
exit $rc
