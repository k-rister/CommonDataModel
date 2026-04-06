import { useState, useMemo } from 'react';

function formatMetric(pm) {
  if (!pm) return '-';
  // pm is a string like "fio::iops" from the API
  if (typeof pm === 'string') return pm;
  // Handle object format if it ever changes
  const source = pm.source || '';
  const type = pm.type || '';
  return [source, type].filter(Boolean).join('::') || '-';
}

export default function IterationTable({ iterations, selected, onToggleSelect, onToggleSelectAll, loading }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [paramFilter, setParamFilter] = useState('');

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const filtered = useMemo(() => {
    if (!paramFilter) return iterations;
    const q = paramFilter.toLowerCase();
    return iterations.filter((it) =>
      it.params.some(
        (p) =>
          (p.arg && p.arg.toLowerCase().includes(q)) ||
          (p.val && String(p.val).toLowerCase().includes(q)),
      ),
    );
  }, [iterations, paramFilter]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const arr = [...filtered];
    arr.sort((a, b) => {
      let va, vb;
      switch (sortKey) {
        case 'benchmark':
          va = a.benchmark || '';
          vb = b.benchmark || '';
          break;
        case 'samples':
          va = a.sampleCount;
          vb = b.sampleCount;
          break;
        case 'status':
          va = a.passCount;
          vb = b.passCount;
          break;
        case 'metric':
          va = a.primaryMetric || '';
          vb = b.primaryMetric || '';
          break;
        case 'run':
          va = a.runId;
          vb = b.runId;
          break;
        default:
          return 0;
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  const thClass = (key) => {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc';
  };

  const allOnPageSelected = sorted.length > 0 && sorted.every((it) => selected.has(it.iterationId));

  // Precompute run group parity for each row (0 or 1, toggling when runId changes)
  const runGroupParity = useMemo(() => {
    var parity = [];
    var current = 0;
    for (var i = 0; i < sorted.length; i++) {
      if (i > 0 && sorted[i].runId !== sorted[i - 1].runId) current = 1 - current;
      parity.push(current);
    }
    return parity;
  }, [sorted]);

  return (
    <div className="results-panel">
      <div className="results-header">
        <h2>Iterations {iterations.length > 0 && `(${iterations.length})`}</h2>
        {iterations.length > 0 && (
          <div className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <label style={{ textTransform: 'none', letterSpacing: 0 }}>Filter params:</label>
            <input
              type="text"
              placeholder="e.g. bs=4k"
              value={paramFilter}
              onChange={(e) => setParamFilter(e.target.value)}
              style={{ width: 160 }}
            />
          </div>
        )}
      </div>
      <div className="results-table-wrap">
        <table className="results-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  onChange={() => onToggleSelectAll(sorted)}
                  disabled={sorted.length === 0}
                />
              </th>
              <th className={thClass('run')} onClick={() => handleSort('run')}>
                Run
              </th>
              <th className={thClass('benchmark')} onClick={() => handleSort('benchmark')}>
                Benchmark
              </th>
              <th>Tags</th>
              <th>Unique Params</th>
              <th className={thClass('metric')} onClick={() => handleSort('metric')}>
                Primary Metric
              </th>
              <th className={thClass('samples')} onClick={() => handleSort('samples')}>
                Samples
              </th>
              <th className={thClass('status')} onClick={() => handleSort('status')}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr className="loading-row">
                <td colSpan={8}>
                  <span className="spinner" /> Loading iterations...
                </td>
              </tr>
            )}
            {!loading && sorted.length === 0 && iterations.length === 0 && (
              <tr className="loading-row">
                <td colSpan={8}>
                  <span className="empty-msg">Search for runs to see iterations.</span>
                </td>
              </tr>
            )}
            {!loading && sorted.length === 0 && iterations.length > 0 && (
              <tr className="loading-row">
                <td colSpan={8}>
                  <span className="empty-msg">No iterations match the current filter.</span>
                </td>
              </tr>
            )}
            {!loading &&
              sorted.map((it, idx) => {
                var rowClasses = [];
                if (selected.has(it.iterationId)) rowClasses.push('selected');
                rowClasses.push(runGroupParity[idx] === 0 ? 'run-group-even' : 'run-group-odd');
                if (idx > 0 && it.runId !== sorted[idx - 1].runId) rowClasses.push('run-group-border');
                return (
                <tr
                  key={it.iterationId}
                  className={rowClasses.join(' ')}
                  onClick={() => onToggleSelect(it)}
                  style={{ cursor: 'pointer' }}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(it.iterationId)}
                      onChange={() => onToggleSelect(it)}
                    />
                  </td>
                  <td>
                    <span className="run-id">{it.runId}</span>
                  </td>
                  <td>{it.benchmark || '-'}</td>
                  <td>
                    {(it.tags || []).map((t, i) => (
                      <span key={i} className="tag">
                        <span className="tag-key">{t.name}</span>={t.val}
                      </span>
                    ))}
                    {(!it.tags || it.tags.length === 0) && '-'}
                  </td>
                  <td>
                    {it.uniqueParams.length > 0
                      ? it.uniqueParams.map((p, i) => (
                          <span key={i} className="param">
                            {p.arg}={p.val}
                          </span>
                        ))
                      : it.params.map((p, i) => (
                          <span key={i} className="param param-common">
                            {p.arg}={p.val}
                          </span>
                        ))}
                  </td>
                  <td className="metric-value">{formatMetric(it.primaryMetric)}</td>
                  <td>{it.sampleCount}</td>
                  <td>
                    {it.passCount > 0 && <span className="status-pass">{it.passCount}P</span>}
                    {it.passCount > 0 && it.failCount > 0 && ' '}
                    {it.failCount > 0 && <span className="status-fail">{it.failCount}F</span>}
                    {it.passCount === 0 && it.failCount === 0 && '-'}
                  </td>
                </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
