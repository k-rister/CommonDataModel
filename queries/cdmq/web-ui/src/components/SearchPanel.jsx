import { useState, useCallback, useRef, useMemo } from 'react';
import * as api from '../api/cdm';
import { timeWork, addEntry } from '../debugLog';
import AutocompleteInput from './AutocompleteInput';

// Fetch fully hydrated iteration details for all runs in a single batch request.
// The server handles all the mSearch batching internally.
async function loadIterationsForRuns(runIds, start, end) {
  const res = await api.getIterationDetails(runIds, start, end);
  return res.iterations || [];
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

export default function SearchPanel({ iterations, onResults, onError, loading, setLoading }) {
  const presentValues = useMemo(() => {
    var runIds = new Set();
    var benchmarks = new Set();
    var primaryMetrics = new Set();
    var names = new Set();
    var emails = new Set();
    var tagNames = new Set();
    var tagValues = {};
    var paramArgs = new Set();
    var paramValues = {};
    if (iterations && iterations.length > 0) {
      for (var it of iterations) {
        if (it.runId) runIds.add(it.runId);
        if (it.benchmark) benchmarks.add(it.benchmark);
        if (it.primaryMetric) primaryMetrics.add(it.primaryMetric);
        if (it.runName) names.add(it.runName);
        if (it.runEmail) emails.add(it.runEmail);
        for (var t of (it.tags || [])) {
          tagNames.add(t.name);
          if (!tagValues[t.name]) tagValues[t.name] = new Set();
          tagValues[t.name].add(t.val);
        }
        for (var p of (it.params || [])) {
          paramArgs.add(p.arg);
          if (!paramValues[p.arg]) paramValues[p.arg] = new Set();
          paramValues[p.arg].add(String(p.val));
        }
      }
    }
    return { runIds, benchmarks, primaryMetrics, names, emails, tagNames, tagValues, paramArgs, paramValues };
  }, [iterations]);

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
    runIds: null,
    benchmarks: null,
    names: null,
    emails: null,
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
        loadIterationsForRuns(runIds, apiFilters.start, apiFilters.end),
      );

      // Params and primary-metric are per-iteration, so the server-side filter
      // narrows to matching runs but we still need to filter iterations.
      const beforeFilter = iterations.length;
      if (activeParams.length > 0) {
        iterations = iterations.filter((it) =>
          activeParams.every((fp) => {
            // Support comma-separated values (OR within a param, AND across params)
            var vals = fp.val.split(',').filter(Boolean);
            return it.params.some((p) => p.arg === fp.arg && vals.includes(String(p.val)));
          }),
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
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>Run ID</label>
          <AutocompleteInput
            value={filters.run}
            onChange={(v) => updateFilter('run', v)}
            options={options.runIds || []}
            presentValues={presentValues.runIds}
            placeholder="UUID"
            onFocus={() => loadOptions('runIds', 'run-ids')}
            onKeyDown={handleKeyDown}
            multi
          />
        </div>
        <div className="field">
          <label>Benchmark</label>
          <AutocompleteInput
            value={filters.benchmark}
            onChange={(v) => updateFilter('benchmark', v)}
            options={options.benchmarks || []}
            presentValues={presentValues.benchmarks}
            placeholder="e.g. fio, uperf"
            onFocus={() => loadOptions('benchmarks', 'benchmarks')}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="field">
          <label>Primary Metric</label>
          <AutocompleteInput
            value={filters.primaryMetric}
            onChange={(v) => updateFilter('primaryMetric', v)}
            options={options.primaryMetrics || []}
            presentValues={presentValues.primaryMetrics}
            placeholder="e.g. uperf::Gbps"
            onFocus={() => loadOptions('primaryMetrics', 'primary-metrics')}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="field">
          <label>User Name</label>
          <AutocompleteInput
            value={filters.name}
            onChange={(v) => updateFilter('name', v)}
            options={options.names || []}
            presentValues={presentValues.names}
            placeholder="e.g. John Smith"
            onFocus={() => loadOptions('names', 'names')}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="field">
          <label>Email</label>
          <AutocompleteInput
            value={filters.email}
            onChange={(v) => updateFilter('email', v)}
            options={options.emails || []}
            presentValues={presentValues.emails}
            placeholder="user@example.com"
            onFocus={() => loadOptions('emails', 'emails')}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="field field-date-range">
          <label>Date Range</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <AutocompleteInput
              value={filters.start}
              onChange={(v) => updateFilter('start', v)}
              options={options.months || []}
              presentValues={new Set()}
              placeholder="From"
              onFocus={() => loadOptions('months', 'months')}
              onKeyDown={handleKeyDown}
            />
            <span style={{ color: 'var(--text-secondary)' }}>to</span>
            <AutocompleteInput
              value={filters.end}
              onChange={(v) => updateFilter('end', v)}
              options={options.months || []}
              presentValues={new Set()}
              placeholder="To"
              onFocus={() => loadOptions('months', 'months')}
              onKeyDown={handleKeyDown}
            />
          </div>
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
            <AutocompleteInput
              value={tag.name}
              onChange={(v) => {
                updateTagFilter(i, 'name', v);
                if (v) {
                  const cacheKey = 'tagValues_' + v;
                  loadOptions(cacheKey, 'tag-values', { name: v });
                }
              }}
              options={options.tagNames || []}
              presentValues={presentValues.tagNames}
              placeholder="Tag name"
              onFocus={() => loadOptions('tagNames', 'tag-names')}
              onKeyDown={handleKeyDown}
            />
            <AutocompleteInput
              value={tag.val}
              onChange={(v) => updateTagFilter(i, 'val', v)}
              options={options.tagValues['tagValues_' + tag.name] || []}
              presentValues={presentValues.tagValues[tag.name] || new Set()}
              placeholder="Tag value"
              onFocus={() => {
                if (tag.name) {
                  const cacheKey = 'tagValues_' + tag.name;
                  loadOptions(cacheKey, 'tag-values', { name: tag.name });
                }
              }}
              onKeyDown={handleKeyDown}
              multi
            />
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
            <AutocompleteInput
              value={param.arg}
              onChange={(v) => updateParamFilter(i, 'arg', v)}
              options={options.paramArgs || []}
              presentValues={presentValues.paramArgs}
              placeholder="Param name"
              onFocus={() => loadOptions('paramArgs', 'param-args')}
              onKeyDown={handleKeyDown}
            />
            <AutocompleteInput
              value={param.val}
              onChange={(v) => updateParamFilter(i, 'val', v)}
              options={options.paramValues['paramValues_' + param.arg] || []}
              presentValues={presentValues.paramValues[param.arg] || new Set()}
              placeholder="Param value"
              onFocus={() => {
                if (param.arg) {
                  const cacheKey = 'paramValues_' + param.arg;
                  loadOptions(cacheKey, 'param-values', { arg: param.arg });
                }
              }}
              onKeyDown={handleKeyDown}
              multi
            />
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
