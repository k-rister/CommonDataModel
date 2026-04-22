import { useState, useCallback, useEffect, useRef } from 'react';
import SearchPanel from './components/SearchPanel';
import SelectionBar from './components/SelectionBar';
import IterationTable from './components/IterationTable';
import CompareView from './components/CompareView';
import DeepDiveView from './components/DeepDiveView';
import DebugConsole from './components/DebugConsole';
import './index.css';

// Encode workflow state into a URL hash string
function encodeState(filters, selectedRunIds, view, groupByList, hiddenFields, supplementalMetrics) {
  var state = {};
  if (filters) {
    if (filters.benchmark) state.benchmark = filters.benchmark;
    if (filters.primaryMetric) state.primaryMetric = filters.primaryMetric;
    if (filters.name) state.name = filters.name;
    if (filters.email) state.email = filters.email;
    if (filters.run) state.run = filters.run;
    if (filters.start) state.start = filters.start;
    if (filters.end) state.end = filters.end;
    if (filters.tags && filters.tags.length > 0) state.tags = filters.tags;
    if (filters.params && filters.params.length > 0) state.params = filters.params;
  }
  if (selectedRunIds && selectedRunIds.length > 0) state.selectedRuns = selectedRunIds;
  if (view && view !== 'search') state.view = view;
  if (groupByList && groupByList.length > 0) state.groupBy = groupByList;
  if (hiddenFields && hiddenFields.length > 0) state.hidden = hiddenFields;
  if (supplementalMetrics && supplementalMetrics.length > 0) {
    state.metrics = supplementalMetrics.map(function (m) {
      var entry = { source: m.source, type: m.type, display: m.display };
      if (m.chartType && m.chartType !== 'bar') entry.chartType = m.chartType;
      if (m.breakouts && m.breakouts.length > 0) entry.breakouts = m.breakouts;
      if (m.filter) entry.filter = m.filter;
      if (m.sampleIndex != null) entry.sampleIndex = m.sampleIndex;
      return entry;
    });
  }
  return '#' + encodeURIComponent(JSON.stringify(state));
}

// Decode workflow state from URL hash
function decodeState(hash) {
  if (!hash || hash.length <= 1) return null;
  try {
    return JSON.parse(decodeURIComponent(hash.substring(1)));
  } catch (e) {
    return null;
  }
}

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const searchRef = useRef(null);
  const compareRef = useRef(null);
  const [iterations, setIterations] = useState([]);
  const [selected, setSelected] = useState(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [view, setView] = useState('search');
  const [groupByList, setGroupByList] = useState([]);  // array of dimension strings
  const [hiddenFields, setHiddenFields] = useState([]);  // array of dimension strings to hide
  const [shareMsg, setShareMsg] = useState('');
  const lastFilters = useRef(null);
  const restoredState = useRef(null);
  const [restoredMetrics, setRestoredMetrics] = useState(null);
  const [deepDiveMetrics, setDeepDiveMetrics] = useState(new Set());  // Set of "source::type" strings
  const [deepDiveConfigs, setDeepDiveConfigs] = useState([]);  // snapshot of supplemental metrics for deep dive

  // On mount, check for state in URL hash
  // Don't switch view yet — wait until search completes and selections are applied
  useEffect(function () {
    var state = decodeState(window.location.hash);
    if (state) {
      restoredState.current = state;
      if (state.groupBy) setGroupByList(Array.isArray(state.groupBy) ? state.groupBy : [state.groupBy]);
      if (state.hidden) setHiddenFields(Array.isArray(state.hidden) ? state.hidden : []);
      if (state.metrics) setRestoredMetrics(state.metrics);
    }
  }, []);

  // After SearchPanel mounts, restore filters and trigger search if we have URL state
  const searchPanelMounted = useRef(false);
  useEffect(function () {
    if (searchPanelMounted.current) return;
    if (!searchRef.current || !restoredState.current) return;
    searchPanelMounted.current = true;
    var state = restoredState.current;
    var filters = {
      name: state.name || '',
      email: state.email || '',
      run: state.run || '',
      benchmark: state.benchmark || '',
      primaryMetric: state.primaryMetric || '',
      start: state.start || '',
      end: state.end || '',
      tags: state.tags || [],
      params: state.params || [],
    };
    searchRef.current.setFiltersAndSearch(filters);
  });

  // After search results come in, auto-select runs from URL state
  const handleSearchResults = useCallback(function (results) {
    setIterations(results);
    // Save current filters for Share button (SearchPanel may not be mounted in compare view)
    if (searchRef.current) lastFilters.current = searchRef.current.getFilters();
    var state = restoredState.current;
    if (state && state.selectedRuns && state.selectedRuns.length > 0) {
      var runSet = new Set(state.selectedRuns);
      var toSelect = new Map();
      results.forEach(function (it) {
        if (runSet.has(it.runId)) toSelect.set(it.iterationId, it);
      });
      if (toSelect.size > 0) setSelected(toSelect);
      // Switch to the saved view now that selections are ready
      if (state.view) setView(state.view);
      // Clear restored state so it doesn't re-apply on next search
      restoredState.current = null;
    }
  }, []);

  const toggleSelect = useCallback(function (iteration) {
    setSelected(function (prev) {
      var next = new Map(prev);
      if (next.has(iteration.iterationId)) {
        next.delete(iteration.iterationId);
      } else {
        next.set(iteration.iterationId, iteration);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(function (allIterations) {
    setSelected(function (prev) {
      var allSelected = allIterations.every(function (it) { return prev.has(it.iterationId); });
      var next = new Map(prev);
      if (allSelected) {
        allIterations.forEach(function (it) { next.delete(it.iterationId); });
      } else {
        allIterations.forEach(function (it) { next.set(it.iterationId, it); });
      }
      return next;
    });
  }, []);

  const removeSelected = useCallback(function (iterationId) {
    setSelected(function (prev) {
      var next = new Map(prev);
      next.delete(iterationId);
      return next;
    });
  }, []);

  const clearSelected = useCallback(function () {
    setSelected(new Map());
  }, []);

  function handleShare() {
    var filters = (searchRef.current ? searchRef.current.getFilters() : null) || lastFilters.current;
    var runIdSet = new Set();
    selected.forEach(function (it) { runIdSet.add(it.runId); });
    var selectedRunIds = Array.from(runIdSet);
    var suppMetrics = compareRef.current ? compareRef.current.getSupplementalMetrics() : null;
    var hash = encodeState(filters, selectedRunIds, view, groupByList, hiddenFields, suppMetrics);
    var url = window.location.origin + window.location.pathname + hash;
    // Update the URL bar so the user can see and copy it directly
    window.history.replaceState(null, '', hash);
    // Try clipboard, fall back to prompt
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        setShareMsg('Link copied!');
        setTimeout(function () { setShareMsg(''); }, 3000);
      }).catch(function () {
        setShareMsg('URL updated in address bar');
        setTimeout(function () { setShareMsg(''); }, 3000);
      });
    } else {
      setShareMsg('URL updated in address bar');
      setTimeout(function () { setShareMsg(''); }, 3000);
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Crucible</h1>
        <div className="app-header-right">
        <button className="btn btn-sm btn-secondary" onClick={handleShare} title="Copy shareable link to clipboard">
          {shareMsg || 'Share'}
        </button>
        <button className="btn btn-sm btn-secondary theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
        <nav className="app-nav">
          <button className={view === 'search' ? 'active' : ''} onClick={() => setView('search')}>
            Search
          </button>
          <button
            className={view === 'compare' ? 'active' : ''}
            onClick={() => setView('compare')}
            disabled={selected.size === 0}
          >
            Compare ({selected.size})
          </button>
          <button
            className={view === 'deepdive' ? 'active' : ''}
            onClick={() => {
              // Snapshot supplemental metric configs before CompareView unmounts
              if (compareRef.current) {
                setDeepDiveConfigs(compareRef.current.getSupplementalMetrics() || []);
              }
              setView('deepdive');
            }}
            disabled={selected.size === 0 || deepDiveMetrics.size === 0}
          >
            Deep Dive{deepDiveMetrics.size > 0 ? ' (' + deepDiveMetrics.size + ')' : ''}
          </button>
        </nav>
        </div>
      </header>

      {error && (
        <div className="error-msg">
          {error}
          <button className="btn btn-sm btn-secondary" style={{ marginLeft: 8 }} onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {view === 'search' && (
        <>
          <SearchPanel ref={searchRef} iterations={iterations} onResults={handleSearchResults} onError={setError} loading={loading} setLoading={setLoading} />

          {selected.size > 0 && (
            <SelectionBar selected={selected} onRemove={removeSelected} onClear={clearSelected} />
          )}

          <IterationTable
            iterations={iterations}
            selected={selected}
            onToggleSelect={toggleSelect}
            onToggleSelectAll={toggleSelectAll}
            loading={loading}
            onAddTagFilter={function (name, val) { if (searchRef.current) searchRef.current.addTagFilter(name, val); }}
            onAddParamFilter={function (arg, val) { if (searchRef.current) searchRef.current.addParamFilter(arg, val); }}
          />
        </>
      )}

      {view === 'compare' && (
        <CompareView ref={compareRef} selected={selected} groupByList={groupByList} setGroupByList={setGroupByList} hiddenFields={hiddenFields} setHiddenFields={setHiddenFields} restoredMetrics={restoredMetrics} deepDiveMetrics={deepDiveMetrics} setDeepDiveMetrics={setDeepDiveMetrics} />
      )}

      {view === 'deepdive' && (
        <DeepDiveView selected={selected} deepDiveMetrics={deepDiveMetrics} metricConfigs={deepDiveConfigs} />
      )}

      <DebugConsole />
    </div>
  );
}
