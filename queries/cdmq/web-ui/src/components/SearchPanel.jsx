import { useState, useCallback, useRef } from 'react';
import * as api from '../api/cdm';
import { timeWork, addEntry } from '../debugLog';

// Given a list of run IDs, fetch full iteration details for all runs.
// Returns a flat array of iteration objects.
async function loadIterationsForRuns(runIds) {
  const allIterations = [];

  for (const runId of runIds) {
    try {
      const [benchRes, iterRes, tagRes] = await Promise.all([
        api.getBenchmark(runId),
        api.getIterations(runId),
        api.getTags(runId),
      ]);

      const benchmark = benchRes.benchmark;
      const tags = tagRes.tags || [];
      const iterationIds = iterRes.iterations || [];

      if (iterationIds.length === 0) continue;

      const [paramsRes, samplesRes, primaryMetricRes, periodNameRes] = await Promise.all([
        api.getIterationParams(runId, iterationIds),
        api.getSamples(runId, iterationIds),
        api.getPrimaryMetric(runId, iterationIds),
        api.getPrimaryPeriodName(runId, iterationIds),
      ]);

      const params = paramsRes.params || [];
      const samplesByIter = samplesRes.samples || [];
      const primaryMetrics = primaryMetricRes.primaryMetrics || [];

      // Get sample statuses
      let statuses = [];
      if (samplesByIter.length > 0) {
        const statusRes = await api.getSampleStatuses(runId, samplesByIter);
        statuses = statusRes.statuses || [];
      }

      // Compute common vs unique params
      const paramSets = params.map((p) =>
        Array.isArray(p) ? p : typeof p === 'object' ? Object.entries(p).map(([k, v]) => ({ arg: k, val: v })) : [],
      );

      const commonParams = [];
      const uniqueParams = [];

      if (paramSets.length > 1) {
        const first = paramSets[0];
        for (const param of first) {
          const isCommon = paramSets.every((ps) => ps.some((p) => p.arg === param.arg && p.val === param.val));
          if (isCommon) {
            commonParams.push(param);
          }
        }
        for (let i = 0; i < paramSets.length; i++) {
          uniqueParams.push(paramSets[i].filter((p) => !commonParams.some((c) => c.arg === p.arg && c.val === p.val)));
        }
      } else {
        if (paramSets.length === 1) {
          uniqueParams.push(paramSets[0]);
        }
      }

      for (let i = 0; i < iterationIds.length; i++) {
        const iterSamples = samplesByIter[i] || [];
        const iterStatuses = statuses[i] || [];
        const passCount = iterStatuses.filter((s) => s === 'pass').length;
        const failCount = iterStatuses.filter((s) => s === 'fail').length;
        const pm = primaryMetrics[i];

        allIterations.push({
          runId,
          iterationId: iterationIds[i],
          benchmark,
          tags,
          params: paramSets[i] || [],
          commonParams,
          uniqueParams: uniqueParams[i] || [],
          sampleCount: iterSamples.length,
          passCount,
          failCount,
          primaryMetric: pm || null,
        });
      }
    } catch (err) {
      console.error(`Error loading run ${runId}:`, err);
    }
  }

  return allIterations;
}

// Compute default start month (3 months ago) in YYYY.MM format
function defaultStart() {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0');
}

function defaultEnd() {
  const d = new Date();
  return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0');
}

export default function SearchPanel({ onResults, onError, loading, setLoading }) {
  const [filters, setFilters] = useState({
    name: '',
    email: '',
    run: '',
    benchmark: '',
    primaryMetric: '',
    start: defaultStart(),
    end: defaultEnd(),
    tags: [],
    params: [],
  });

  // Cache for dropdown options: { benchmarks: [...], tagNames: [...], ... }
  const optionsCache = useRef({});
  const [options, setOptions] = useState({
    months: null,
    benchmarks: null,
    tagNames: null,
    tagValues: {},
    paramArgs: null,
    paramValues: {},
    primaryMetrics: null,
  });

  const loadOptions = useCallback(async (key, fieldType, filterParams) => {
    const cacheKey = key + JSON.stringify(filterParams || {});
    if (optionsCache.current[cacheKey]) return;
    optionsCache.current[cacheKey] = true;
    try {
      const res = await api.getFieldValues(fieldType, filterParams);
      const values = res.values || [];
      if (key.startsWith('tagValues_')) {
        setOptions((prev) => ({ ...prev, tagValues: { ...prev.tagValues, [key]: values } }));
      } else if (key.startsWith('paramValues_')) {
        setOptions((prev) => ({ ...prev, paramValues: { ...prev.paramValues, [key]: values } }));
      } else {
        setOptions((prev) => ({ ...prev, [key]: values }));
      }
    } catch (err) {
      console.error(`Failed to load options for ${fieldType}:`, err);
    }
  }, []);

  const updateFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  // Tag filter management
  const addTagFilter = () => {
    setFilters((prev) => ({ ...prev, tags: [...prev.tags, { name: '', val: '' }] }));
  };

  const updateTagFilter = (index, field, value) => {
    setFilters((prev) => {
      const tags = [...prev.tags];
      tags[index] = { ...tags[index], [field]: value };
      return { ...prev, tags };
    });
  };

  const removeTagFilter = (index) => {
    setFilters((prev) => ({ ...prev, tags: prev.tags.filter((_, i) => i !== index) }));
  };

  // Param filter management
  const addParamFilter = () => {
    setFilters((prev) => ({ ...prev, params: [...prev.params, { arg: '', val: '' }] }));
  };

  const updateParamFilter = (index, field, value) => {
    setFilters((prev) => {
      const params = [...prev.params];
      params[index] = { ...params[index], [field]: value };
      // Clear value cache when arg changes so it refetches
      if (field === 'arg') {
        params[index].val = '';
        const cacheKey = 'paramValues_' + value;
        if (value && !optionsCache.current[cacheKey]) {
          loadOptions(cacheKey, 'param-values', { arg: value });
        }
      }
      return { ...prev, params };
    });
  };

  const removeParamFilter = (index) => {
    setFilters((prev) => ({ ...prev, params: prev.params.filter((_, i) => i !== index) }));
  };

  const handleSearch = useCallback(async () => {
    setLoading(true);
    onError(null);
    addEntry({ type: 'info', label: 'Search started', status: 'done', elapsed: 0 });
    const searchStart = performance.now();
    try {
      // Build filters for API — only include non-empty values
      const apiFilters = {};
      if (filters.run) apiFilters.run = filters.run;
      if (filters.name) apiFilters.name = filters.name;
      if (filters.email) apiFilters.email = filters.email;
      if (filters.benchmark) apiFilters.benchmark = filters.benchmark;
      if (filters.primaryMetric) apiFilters.primaryMetric = filters.primaryMetric;
      if (filters.start) apiFilters.start = filters.start;
      if (filters.end) apiFilters.end = filters.end;

      const activeTags = filters.tags.filter((t) => t.name || t.val);
      if (activeTags.length > 0) apiFilters.tags = activeTags;

      const activeParams = filters.params.filter((p) => p.arg && p.val);
      if (activeParams.length > 0) apiFilters.params = activeParams;

      const runRes = await timeWork('Search runs (server)', () => api.searchRuns(apiFilters));
      const runIds = runRes.runIds || [];

      if (runIds.length === 0) {
        addEntry({ type: 'info', label: 'No runs found', status: 'done', elapsed: 0 });
        onResults([]);
        setLoading(false);
        return;
      }

      addEntry({ type: 'info', label: `Found ${runIds.length} run(s), loading iterations`, status: 'done', elapsed: 0 });

      let iterations = await timeWork(`Load iteration details for ${runIds.length} run(s)`, () =>
        loadIterationsForRuns(runIds),
      );

      // Params and primary-metric are per-iteration, so the server-side filter
      // narrows to matching runs but we still need to filter iterations.
      const beforeFilter = iterations.length;
      if (activeParams.length > 0) {
        iterations = iterations.filter((it) =>
          activeParams.every((fp) => it.params.some((p) => p.arg === fp.arg && p.val === fp.val)),
        );
      }
      if (apiFilters.primaryMetric) {
        iterations = iterations.filter((it) => it.primaryMetric === apiFilters.primaryMetric);
      }
      if (iterations.length < beforeFilter) {
        addEntry({
          type: 'info',
          label: `Client-side filter: ${beforeFilter} -> ${iterations.length} iteration(s)`,
          status: 'done',
          elapsed: 0,
        });
      }

      const totalElapsed = performance.now() - searchStart;
      addEntry({ type: 'info', label: `Search complete: ${iterations.length} iteration(s) in ${(totalElapsed / 1000).toFixed(1)}s`, status: 'done', elapsed: totalElapsed });

      onResults(iterations);
    } catch (err) {
      onError(err.message);
      onResults([]);
    } finally {
      setLoading(false);
    }
  }, [filters, onResults, onError, setLoading]);

  const handleClear = () => {
    setFilters({ name: '', email: '', run: '', benchmark: '', primaryMetric: '', start: defaultStart(), end: defaultEnd(), tags: [], params: [] });
    onResults([]);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSearch();
  };

  return (
    <div className="search-panel">
      <h2>Search Iterations</h2>

      {/* Basic filters */}
      <div className="search-fields">
        <div className="field">
          <label>Run ID</label>
          <input
            type="text"
            placeholder="UUID"
            value={filters.run}
            onChange={(e) => updateFilter('run', e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="field">
          <label>Benchmark</label>
          <input
            list="dl-benchmarks"
            placeholder="e.g. fio, uperf"
            value={filters.benchmark}
            onChange={(e) => updateFilter('benchmark', e.target.value)}
            onFocus={() => loadOptions('benchmarks', 'benchmarks')}
            onKeyDown={handleKeyDown}
          />
          <datalist id="dl-benchmarks">
            {(options.benchmarks || []).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label>Primary Metric</label>
          <input
            list="dl-primary-metrics"
            placeholder="e.g. uperf::Gbps"
            value={filters.primaryMetric}
            onChange={(e) => updateFilter('primaryMetric', e.target.value)}
            onFocus={() => loadOptions('primaryMetrics', 'primary-metrics')}
            onKeyDown={handleKeyDown}
          />
          <datalist id="dl-primary-metrics">
            {(options.primaryMetrics || []).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label>Run Name</label>
          <input
            type="text"
            placeholder="Run name"
            value={filters.name}
            onChange={(e) => updateFilter('name', e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="field">
          <label>Email</label>
          <input
            type="text"
            placeholder="user@example.com"
            value={filters.email}
            onChange={(e) => updateFilter('email', e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="field">
          <label>From (YYYY.MM)</label>
          <input
            list="dl-months-start"
            placeholder="e.g. 2025.01"
            value={filters.start}
            onChange={(e) => updateFilter('start', e.target.value)}
            onFocus={() => loadOptions('months', 'months')}
            onKeyDown={handleKeyDown}
          />
          <datalist id="dl-months-start">
            {(options.months || []).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label>To (YYYY.MM)</label>
          <input
            list="dl-months-end"
            placeholder="e.g. 2025.04"
            value={filters.end}
            onChange={(e) => updateFilter('end', e.target.value)}
            onFocus={() => loadOptions('months', 'months')}
            onKeyDown={handleKeyDown}
          />
          <datalist id="dl-months-end">
            {(options.months || []).map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
      </div>

      {/* Tag filters */}
      <div className="filter-section">
        <div className="filter-section-header">
          <label>Tags</label>
          <button className="btn btn-sm btn-secondary filter-add-btn" onClick={addTagFilter}>
            + Add Tag
          </button>
        </div>
        {filters.tags.map((tag, i) => (
          <div key={i} className="filter-row">
            <input
              list={`dl-tag-names-${i}`}
              placeholder="Tag name"
              value={tag.name}
              onChange={(e) => {
                updateTagFilter(i, 'name', e.target.value);
                if (e.target.value) {
                  const cacheKey = 'tagValues_' + e.target.value;
                  loadOptions(cacheKey, 'tag-values', { name: e.target.value });
                }
              }}
              onFocus={() => loadOptions('tagNames', 'tag-names')}
              onKeyDown={handleKeyDown}
            />
            <datalist id={`dl-tag-names-${i}`}>
              {(options.tagNames || []).map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <input
              list={`dl-tag-values-${i}`}
              placeholder="Tag value"
              value={tag.val}
              onChange={(e) => updateTagFilter(i, 'val', e.target.value)}
              onFocus={() => {
                if (tag.name) {
                  const cacheKey = 'tagValues_' + tag.name;
                  loadOptions(cacheKey, 'tag-values', { name: tag.name });
                }
              }}
              onKeyDown={handleKeyDown}
            />
            <datalist id={`dl-tag-values-${i}`}>
              {(options.tagValues['tagValues_' + tag.name] || []).map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <button className="btn btn-sm filter-remove-btn" onClick={() => removeTagFilter(i)} title="Remove">
              x
            </button>
          </div>
        ))}
      </div>

      {/* Param filters */}
      <div className="filter-section">
        <div className="filter-section-header">
          <label>Params</label>
          <button className="btn btn-sm btn-secondary filter-add-btn" onClick={addParamFilter}>
            + Add Param
          </button>
        </div>
        {filters.params.map((param, i) => (
          <div key={i} className="filter-row">
            <input
              list={`dl-param-args-${i}`}
              placeholder="Param name"
              value={param.arg}
              onChange={(e) => updateParamFilter(i, 'arg', e.target.value)}
              onFocus={() => loadOptions('paramArgs', 'param-args')}
              onKeyDown={handleKeyDown}
            />
            <datalist id={`dl-param-args-${i}`}>
              {(options.paramArgs || []).map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <input
              list={`dl-param-values-${i}`}
              placeholder="Param value"
              value={param.val}
              onChange={(e) => updateParamFilter(i, 'val', e.target.value)}
              onFocus={() => {
                if (param.arg) {
                  const cacheKey = 'paramValues_' + param.arg;
                  loadOptions(cacheKey, 'param-values', { arg: param.arg });
                }
              }}
              onKeyDown={handleKeyDown}
            />
            <datalist id={`dl-param-values-${i}`}>
              {(options.paramValues['paramValues_' + param.arg] || []).map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            <button className="btn btn-sm filter-remove-btn" onClick={() => removeParamFilter(i)} title="Remove">
              x
            </button>
          </div>
        ))}
      </div>

      <div className="search-actions">
        <button className="btn btn-primary" onClick={handleSearch} disabled={loading}>
          {loading ? (
            <>
              <span className="spinner" style={{ marginRight: 6 }} /> Searching...
            </>
          ) : (
            'Search'
          )}
        </button>
        <button className="btn btn-secondary" onClick={handleClear} disabled={loading}>
          Clear
        </button>
      </div>
    </div>
  );
}
