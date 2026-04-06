const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();
const cdm = require('./cdm');
const PORT = process.env.PORT || 3000;
const { Command } = require('commander');
const program = new Command();

var instances = [];

// Server log file — written to /var/lib/crucible/logs/ if it exists, otherwise cwd
var logDir = '/var/lib/crucible/logs';
try {
  fs.mkdirSync(logDir, { recursive: true });
} catch (e) {
  logDir = '.';
}
var logFile = logDir + '/cdm-server.log';
var logStream = fs.createWriteStream(logFile, { flags: 'a' });

function serverLog(msg) {
  var line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  logStream.write(line + '\n');
}

function serverError(msg) {
  var line = '[' + new Date().toISOString() + '] ERROR: ' + msg;
  console.error(line);
  logStream.write(line + '\n');
}

function save_host(host) {
  var host_info = { host: host, header: { 'Content-Type': 'application/json' } };
  instances.push(host_info);
}

function save_userpass(userpass) {
  if (instances.length == 0) {
    console.log('You must specify a --host before a --userpass');
    process.exit(1);
  }
  instances[instances.length - 1]['header'] = {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + btoa(userpass)
  };
}

function save_ver(ver) {
  if (instances.length == 0) {
    console.log('You must specify a --host before a --ver');
    process.exit(1);
  }
  if (/^v[7|8|9]dev$/.exec(ver)) {
    instances[instances.length - 1]['ver'] = ver;
  } else {
    console.log('The version must be v7dev, v8dev, or v9dev, not: ' + ver);
    process.exit(1);
  }
}

program
  .version('1.0.0')
  .option('--host <host[:port]>', 'The host and optional port of the OpenSearch instance', save_host)
  .option('--userpass <user:pass>', 'The user and password for the most recent --host', save_userpass)
  .option('--ver <v7dev|v8dev|v9dev>', 'The Common Data Model version to use for the most recent --host', save_ver)
  .parse(process.argv);

const options = program.opts();

// If the user does not specify any hosts, assume localhost:9200 is used
if (instances.length == 0) {
  save_host('localhost:9200');
}

serverLog(
  'Starting CDM server with ' + instances.length + ' instance(s): ' + JSON.stringify(instances.map((i) => i.host))
);
serverLog('Log file: ' + logFile);

getInstancesInfo(instances);

serverLog('Instance info after discovery: ' + JSON.stringify(instances, null, 2));

app.use(cors());
app.use(express.json());

// --------------------------------------------------------------------------------------------------------------
// Middleware: resolve a run ID to an OpenSearch instance and yearDotMonth
// Attaches req.cdm = { instance, yearDotMonth, runId } on success
// --------------------------------------------------------------------------------------------------------------
async function resolveRun(req, res, next) {
  try {
    const runId = req.params.id;
    if (!runId) {
      return res.status(400).json({
        code: 'MISSING_RUN_ID',
        error: 'A run ID is required'
      });
    }

    if (!instances || instances.length === 0) {
      return res.status(503).json({
        code: 'NO_INSTANCES',
        error: 'No OpenSearch instances configured'
      });
    }

    // Refresh instance index info before querying
    getInstancesInfo(instances);

    const instance = await findInstanceFromRun(instances, runId);
    if (instance == null) {
      return res.status(404).json({
        code: 'RUN_NOT_FOUND',
        error: 'Could not find run ID ' + runId + ' in any OpenSearch instance'
      });
    }

    const yearDotMonth = await findYearDotMonthFromRun(instance, runId);

    req.cdm = { instance, yearDotMonth, runId };
    next();
  } catch (error) {
    serverError('Error in resolveRun middleware:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to resolve run: ' + error.message
    });
  }
}

// --------------------------------------------------------------------------------------------------------------
// GET /api/v1/runs — search for runs by filters
// Query params: name, email, harness, run (all optional)
// --------------------------------------------------------------------------------------------------------------
app.get('/api/v1/runs', async (req, res) => {
  try {
    var termKeys = [];
    var values = [];

    if (req.query.name) {
      termKeys.push('run.name');
      values.push([req.query.name]);
    }
    if (req.query.email) {
      termKeys.push('run.email');
      values.push([req.query.email]);
    }
    if (req.query.run) {
      termKeys.push('run.run-uuid');
      values.push([req.query.run]);
    }
    if (req.query.harness) {
      termKeys.push('run.harness');
      values.push([req.query.harness]);
    }
    if (req.query.benchmark) {
      termKeys.push('run.benchmark');
      values.push([req.query.benchmark]);
    }

    if (!instances || instances.length === 0) {
      return res.status(503).json({
        code: 'NO_INSTANCES',
        error: 'No OpenSearch instances configured'
      });
    }

    // Refresh instance index info before querying
    getInstancesInfo(instances);

    var allInstanceRunIds = [];
    for (const instance of instances) {
      if (invalidInstance(instance)) {
        continue;
      }
      var ydm = getYdm(instance, 'run', req);
      var instanceRunIds = await cdm.mSearch(instance, 'run', ydm, termKeys, values, 'run.run-uuid', null, 1000);
      if (typeof instanceRunIds[0] != 'undefined') {
        allInstanceRunIds.push(instanceRunIds[0]);
      }
    }

    var runIds = cdm.consolidateAllArrays(allInstanceRunIds);
    if (typeof runIds == 'undefined') {
      runIds = [];
    }

    // Helper: get run IDs from a cross-index aggregation and intersect with current set
    async function intersectRunIds(runIdSet, fetchFn) {
      var crossIds = [];
      for (const instance of instances) {
        if (invalidInstance(instance)) continue;
        var result = await fetchFn(instance);
        if (result && result[0]) crossIds.push(result[0]);
      }
      var consolidated = cdm.consolidateAllArrays(crossIds) || [];
      var crossSet = new Set(consolidated);
      return runIdSet.filter((id) => crossSet.has(id));
    }

    // Filter by primary metric name (e.g., "uperf::Gbps")
    if (req.query.primaryMetric) {
      runIds = await intersectRunIds(runIds, (inst) =>
        cdm.getRunIdsByPrimaryMetric(inst, getYdm(inst, 'iteration', req), req.query.primaryMetric)
      );
    }

    // Filter by tag pairs: tags=[{"name":"x","val":"y"}, ...]
    var tagFilters = [];
    if (req.query.tags) {
      try {
        tagFilters = JSON.parse(req.query.tags);
      } catch (e) {
        /* ignore parse errors */
      }
    }
    // Support legacy single tag filter
    if (tagFilters.length === 0 && (req.query.tagName || req.query.tagValue)) {
      tagFilters.push({ name: req.query.tagName || '', val: req.query.tagValue || '' });
    }
    for (const tag of tagFilters) {
      if (!tag.name && !tag.val) continue;
      runIds = await intersectRunIds(runIds, (inst) =>
        cdm.getRunIdsByTag(inst, getYdm(inst, 'tag', req), tag.name || null, tag.val || null)
      );
    }

    // Filter by param pairs: params=[{"arg":"x","val":"y,z"}, ...]
    // Comma-separated values are OR'd (union), then intersected with the run set.
    if (req.query.params) {
      try {
        var paramFilters = JSON.parse(req.query.params);
        for (const param of paramFilters) {
          if (!param.arg || !param.val) continue;
          var vals = param.val.split(',').filter(Boolean);
          if (vals.length === 1) {
            runIds = await intersectRunIds(runIds, (inst) =>
              cdm.getRunIdsByParam(inst, getYdm(inst, 'param', req), param.arg, vals[0])
            );
          } else {
            // Union run IDs across all values for this param
            var unionIds = new Set();
            for (const val of vals) {
              var ids = await intersectRunIds(runIds, (inst) =>
                cdm.getRunIdsByParam(inst, getYdm(inst, 'param', req), param.arg, val)
              );
              ids.forEach((id) => unionIds.add(id));
            }
            runIds = runIds.filter((id) => unionIds.has(id));
          }
        }
      } catch (e) {
        /* ignore parse errors */
      }
    }

    serverLog('[' + Date.now() + '] GET /api/v1/runs returned ' + runIds.length + ' run(s)');
    res.json({ runIds: runIds });
  } catch (error) {
    serverError('Error in GET /api/v1/runs:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to search for runs: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// GET /api/v1/run/:id/tags — get tags for a run
// --------------------------------------------------------------------------------------------------------------
app.get('/api/v1/run/:id/tags', resolveRun, async (req, res) => {
  try {
    const { instance, yearDotMonth, runId } = req.cdm;
    var tags = await cdm.getTags(instance, runId, yearDotMonth);
    if (typeof tags == 'undefined') {
      tags = [];
    }
    serverLog('[' + Date.now() + '] GET /api/v1/run/' + runId + '/tags returned ' + tags.length + ' tag(s)');
    res.json({ tags: tags });
  } catch (error) {
    serverError('Error in GET /api/v1/run/:id/tags:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to get tags: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// GET /api/v1/run/:id/benchmark — get benchmark name for a run
// --------------------------------------------------------------------------------------------------------------
app.get('/api/v1/run/:id/benchmark', resolveRun, async (req, res) => {
  try {
    const { instance, yearDotMonth, runId } = req.cdm;
    var benchmarkName = await cdm.getBenchmarkName(instance, runId, yearDotMonth);
    if (typeof benchmarkName == 'undefined' || benchmarkName == null) {
      return res.status(404).json({
        code: 'BENCHMARK_NOT_FOUND',
        error: 'No benchmark name found for run ' + runId
      });
    }
    serverLog('[' + Date.now() + '] GET /api/v1/run/' + runId + '/benchmark returned: ' + benchmarkName);
    res.json({ benchmark: benchmarkName });
  } catch (error) {
    serverError('Error in GET /api/v1/run/:id/benchmark:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to get benchmark name: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// GET /api/v1/run/:id/iterations — get iteration UUIDs for a run
// --------------------------------------------------------------------------------------------------------------
app.get('/api/v1/run/:id/iterations', resolveRun, async (req, res) => {
  try {
    const { instance, yearDotMonth, runId } = req.cdm;
    var iterations = await cdm.getIterations(instance, runId, yearDotMonth);
    if (typeof iterations == 'undefined') {
      iterations = [];
    }
    console.log(
      '[' + Date.now() + '] GET /api/v1/run/' + runId + '/iterations returned ' + iterations.length + ' iteration(s)'
    );
    res.json({ iterations: iterations });
  } catch (error) {
    serverError('Error in GET /api/v1/run/:id/iterations:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to get iterations: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// POST /api/v1/run/:id/iterations/params — get params for iterations
// Body: { iterations: [...] }
// --------------------------------------------------------------------------------------------------------------
app.post('/api/v1/run/:id/iterations/params', resolveRun, async (req, res) => {
  try {
    const { instance, yearDotMonth, runId } = req.cdm;
    const { iterations } = req.body;

    if (!Array.isArray(iterations) || iterations.length === 0) {
      return res.status(400).json({
        code: 'MISSING_ITERATIONS',
        error: 'An array of iteration IDs is required in the request body'
      });
    }

    var params = await cdm.mgetParams(instance, iterations, yearDotMonth);
    if (typeof params == 'undefined') {
      params = [];
    }
    console.log(
      '[' +
        Date.now() +
        '] POST /api/v1/run/' +
        runId +
        '/iterations/params returned params for ' +
        iterations.length +
        ' iteration(s)'
    );
    res.json({ params: params });
  } catch (error) {
    serverError('Error in POST /api/v1/run/:id/iterations/params:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to get iteration params: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// POST /api/v1/run/:id/iterations/primary-period-name — get primary period names
// Body: { iterations: [...] }
// --------------------------------------------------------------------------------------------------------------
app.post('/api/v1/run/:id/iterations/primary-period-name', resolveRun, async (req, res) => {
  try {
    const { instance, yearDotMonth, runId } = req.cdm;
    const { iterations } = req.body;

    if (!Array.isArray(iterations) || iterations.length === 0) {
      return res.status(400).json({
        code: 'MISSING_ITERATIONS',
        error: 'An array of iteration IDs is required in the request body'
      });
    }

    var periodNames = await cdm.mgetPrimaryPeriodName(instance, iterations, yearDotMonth);
    if (typeof periodNames == 'undefined') {
      periodNames = [];
    }
    console.log(
      '[' +
        Date.now() +
        '] POST /api/v1/run/' +
        runId +
        '/iterations/primary-period-name returned ' +
        periodNames.length +
        ' name(s)'
    );
    res.json({ periodNames: periodNames });
  } catch (error) {
    serverError('Error in POST /api/v1/run/:id/iterations/primary-period-name:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to get primary period names: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// POST /api/v1/run/:id/iterations/samples — get sample IDs per iteration
// Body: { iterations: [...] }
// Returns: { samples: [[...], [...]] } (2D array indexed by iteration)
// --------------------------------------------------------------------------------------------------------------
app.post('/api/v1/run/:id/iterations/samples', resolveRun, async (req, res) => {
  try {
    const { instance, yearDotMonth, runId } = req.cdm;
    const { iterations } = req.body;

    if (!Array.isArray(iterations) || iterations.length === 0) {
      return res.status(400).json({
        code: 'MISSING_ITERATIONS',
        error: 'An array of iteration IDs is required in the request body'
      });
    }

    var samples = await cdm.mgetSamples(instance, iterations, yearDotMonth);
    if (typeof samples == 'undefined') {
      samples = [];
    }
    console.log(
      '[' +
        Date.now() +
        '] POST /api/v1/run/' +
        runId +
        '/iterations/samples returned samples for ' +
        iterations.length +
        ' iteration(s)'
    );
    res.json({ samples: samples });
  } catch (error) {
    serverError('Error in POST /api/v1/run/:id/iterations/samples:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to get samples: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// POST /api/v1/run/:id/samples/statuses — get pass/fail status per sample
// Body: { sampleIds: [[...], [...]] } (2D array indexed by iteration)
// Returns: { statuses: [[...], [...]] } (2D array indexed by iteration)
// --------------------------------------------------------------------------------------------------------------
app.post('/api/v1/run/:id/samples/statuses', resolveRun, async (req, res) => {
  try {
    const { instance, yearDotMonth, runId } = req.cdm;
    const { sampleIds } = req.body;

    if (!Array.isArray(sampleIds) || sampleIds.length === 0) {
      return res.status(400).json({
        code: 'MISSING_SAMPLE_IDS',
        error: 'A 2D array of sample IDs is required in the request body'
      });
    }

    var statuses = await cdm.mgetSampleStatuses(instance, sampleIds, yearDotMonth);
    if (typeof statuses == 'undefined') {
      statuses = [];
    }
    serverLog('[' + Date.now() + '] POST /api/v1/run/' + runId + '/samples/statuses completed');
    res.json({ statuses: statuses });
  } catch (error) {
    serverError('Error in POST /api/v1/run/:id/samples/statuses:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to get sample statuses: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// POST /api/v1/run/:id/samples/primary-period-id — get primary period IDs
// Body: { sampleIds: [[...], [...]], periodNames: [...] }
// Returns: { periodIds: [[...], [...]] } (2D array indexed by iteration)
// --------------------------------------------------------------------------------------------------------------
app.post('/api/v1/run/:id/samples/primary-period-id', resolveRun, async (req, res) => {
  try {
    const { instance, yearDotMonth, runId } = req.cdm;
    const { sampleIds, periodNames } = req.body;

    if (!Array.isArray(sampleIds) || sampleIds.length === 0) {
      return res.status(400).json({
        code: 'MISSING_SAMPLE_IDS',
        error: 'A 2D array of sample IDs is required in the request body'
      });
    }
    if (!Array.isArray(periodNames) || periodNames.length === 0) {
      return res.status(400).json({
        code: 'MISSING_PERIOD_NAMES',
        error: 'An array of period names is required in the request body'
      });
    }

    var periodIds = await cdm.mgetPrimaryPeriodId(instance, sampleIds, periodNames, yearDotMonth);
    if (typeof periodIds == 'undefined') {
      periodIds = [];
    }
    serverLog('[' + Date.now() + '] POST /api/v1/run/' + runId + '/samples/primary-period-id completed');
    res.json({ periodIds: periodIds });
  } catch (error) {
    serverError('Error in POST /api/v1/run/:id/samples/primary-period-id:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to get primary period IDs: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// POST /api/v1/run/:id/periods/range — get begin/end time for periods
// Body: { periodIds: [[...], [...]] } (2D array indexed by iteration)
// Returns: { ranges: [[{begin, end}, ...], ...] } (2D array indexed by iteration)
// --------------------------------------------------------------------------------------------------------------
app.post('/api/v1/run/:id/periods/range', resolveRun, async (req, res) => {
  try {
    const { instance, yearDotMonth, runId } = req.cdm;
    const { periodIds } = req.body;

    if (!Array.isArray(periodIds) || periodIds.length === 0) {
      return res.status(400).json({
        code: 'MISSING_PERIOD_IDS',
        error: 'A 2D array of period IDs is required in the request body'
      });
    }

    var ranges = await cdm.mgetPeriodRange(instance, periodIds, yearDotMonth);
    if (typeof ranges == 'undefined') {
      ranges = [];
    }
    serverLog('[' + Date.now() + '] POST /api/v1/run/' + runId + '/periods/range completed');
    res.json({ ranges: ranges });
  } catch (error) {
    serverError('Error in POST /api/v1/run/:id/periods/range:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to get period ranges: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// POST /api/v1/run/:id/iterations/primary-metric — get primary metric per iteration
// Body: { iterations: [...] }
// Returns: { primaryMetrics: [...] } (1D array, one per iteration)
// --------------------------------------------------------------------------------------------------------------
app.post('/api/v1/run/:id/iterations/primary-metric', resolveRun, async (req, res) => {
  try {
    const { instance, yearDotMonth, runId } = req.cdm;
    const { iterations } = req.body;

    if (!Array.isArray(iterations) || iterations.length === 0) {
      return res.status(400).json({
        code: 'MISSING_ITERATIONS',
        error: 'An array of iteration IDs is required in the request body'
      });
    }

    var primaryMetrics = await cdm.mgetPrimaryMetric(instance, iterations, yearDotMonth);
    if (typeof primaryMetrics == 'undefined') {
      primaryMetrics = [];
    }
    console.log(
      '[' +
        Date.now() +
        '] POST /api/v1/run/' +
        runId +
        '/iterations/primary-metric returned ' +
        primaryMetrics.length +
        ' metric(s)'
    );
    res.json({ primaryMetrics: primaryMetrics });
  } catch (error) {
    serverError('Error in POST /api/v1/run/:id/iterations/primary-metric:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to get primary metrics: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// GET /api/v1/run/:id/metric-sources — get all metric sources for a run
// --------------------------------------------------------------------------------------------------------------
app.get('/api/v1/run/:id/metric-sources', resolveRun, async (req, res) => {
  try {
    const { instance, yearDotMonth, runId } = req.cdm;
    var metricSourcesSets = await cdm.mgetMetricSources(instance, [runId], yearDotMonth);
    var sources = [];
    if (Array.isArray(metricSourcesSets) && metricSourcesSets.length > 0) {
      sources = metricSourcesSets[0];
    }
    console.log(
      '[' + Date.now() + '] GET /api/v1/run/' + runId + '/metric-sources returned ' + sources.length + ' source(s)'
    );
    res.json({ sources: sources });
  } catch (error) {
    serverError('Error in GET /api/v1/run/:id/metric-sources:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to get metric sources: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// POST /api/v1/run/:id/metric-types — get metric types per source
// Body: { sources: [...] }
// Returns: { types: [[...], [...]] } (2D array, one inner array per source)
// --------------------------------------------------------------------------------------------------------------
app.post('/api/v1/run/:id/metric-types', resolveRun, async (req, res) => {
  try {
    const { instance, yearDotMonth, runId } = req.cdm;
    const { sources } = req.body;

    if (!Array.isArray(sources) || sources.length === 0) {
      return res.status(400).json({
        code: 'MISSING_SOURCES',
        error: 'An array of metric sources is required in the request body'
      });
    }

    // mgetMetricTypes expects parallel arrays of runIds and sources
    var runIds = sources.map(() => runId);
    var types = await cdm.mgetMetricTypes(instance, runIds, sources, yearDotMonth);
    if (typeof types == 'undefined') {
      types = [];
    }
    console.log(
      '[' +
        Date.now() +
        '] POST /api/v1/run/' +
        runId +
        '/metric-types returned types for ' +
        sources.length +
        ' source(s)'
    );
    res.json({ types: types });
  } catch (error) {
    serverError('Error in POST /api/v1/run/:id/metric-types:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to get metric types: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// POST /api/v1/iterations/details — batch-hydrate iterations for multiple runs
// Body: { runIds: [...] }
// Returns fully assembled iteration objects in a single request, using batched
// mSearch calls to OpenSearch instead of per-run HTTP roundtrips.
// --------------------------------------------------------------------------------------------------------------
app.post('/api/v1/iterations/details', async (req, res) => {
  try {
    const { runIds, start, end } = req.body;

    if (!Array.isArray(runIds) || runIds.length === 0) {
      return res.status(400).json({
        code: 'MISSING_RUN_IDS',
        error: 'An array of run IDs is required in the request body'
      });
    }

    if (!instances || instances.length === 0) {
      return res.status(503).json({
        code: 'NO_INSTANCES',
        error: 'No OpenSearch instances configured'
      });
    }

    getInstancesInfo(instances);

    var allIterations = [];

    for (const inst of instances) {
      if (invalidInstance(inst)) continue;
      // Use the date range from the search to scope queries.
      // buildYearDotMonthRange returns docType-independent suffixes (e.g., "@2025.01,@2025.02")
      // so the same ydm works for all index types (run, iteration, param, etc.)
      var ydm = cdm.buildYearDotMonthRange(inst, 'run', start || null, end || null);
      var gRunIds = runIds;

      // Step 1: Batch-fetch run-level data for all runs in this group.
      // Run sequentially to avoid overwhelming OpenSearch's search thread pool
      // when querying across many monthly indices.
      var benchmarks = await cdm.mgetBenchmarkName(inst, gRunIds, ydm);
      var runDataByRun = await cdm.mgetRunData(inst, gRunIds, ydm);
      var iterationsByRun = await cdm.mgetIterations(inst, gRunIds, ydm);
      var tagsByRun = await cdm.mgetTags(inst, gRunIds, ydm);

      // Collect all iteration IDs across all runs, tracking which run each belongs to
      var allIterIds = [];
      var iterToRunMap = []; // parallel array: iterToRunMap[i] = { runIdx, runId, benchmark, tags, runBegin }
      for (var r = 0; r < gRunIds.length; r++) {
        var runIters = (iterationsByRun && iterationsByRun[r]) || [];
        var benchmark = (benchmarks && benchmarks[r] && benchmarks[r][0]) || null;
        var tags = (tagsByRun && tagsByRun[r]) || [];
        var runData = (runDataByRun && runDataByRun[r] && runDataByRun[r][0]) || {};
        var runBegin = (runData.run && runData.run.begin) || null;
        var runSource = (runData.run && runData.run.source) || null;
        var runName = (runData.run && runData.run.name) || null;
        var runEmail = (runData.run && runData.run.email) || null;
        for (var it = 0; it < runIters.length; it++) {
          allIterIds.push(runIters[it]);
          iterToRunMap.push({ runIdx: r, runId: gRunIds[r], benchmark, tags, runBegin, runSource, runName, runEmail });
        }
      }

      if (allIterIds.length === 0) continue;

      // Step 2: Batch-fetch iteration-level data for all iterations.
      // Run sequentially to avoid overwhelming OpenSearch's search thread pool.
      var params = await cdm.mgetParams(inst, allIterIds, ydm);
      var samples = await cdm.mgetSamples(inst, allIterIds, ydm);
      var primaryMetrics = await cdm.mgetPrimaryMetric(inst, allIterIds, ydm);
      var periodNames = await cdm.mgetPrimaryPeriodName(inst, allIterIds, ydm);

      // Step 3: Batch-fetch sample statuses
      var samplesByIter = samples || [];
      var statuses = [];
      if (samplesByIter.length > 0) {
        statuses = await cdm.mgetSampleStatuses(inst, samplesByIter, ydm);
        if (typeof statuses === 'undefined') statuses = [];
      }

      // Step 4: Compute common vs unique params
      // Group iterations by run to determine common params within each run
      var runIterGroups = {};
      for (var i = 0; i < allIterIds.length; i++) {
        var runId = iterToRunMap[i].runId;
        if (!runIterGroups[runId]) runIterGroups[runId] = [];
        runIterGroups[runId].push(i);
      }

      var commonParamsByRun = {};
      var uniqueParamsByIter = {};

      for (var runId in runIterGroups) {
        var idxs = runIterGroups[runId];
        var paramSets = idxs.map(function (idx) {
          var p = (params && params[idx]) || [];
          return Array.isArray(p) ? p : [];
        });

        var common = [];
        var unique = [];

        if (paramSets.length > 1) {
          var first = paramSets[0];
          for (var p = 0; p < first.length; p++) {
            var param = first[p];
            var isCommon = paramSets.every(function (ps) {
              return ps.some(function (pp) {
                return pp.arg === param.arg && pp.val === param.val;
              });
            });
            if (isCommon) common.push(param);
          }
          for (var s = 0; s < paramSets.length; s++) {
            unique.push(
              paramSets[s].filter(function (pp) {
                return !common.some(function (c) {
                  return c.arg === pp.arg && c.val === pp.val;
                });
              })
            );
          }
        } else {
          if (paramSets.length === 1) unique.push(paramSets[0]);
        }

        commonParamsByRun[runId] = common;
        for (var s = 0; s < idxs.length; s++) {
          uniqueParamsByIter[idxs[s]] = unique[s] || [];
        }
      }

      // Step 5: Assemble iteration objects
      for (var i = 0; i < allIterIds.length; i++) {
        var meta = iterToRunMap[i];
        var iterSamples = (samplesByIter[i]) || [];
        var iterStatuses = (statuses && statuses[i]) || [];
        var passCount = iterStatuses.filter(function (s) { return s === 'pass'; }).length;
        var failCount = iterStatuses.filter(function (s) { return s === 'fail'; }).length;

        allIterations.push({
          runId: meta.runId,
          iterationId: allIterIds[i],
          benchmark: meta.benchmark,
          tags: meta.tags,
          params: (params && params[i]) || [],
          commonParams: commonParamsByRun[meta.runId] || [],
          uniqueParams: uniqueParamsByIter[i] || [],
          sampleCount: iterSamples.length,
          passCount: passCount,
          failCount: failCount,
          primaryMetric: (primaryMetrics && primaryMetrics[i]) || null,
          runBegin: meta.runBegin,
          runSource: meta.runSource,
          runName: meta.runName,
          runEmail: meta.runEmail
        });
      }
    }

    serverLog(
      'POST /api/v1/iterations/details: ' +
        runIds.length +
        ' run(s) -> ' +
        allIterations.length +
        ' iteration(s)'
    );
    res.json({ iterations: allIterations });
  } catch (error) {
    serverError('Error in POST /api/v1/iterations/details: ' + error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Failed to get iteration details: ' + error.message
    });
  }
});

// --------------------------------------------------------------------------------------------------------------
// FIELD VALUE ENDPOINTS — return distinct values for search dropdowns
// All accept optional ?start=YYYY.MM&end=YYYY.MM to limit index scope
// --------------------------------------------------------------------------------------------------------------

// Helper to build yearDotMonth for a given docType using request's start/end params
function getYdm(instance, docType, req) {
  var start = req.query.start || null;
  var end = req.query.end || null;
  return cdm.buildYearDotMonthRange(instance, docType, start, end);
}

async function getDistinctValues(instances, fetchFn) {
  getInstancesInfo(instances);
  var allValues = [];
  for (const instance of instances) {
    if (invalidInstance(instance)) continue;
    var values = await fetchFn(instance);
    if (values && values[0]) allValues.push(values[0]);
  }
  var consolidated = cdm.consolidateAllArrays(allValues);
  return (consolidated || []).sort();
}

// Return available YYYY.MM values from index names (for date range selectors)
app.get('/api/v1/fields/months', async (req, res) => {
  try {
    getInstancesInfo(instances);
    var allMonths = new Set();
    for (const instance of instances) {
      if (invalidInstance(instance)) continue;
      var months = cdm.getAvailableMonths(instance);
      months.forEach((m) => allMonths.add(m));
    }
    var sorted = Array.from(allMonths).sort();
    serverLog('GET /api/v1/fields/months returned ' + sorted.length + ' month(s)');
    res.json({ values: sorted });
  } catch (error) {
    serverError('Error in GET /api/v1/fields/months: ' + error);
    res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Failed to get months: ' + error.message });
  }
});

app.get('/api/v1/fields/names', async (req, res) => {
  try {
    var values = await getDistinctValues(instances, (inst) =>
      cdm.getDistinctNames(inst, getYdm(inst, 'run', req))
    );
    serverLog('GET /api/v1/fields/names returned ' + values.length + ' value(s)');
    res.json({ values: values });
  } catch (error) {
    serverError('Error in GET /api/v1/fields/names: ' + error);
    res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Failed to get names: ' + error.message });
  }
});

app.get('/api/v1/fields/emails', async (req, res) => {
  try {
    var values = await getDistinctValues(instances, (inst) =>
      cdm.getDistinctEmails(inst, getYdm(inst, 'run', req))
    );
    serverLog('GET /api/v1/fields/emails returned ' + values.length + ' value(s)');
    res.json({ values: values });
  } catch (error) {
    serverError('Error in GET /api/v1/fields/emails: ' + error);
    res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Failed to get emails: ' + error.message });
  }
});

app.get('/api/v1/fields/benchmarks', async (req, res) => {
  try {
    var values = await getDistinctValues(instances, (inst) =>
      cdm.getDistinctBenchmarks(inst, getYdm(inst, 'run', req))
    );
    serverLog('GET /api/v1/fields/benchmarks returned ' + values.length + ' value(s)');
    res.json({ values: values });
  } catch (error) {
    serverError('Error in GET /api/v1/fields/benchmarks: ' + error);
    res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Failed to get benchmarks: ' + error.message });
  }
});

app.get('/api/v1/fields/tag-names', async (req, res) => {
  try {
    var values = await getDistinctValues(instances, (inst) =>
      cdm.getDistinctTagNames(inst, getYdm(inst, 'tag', req))
    );
    serverLog('GET /api/v1/fields/tag-names returned ' + values.length + ' value(s)');
    res.json({ values: values });
  } catch (error) {
    serverError('Error in GET /api/v1/fields/tag-names: ' + error);
    res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Failed to get tag names: ' + error.message });
  }
});

app.get('/api/v1/fields/tag-values', async (req, res) => {
  try {
    var tagName = req.query.name || null;
    var values = await getDistinctValues(instances, (inst) =>
      cdm.getDistinctTagValues(inst, getYdm(inst, 'tag', req), tagName)
    );
    serverLog('GET /api/v1/fields/tag-values returned ' + values.length + ' value(s)');
    res.json({ values: values });
  } catch (error) {
    serverError('Error in GET /api/v1/fields/tag-values: ' + error);
    res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Failed to get tag values: ' + error.message });
  }
});

app.get('/api/v1/fields/param-args', async (req, res) => {
  try {
    var values = await getDistinctValues(instances, (inst) =>
      cdm.getDistinctParamArgs(inst, getYdm(inst, 'param', req))
    );
    serverLog('GET /api/v1/fields/param-args returned ' + values.length + ' value(s)');
    res.json({ values: values });
  } catch (error) {
    serverError('Error in GET /api/v1/fields/param-args: ' + error);
    res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Failed to get param args: ' + error.message });
  }
});

app.get('/api/v1/fields/param-values', async (req, res) => {
  try {
    var paramArg = req.query.arg || null;
    var values = await getDistinctValues(instances, (inst) =>
      cdm.getDistinctParamValues(inst, getYdm(inst, 'param', req), paramArg)
    );
    serverLog('GET /api/v1/fields/param-values returned ' + values.length + ' value(s)');
    res.json({ values: values });
  } catch (error) {
    serverError('Error in GET /api/v1/fields/param-values: ' + error);
    res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Failed to get param values: ' + error.message });
  }
});

app.get('/api/v1/fields/primary-metrics', async (req, res) => {
  try {
    var values = await getDistinctValues(instances, (inst) =>
      cdm.getDistinctPrimaryMetrics(inst, getYdm(inst, 'iteration', req))
    );
    serverLog('GET /api/v1/fields/primary-metrics returned ' + values.length + ' value(s)');
    res.json({ values: values });
  } catch (error) {
    serverError('Error in GET /api/v1/fields/primary-metrics: ' + error);
    res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Failed to get primary metrics: ' + error.message });
  }
});

// --------------------------------------------------------------------------------------------------------------
// POST /api/v1/metric-data — get metric data (existing endpoint, supports run or period)
// --------------------------------------------------------------------------------------------------------------
app.post('/api/v1/metric-data', async (req, res) => {
  try {
    var { run, period, begin, end, source, type, resolution, breakout, filter, instances: reqInstances } = req.body;

    serverLog('[' + Date.now() + '] Fetching metric data with parameters:', {
      run,
      period,
      begin,
      end,
      source,
      type,
      resolution,
      breakout,
      filter,
      instances: reqInstances ? `${reqInstances.length} instance(s) provided` : 'using server instances'
    });

    // Use instances from request if provided, otherwise use server's configured instances
    var instancesToUse = reqInstances && reqInstances.length > 0 ? reqInstances : instances;

    if (!instancesToUse || instancesToUse.length === 0) {
      return res.status(503).json({
        code: 'NO_INSTANCES',
        error:
          'No OpenSearch instances configured. Either start server with --host options or provide instances in request.'
      });
    }

    // Refresh instance index info before querying
    getInstancesInfo(instancesToUse);

    var yearDotMonth;
    var instance;
    if (run != null) {
      instance = await findInstanceFromRun(instancesToUse, run);
      if (instance == null) {
        return res.status(404).json({
          code: 'RUN_NOT_FOUND',
          error: 'Could not find run ID ' + run + ' in any OpenSearch instance'
        });
      }
    } else if (period != null) {
      instance = await findInstanceFromPeriod(instancesToUse, period);
      if (instance == null) {
        return res.status(404).json({
          code: 'PERIOD_NOT_FOUND',
          error: 'Could not find period ID ' + period + ' in any OpenSearch instance'
        });
      }
      // We don't yet know the yearDotMonth, so use wildcard to query all period indices
      run = await getRunFromPeriod(instance, period, '@*');
    } else {
      return res.status(400).json({
        code: 'MISSING_RUN_OR_PERIOD',
        error: 'Neither a period nor a run ID were provided'
      });
    }
    var yearDotMonth = await findYearDotMonthFromRun(instance, run);

    // getMetricDataSets expects breakout to be an array
    // Handle breakout as either an array (from new client) or string (from legacy clients)
    if (Array.isArray(breakout)) {
      // Already an array, use as-is
    } else if (typeof breakout === 'string') {
      // Legacy string format, do simple split
      breakout = breakout.split(',');
    } else {
      // Undefined or null
      breakout = [];
    }
    if (typeof resolution == 'undefined') {
      resolution = 1;
    }
    var set = {
      run: run,
      period: period,
      source: source,
      type: type,
      begin: begin,
      end: end,
      resolution: resolution,
      breakout: breakout,
      filter: filter
    };
    var resp = await cdm.getMetricDataSets(instance, [set], yearDotMonth);
    if (resp['ret-code'] != 0) {
      return res.status(500).json({
        code: 'METRIC_QUERY_FAILED',
        error: resp['ret-msg']
      });
    }
    metric_data = resp['data-sets'][0];

    console.log(
      '[' +
        Date.now() +
        '] Request completed from Opensearch instance: ' +
        instance['host'] +
        ' and cdm: ' +
        instance['ver'] +
        '\n'
    );

    // Return the data
    res.json(metric_data);
  } catch (error) {
    serverError('Error in /api/v1/metric-data:', error);
    res.status(500).json({
      code: 'INTERNAL_ERROR',
      error: 'Internal server error while fetching metric data',
      details: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((error, req, res, next) => {
  serverError('Unhandled error: ' + error);
  res.status(500).json({
    code: 'INTERNAL_ERROR',
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// Serve the web UI static files (built React app)
var webUiDist = path.join(__dirname, 'web-ui', 'dist');
if (fs.existsSync(webUiDist)) {
  app.use(express.static(webUiDist));

  // SPA fallback: serve index.html for non-API routes
  app.get('*path', (req, res) => {
    res.sendFile(path.join(webUiDist, 'index.html'));
  });
  serverLog('Serving web UI from ' + webUiDist);
} else {
  // Handle 404 for unknown routes when no web UI is built
  app.use((req, res) => {
    res.status(404).json({
      code: 'ROUTE_NOT_FOUND',
      error: 'Route not found: ' + req.method + ' ' + req.originalUrl
    });
  });
}

// Start server
app.listen(PORT, () => {
  serverLog('CDM Query Server running on port ' + PORT);
  serverLog('API endpoints: http://localhost:' + PORT + '/api/v1/');
  serverLog('Health check: http://localhost:' + PORT + '/health');
});

module.exports = app;
