import { useState, useCallback, useEffect, useRef } from 'react';
import SearchPanel from './components/SearchPanel';
import SelectionBar from './components/SelectionBar';
import IterationTable from './components/IterationTable';
import CompareView from './components/CompareView';
import DebugConsole from './components/DebugConsole';
import './index.css';

export default function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const searchRef = useRef(null);
  const [iterations, setIterations] = useState([]);
  const [selected, setSelected] = useState(new Map()); // iterationId -> iteration object
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [view, setView] = useState('search'); // search | compare | deepdive

  const handleSearchResults = useCallback((results) => {
    setIterations(results);
  }, []);

  const toggleSelect = useCallback(
    (iteration) => {
      setSelected((prev) => {
        const next = new Map(prev);
        if (next.has(iteration.iterationId)) {
          next.delete(iteration.iterationId);
        } else {
          next.set(iteration.iterationId, iteration);
        }
        return next;
      });
    },
    [],
  );

  const toggleSelectAll = useCallback(
    (allIterations) => {
      setSelected((prev) => {
        const allSelected = allIterations.every((it) => prev.has(it.iterationId));
        const next = new Map(prev);
        if (allSelected) {
          allIterations.forEach((it) => next.delete(it.iterationId));
        } else {
          allIterations.forEach((it) => next.set(it.iterationId, it));
        }
        return next;
      });
    },
    [],
  );

  const removeSelected = useCallback((iterationId) => {
    setSelected((prev) => {
      const next = new Map(prev);
      next.delete(iterationId);
      return next;
    });
  }, []);

  const clearSelected = useCallback(() => {
    setSelected(new Map());
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Crucible</h1>
        <div className="app-header-right">
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
            onClick={() => setView('deepdive')}
            disabled={selected.size === 0}
          >
            Deep Dive
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
        <CompareView selected={selected} />
      )}

      {view === 'deepdive' && (
        <div className="empty-msg">Phase 3: Time-series deep dive coming soon.</div>
      )}

      <DebugConsole />
    </div>
  );
}
