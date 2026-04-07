import { useState, useMemo, useCallback } from 'react';
import * as api from '../api/cdm';
import { timeWork } from '../debugLog';

function buildRunUrl(source) {
  if (!source) return null;
  // source format: "hostname//var/lib/crucible/run/<run-dir>"
  // splitting on "//" gives ["hostname", "var/lib/crucible/run/<run-dir>"]
  var parts = source.split('//');
  if (parts.length < 2) return null;
  var host = parts[0];
  var path = '/' + parts.slice(1).join('//');
  var runPath = path.replace(/^\/var\/lib\/crucible\/run\//, '/run/');
  return 'http://' + host + ':8080' + runPath;
}

function formatDate(ts) {
  if (!ts) return '-';
  var d = new Date(Number(ts));
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatMetric(pm) {
  if (!pm) return '-';
  if (typeof pm === 'string') return pm;
  const source = pm.source || '';
  const type = pm.type || '';
  return [source, type].filter(Boolean).join('::') || '-';
}

function formatValue(v) {
  if (v == null) return '';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}

export default function IterationTable({ iterations, selected, onToggleSelect, onToggleSelectAll, loading }) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [paramFilter, setParamFilter] = useState('');
  const [metricValues, setMetricValues] = useState({}); // { iterationId: { mean, stddevPct, sampleValues } }
  const [metricLoading, setMetricLoading] = useState(false);

  const fetchMetricValues = useCallback(async () => {
    if (iterations.length === 0) return;
    setMetricLoading(true);
    try {
      // Collect unique run IDs and date range from iterations
      var runIdSet = new Set();
      iterations.forEach(function (it) { runIdSet.add(it.runId); });
      var runIds = Array.from(runIdSet);
      // Infer start/end from run dates
      var starts = iterations.filter(function (it) { return it.runBegin; }).map(function (it) { return it.runBegin; });
      var minBegin = starts.length > 0 ? Math.min.apply(null, starts) : null;
      var maxBegin = starts.length > 0 ? Math.max.apply(null, starts) : null;
      var startMonth = minBegin ? new Date(Number(minBegin)) : null;
      var endMonth = maxBegin ? new Date(Number(maxBegin)) : null;
      var start = startMonth ? startMonth.getFullYear() + '.' + String(startMonth.getMonth() + 1).padStart(2, '0') : null;
      var end = endMonth ? endMonth.getFullYear() + '.' + String(endMonth.getMonth() + 1).padStart(2, '0') : null;

      var res = await timeWork('Fetch metric values for ' + iterations.length + ' iteration(s)', function () {
        return api.getIterationMetricValues(runIds, start, end);
      });
      setMetricValues(res.values || {});
    } catch (err) {
      console.error('Failed to fetch metric values:', err);
    } finally {
      setMetricLoading(false);
    }
  }, [iterations]);

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
    // Support "arg=val" syntax: split on first "=" and match both sides
    const eqIdx = q.indexOf('=');
    if (eqIdx >= 0) {
      const argQ = q.substring(0, eqIdx);
      const valQ = q.substring(eqIdx + 1);
      return iterations.filter((it) =>
        it.params.some(
          (p) =>
            (!argQ || (p.arg && p.arg.toLowerCase().includes(argQ))) &&
            (!valQ || (p.val && String(p.val).toLowerCase().includes(valQ))),
        ),
      );
    }
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
          va = (metricValues[a.iterationId] && metricValues[a.iterationId].mean) || 0;
          vb = (metricValues[b.iterationId] && metricValues[b.iterationId].mean) || 0;
          break;
        case 'run':
          va = a.runId;
          vb = b.runId;
          break;
        case 'date':
          va = a.runBegin || 0;
          vb = b.runBegin || 0;
          break;
        default:
          return 0;
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filtered, sortKey, sortDir, metricValues]);

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

  // Compute globally unique params: params whose values differ across all displayed iterations
  const globalUniqueParams = useMemo(() => {
    // Collect all values per param arg across all iterations
    var paramValues = {};
    for (var i = 0; i < iterations.length; i++) {
      var it = iterations[i];
      (it.params || []).forEach(function (p) {
        if (!paramValues[p.arg]) paramValues[p.arg] = new Set();
        paramValues[p.arg].add(String(p.val));
      });
    }
    // A param is globally unique (varying) if it has more than one distinct value
    var varyingArgs = new Set();
    Object.keys(paramValues).forEach(function (arg) {
      if (paramValues[arg].size > 1) varyingArgs.add(arg);
    });
    // Also do the same for tags
    var tagValues = {};
    for (var i = 0; i < iterations.length; i++) {
      var it = iterations[i];
      (it.tags || []).forEach(function (t) {
        if (!tagValues[t.name]) tagValues[t.name] = new Set();
        tagValues[t.name].add(t.val);
      });
    }
    var varyingTags = new Set();
    Object.keys(tagValues).forEach(function (name) {
      if (tagValues[name].size > 1) varyingTags.add(name);
    });
    // Build per-iteration list of varying params and tags
    var result = {};
    for (var i = 0; i < iterations.length; i++) {
      var it = iterations[i];
      var varying = [];
      (it.params || []).forEach(function (p) {
        if (varyingArgs.has(p.arg)) varying.push({ key: p.arg, val: p.val, type: 'param' });
      });
      (it.tags || []).forEach(function (t) {
        if (varyingTags.has(t.name)) varying.push({ key: t.name, val: t.val, type: 'tag' });
      });
      result[it.iterationId] = varying;
    }
    return result;
  }, [iterations]);

  return (
    <div className="results-panel">
      <div className="results-header">
        <h2>Iterations {iterations.length > 0 && `(${iterations.length})`}</h2>
        {iterations.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              className="btn btn-sm btn-secondary"
              onClick={fetchMetricValues}
              disabled={metricLoading || iterations.length === 0}
            >
              {metricLoading ? (
                <><span className="spinner" style={{ marginRight: 4 }} /> Loading...</>
              ) : Object.keys(metricValues).length > 0 ? 'Refresh Values' : 'Show Values'}
            </button>
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
              <th className={thClass('date')} onClick={() => handleSort('date')}>
                Date
              </th>
              <th className={thClass('benchmark')} onClick={() => handleSort('benchmark')}>
                Benchmark
              </th>
              <th>Tags</th>
              <th>Unique Params/Tags</th>
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
                <td colSpan={9}>
                  <span className="spinner" /> Loading iterations...
                </td>
              </tr>
            )}
            {!loading && sorted.length === 0 && iterations.length === 0 && (
              <tr className="loading-row">
                <td colSpan={9}>
                  <span className="empty-msg">Search for runs to see iterations.</span>
                </td>
              </tr>
            )}
            {!loading && sorted.length === 0 && iterations.length > 0 && (
              <tr className="loading-row">
                <td colSpan={9}>
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
                    {buildRunUrl(it.runSource) ? (
                      <a className="run-id" href={buildRunUrl(it.runSource)} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{it.runId}</a>
                    ) : (
                      <span className="run-id">{it.runId}</span>
                    )}
                  </td>
                  <td className="run-date">{formatDate(it.runBegin)}</td>
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
                    {(globalUniqueParams[it.iterationId] || []).length > 0
                      ? (globalUniqueParams[it.iterationId] || []).map((p, i) => (
                          <span key={i} className={p.type === 'tag' ? 'tag' : 'param'}>
                            {p.type === 'tag' && <span className="tag-key">{p.key}</span>}
                            {p.type === 'tag' ? '=' + p.val : p.key + '=' + p.val}
                          </span>
                        ))
                      : '-'}
                  </td>
                  <td className="metric-value">
                    {formatMetric(it.primaryMetric)}
                    {metricValues[it.iterationId] && metricValues[it.iterationId].mean != null && (
                      <span className="metric-number">
                        {' '}{formatValue(metricValues[it.iterationId].mean)}
                        {metricValues[it.iterationId].stddevPct != null && metricValues[it.iterationId].sampleValues.length > 1 && (
                          <span className="metric-stddev"> ({metricValues[it.iterationId].stddevPct.toFixed(1)}%)</span>
                        )}
                      </span>
                    )}
                  </td>
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
