import { useState, useEffect, useMemo, useCallback } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ErrorBar, ResponsiveContainer, Legend, Cell } from 'recharts';
import * as api from '../api/cdm';
import { timeWork } from '../debugLog';

const COLORS = [
  '#5b8def', '#4ade80', '#fbbf24', '#f87171', '#a78bfa',
  '#34d399', '#fb923c', '#f472b6', '#38bdf8', '#facc15',
  '#818cf8', '#2dd4bf', '#e879f9', '#f97316', '#a3e635',
];

const SUPP_COLORS = ['#f97316', '#e879f9', '#14b8a6', '#ef4444', '#8b5cf6', '#06b6d4'];

// Smart Y-axis tick formatter: adjusts decimal precision based on value magnitude
function formatYTick(value) {
  if (value == null) return '';
  var abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1000000) return (value / 1000000).toFixed(1) + 'M';
  if (abs >= 10000) return (value / 1000).toFixed(1) + 'k';
  if (abs >= 100) return Math.round(value).toString();
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  if (abs >= 0.1) return value.toFixed(3);
  return value.toPrecision(3);
}

function formatValue(v) {
  if (v == null) return '';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}

function getDimValue(it, dim) {
  if (!dim || dim === 'none') return '__all__';
  if (dim === 'run') return it.runId;
  if (dim === 'benchmark') return it.benchmark || '';
  if (dim.startsWith('param:')) {
    var arg = dim.substring(6);
    var p = (it.params || []).find(function (pp) { return pp.arg === arg; });
    return p ? String(p.val) : '';
  }
  if (dim.startsWith('tag:')) {
    var name = dim.substring(4);
    var t = (it.tags || []).find(function (tt) { return tt.name === name; });
    return t ? t.val : '';
  }
  return '';
}

function formatDimLabel(dim) {
  if (!dim || dim === 'none') return '';
  if (dim === 'run') return 'Run';
  if (dim === 'benchmark') return 'Benchmark';
  if (dim.startsWith('param:')) return dim.substring(6);
  if (dim.startsWith('tag:')) return dim.substring(4);
  return dim;
}

function formatDimValue(dim, val) {
  if (dim === 'run') return val ? val.substring(0, 8) : val;
  return val || '(empty)';
}

// Compute which params and tags are common (same value across all iterations)
// vs varying (different values). Returns { common: [{key,val}], varyingKeys: Set }
function computeCommonVarying(iters) {
  if (iters.length === 0) return { common: [], varyingKeys: new Set() };

  var benchmarks = new Set();
  var paramValues = {};
  var tagValues = {};

  iters.forEach(function (it) {
    if (it.benchmark) benchmarks.add(it.benchmark);
    (it.params || []).forEach(function (p) {
      if (!paramValues[p.arg]) paramValues[p.arg] = new Set();
      paramValues[p.arg].add(String(p.val));
    });
    (it.tags || []).forEach(function (t) {
      if (!tagValues[t.name]) tagValues[t.name] = new Set();
      tagValues[t.name].add(t.val);
    });
  });

  var common = [];
  var varyingKeys = new Set();

  // Benchmark
  if (benchmarks.size === 1) {
    common.push({ key: 'benchmark', val: Array.from(benchmarks)[0] });
  } else if (benchmarks.size > 1) {
    varyingKeys.add('benchmark');
  }

  Object.keys(paramValues).sort().forEach(function (arg) {
    if (paramValues[arg].size === 1) {
      common.push({ key: arg, val: Array.from(paramValues[arg])[0] });
    } else {
      varyingKeys.add('param:' + arg);
    }
  });
  Object.keys(tagValues).sort().forEach(function (name) {
    if (tagValues[name].size === 1) {
      common.push({ key: name, val: Array.from(tagValues[name])[0] });
    } else {
      varyingKeys.add('tag:' + name);
    }
  });

  return { common: common, varyingKeys: varyingKeys };
}

// Build label from an iteration showing only varying params/tags/benchmark
// that are NOT already shown by the group-by or series-by dimensions
function buildIterLabel(it, varyingKeys, excludeKeys) {
  var parts = [];
  // Include benchmark if it varies and isn't covered by group/series
  if (varyingKeys.has('benchmark') && !excludeKeys.has('benchmark')) {
    parts.push(it.benchmark || '');
  }
  (it.params || []).forEach(function (p) {
    var key = 'param:' + p.arg;
    if (varyingKeys.has(key) && !excludeKeys.has(key)) parts.push(p.arg + '=' + p.val);
  });
  (it.tags || []).forEach(function (t) {
    var key = 'tag:' + t.name;
    if (varyingKeys.has(key) && !excludeKeys.has(key)) parts.push(t.name + '=' + t.val);
  });
  return parts.join(', ') || it.iterationId.substring(0, 8);
}

function computeStddev(mv) {
  if (!mv || !mv.sampleValues || mv.sampleValues.length <= 1 || mv.mean == null) return 0;
  var mean = mv.mean;
  var variance = 0;
  for (var v = 0; v < mv.sampleValues.length; v++) {
    variance += (mv.sampleValues[v] - mean) * (mv.sampleValues[v] - mean);
  }
  return Math.sqrt(variance / (mv.sampleValues.length - 1));
}

// Natural sort: compare as numbers when both values are numeric, otherwise as strings
function naturalCompare(a, b) {
  var na = Number(a);
  var nb = Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Custom X-axis tick that wraps long labels into multiple lines
function WrappedAxisTick(props) {
  var x = props.x, y = props.y, payload = props.payload;
  if (!payload || !payload.value) return null;

  var value = String(payload.value);
  var segments = value.split(', ');
  var lines = [];
  var current = '';
  for (var i = 0; i < segments.length; i++) {
    if (current && (current + ', ' + segments[i]).length > 30) {
      lines.push(current);
      current = segments[i];
    } else {
      current = current ? current + ', ' + segments[i] : segments[i];
    }
  }
  if (current) lines.push(current);

  return (
    <g transform={'translate(' + x + ',' + y + ')'}>
      <text
        textAnchor="end"
        fontSize={11}
        fill="var(--text-secondary)"
        transform="rotate(-30)"
      >
        {lines.map(function (line, li) {
          return <tspan key={li} x={0} dy={li === 0 ? 0 : 14}>{line}</tspan>;
        })}
      </text>
    </g>
  );
}

// Build group info including per-group common items
// (items that vary globally but are the same within this group)
function buildGroupInfo(groupValue, size, iters, globalVaryingKeys, excludeKeys) {
  var label = formatDimLabel(excludeKeys.values().next().value || '') + '=' + formatDimValue('', groupValue);
  // For the first key in excludeKeys which is groupBy
  for (var k of excludeKeys) {
    if (k !== 'none') {
      label = formatDimLabel(k) + '=' + formatDimValue(k, groupValue);
      break;
    }
  }

  if (iters.length <= 1) {
    return { label: label, size: size, groupCommon: [] };
  }

  // Find params/tags that are in globalVaryingKeys but common within this group
  var groupCommon = [];
  var paramValues = {};
  var tagValues = {};
  var benchmarks = new Set();

  iters.forEach(function (it) {
    if (it.benchmark) benchmarks.add(it.benchmark);
    (it.params || []).forEach(function (p) {
      var key = 'param:' + p.arg;
      if (!globalVaryingKeys.has(key) || excludeKeys.has(key)) return;
      if (!paramValues[p.arg]) paramValues[p.arg] = new Set();
      paramValues[p.arg].add(String(p.val));
    });
    (it.tags || []).forEach(function (t) {
      var key = 'tag:' + t.name;
      if (!globalVaryingKeys.has(key) || excludeKeys.has(key)) return;
      if (!tagValues[t.name]) tagValues[t.name] = new Set();
      tagValues[t.name].add(t.val);
    });
  });

  if (globalVaryingKeys.has('benchmark') && !excludeKeys.has('benchmark') && benchmarks.size === 1) {
    groupCommon.push(Array.from(benchmarks)[0]);
  }
  Object.keys(paramValues).sort().forEach(function (arg) {
    if (paramValues[arg].size === 1) {
      groupCommon.push(arg + '=' + Array.from(paramValues[arg])[0]);
    }
  });
  Object.keys(tagValues).sort().forEach(function (name) {
    if (tagValues[name].size === 1) {
      groupCommon.push(name + '=' + Array.from(tagValues[name])[0]);
    }
  });

  return { label: label, size: size, groupCommon: groupCommon };
}

function buildDimOptions(iterations) {
  var opts = [{ value: 'none', label: 'None' }];
  // Only include dimensions that have more than one distinct value
  var runs = new Set();
  var benchmarks = new Set();
  var paramValues = {};
  var tagValues = {};
  for (var i = 0; i < iterations.length; i++) {
    var it = iterations[i];
    if (it.runId) runs.add(it.runId);
    if (it.benchmark) benchmarks.add(it.benchmark);
    (it.params || []).forEach(function (p) {
      if (!paramValues[p.arg]) paramValues[p.arg] = new Set();
      paramValues[p.arg].add(String(p.val));
    });
    (it.tags || []).forEach(function (t) {
      if (!tagValues[t.name]) tagValues[t.name] = new Set();
      tagValues[t.name].add(t.val);
    });
  }
  if (runs.size > 1) opts.push({ value: 'run', label: 'Run' });
  if (benchmarks.size > 1) opts.push({ value: 'benchmark', label: 'Benchmark' });
  Object.keys(paramValues).sort().forEach(function (arg) {
    if (paramValues[arg].size > 1) opts.push({ value: 'param:' + arg, label: 'Param: ' + arg });
  });
  Object.keys(tagValues).sort().forEach(function (name) {
    if (tagValues[name].size > 1) opts.push({ value: 'tag:' + name, label: 'Tag: ' + name });
  });
  return opts;
}

export default function CompareView({ selected, groupBy, setGroupBy, seriesBy, setSeriesBy }) {
  var [metricValues, setMetricValues] = useState({});
  var [loading, setLoading] = useState(false);
  var [supplementalMetrics, setSupplementalMetrics] = useState([]); // [{ source, type, values: {iterId: {mean,...}} }]
  var [availableSources, setAvailableSources] = useState(null);
  var [availableTypes, setAvailableTypes] = useState(null);
  var [addMetricSource, setAddMetricSource] = useState('');
  var [addMetricType, setAddMetricType] = useState('');
  var [addMetricLoading, setAddMetricLoading] = useState(false);
  var [addMetricDisplay, setAddMetricDisplay] = useState('panel'); // 'overlay' or 'panel'
  var [showAddMetric, setShowAddMetric] = useState(false);

  var iterations = useMemo(function () {
    return Array.from(selected.values());
  }, [selected]);

  // Helper to get run IDs and date range from iterations
  function getRunContext() {
    var runIdSet = new Set();
    iterations.forEach(function (it) { runIdSet.add(it.runId); });
    var runIds = Array.from(runIdSet);
    var begins = iterations.filter(function (it) { return it.runBegin; }).map(function (it) { return Number(it.runBegin); });
    var startDate = begins.length > 0 ? new Date(Math.min.apply(null, begins)) : null;
    var endDate = begins.length > 0 ? new Date(Math.max.apply(null, begins)) : null;
    var start = startDate ? startDate.getFullYear() + '.' + String(startDate.getMonth() + 1).padStart(2, '0') : null;
    var end = endDate ? endDate.getFullYear() + '.' + String(endDate.getMonth() + 1).padStart(2, '0') : null;
    return { runIds: runIds, start: start, end: end };
  }

  useEffect(function () {
    if (iterations.length === 0) return;
    var ctx = getRunContext();
    setLoading(true);
    setSupplementalMetrics([]);
    timeWork('Fetch metric values for compare (' + iterations.length + ' iterations)', function () {
      return api.getIterationMetricValues(ctx.runIds, ctx.start, ctx.end);
    }).then(function (res) {
      setMetricValues(res.values || {});
    }).catch(function (err) {
      console.error('Failed to fetch metric values:', err);
    }).finally(function () {
      setLoading(false);
    });
  }, [iterations]);

  var dimOptions = useMemo(function () {
    return buildDimOptions(iterations);
  }, [iterations]);

  var handleShowAddMetric = useCallback(function () {
    setShowAddMetric(true);
    setAddMetricSource('');
    setAddMetricType('');
    setAvailableTypes(null);
    if (!availableSources) {
      var ctx = getRunContext();
      api.getIterationMetricSources(ctx.runIds, ctx.start, ctx.end).then(function (res) {
        setAvailableSources(res.sources || []);
      });
    }
  }, [iterations, availableSources]);

  var handleSourceChange = useCallback(function (source) {
    setAddMetricSource(source);
    setAddMetricType('');
    setAvailableTypes(null);
    if (source) {
      var ctx = getRunContext();
      api.getIterationMetricTypes(ctx.runIds, ctx.start, ctx.end, source).then(function (res) {
        setAvailableTypes(res.types || []);
      });
    }
  }, [iterations]);

  var handleAddMetric = useCallback(function () {
    if (!addMetricSource || !addMetricType) return;
    // Check if already added
    var exists = supplementalMetrics.some(function (m) { return m.source === addMetricSource && m.type === addMetricType; });
    if (exists) { setShowAddMetric(false); return; }
    var ctx = getRunContext();
    setAddMetricLoading(true);
    timeWork('Fetch ' + addMetricSource + '::' + addMetricType, function () {
      return api.getSupplementalMetric(ctx.runIds, ctx.start, ctx.end, addMetricSource, addMetricType);
    }).then(function (res) {
      setSupplementalMetrics(function (prev) {
        return prev.concat([{ source: addMetricSource, type: addMetricType, values: res.values || {}, display: addMetricDisplay }]);
      });
      setShowAddMetric(false);
    }).catch(function (err) {
      console.error('Failed to fetch supplemental metric:', err);
    }).finally(function () {
      setAddMetricLoading(false);
    });
  }, [iterations, addMetricSource, addMetricType, addMetricDisplay, supplementalMetrics]);

  var handleRemoveMetric = useCallback(function (idx) {
    setSupplementalMetrics(function (prev) { return prev.filter(function (_, i) { return i !== idx; }); });
  }, []);

  // Build chart data: one entry per iteration, sorted/grouped, with gaps between groups
  var charts = useMemo(function () {
    var byMetric = {};
    for (var i = 0; i < iterations.length; i++) {
      var it = iterations[i];
      var pm = it.primaryMetric || 'unknown';
      if (!byMetric[pm]) byMetric[pm] = [];
      byMetric[pm].push(it);
    }

    var result = [];
    Object.keys(byMetric).forEach(function (metricName) {
      var iters = byMetric[metricName];

      // Compute common vs varying params/tags across these iterations
      var cv = computeCommonVarying(iters);
      var varyingKeys = cv.varyingKeys;
      var commonItems = cv.common;

      // Sort by group-by value, then series-by value (natural/numeric sort)
      var sorted = iters.slice().sort(function (a, b) {
        var cmp = naturalCompare(getDimValue(a, groupBy), getDimValue(b, groupBy));
        if (cmp !== 0) return cmp;
        return naturalCompare(getDimValue(a, seriesBy), getDimValue(b, seriesBy));
      });

      // Build series color map
      var seriesColorMap = {};
      if (seriesBy !== 'none') {
        var uniqueSeries = [];
        sorted.forEach(function (it) {
          var sv = getDimValue(it, seriesBy);
          if (!seriesColorMap.hasOwnProperty(sv)) {
            seriesColorMap[sv] = COLORS[uniqueSeries.length % COLORS.length];
            uniqueSeries.push(sv);
          }
        });
      }

      // Precompute per-group common keys (items that vary globally but are common within a group)
      var perGroupCommonKeys = {};
      if (groupBy !== 'none') {
        var groupedIters = {};
        sorted.forEach(function (it) {
          var gv = getDimValue(it, groupBy);
          if (!groupedIters[gv]) groupedIters[gv] = [];
          groupedIters[gv].push(it);
        });
        Object.keys(groupedIters).forEach(function (gv) {
          var gIters = groupedIters[gv];
          if (gIters.length <= 1) { perGroupCommonKeys[gv] = new Set(); return; }
          var pv = {};
          var tv = {};
          gIters.forEach(function (it) {
            (it.params || []).forEach(function (p) {
              if (!pv[p.arg]) pv[p.arg] = new Set();
              pv[p.arg].add(String(p.val));
            });
            (it.tags || []).forEach(function (t) {
              if (!tv[t.name]) tv[t.name] = new Set();
              tv[t.name].add(t.val);
            });
          });
          var common = new Set();
          Object.keys(pv).forEach(function (arg) {
            if (pv[arg].size === 1 && varyingKeys.has('param:' + arg)) common.add('param:' + arg);
          });
          Object.keys(tv).forEach(function (name) {
            if (tv[name].size === 1 && varyingKeys.has('tag:' + name)) common.add('tag:' + name);
          });
          perGroupCommonKeys[gv] = common;
        });
      }

      // Build chart data with gap entries between groups
      var chartData = [];
      var prevGroup = null;
      for (var i = 0; i < sorted.length; i++) {
        var it = sorted[i];
        var gv = getDimValue(it, groupBy);

        // Insert gap between groups
        if (groupBy !== 'none' && gv !== prevGroup) {
          if (prevGroup !== null) {
            chartData.push({ name: '', value: null, isGap: true });
          }
        }
        prevGroup = gv;

        var mv = metricValues[it.iterationId];
        var mean = mv ? mv.mean : null;
        var stddev = computeStddev(mv);
        var sv = getDimValue(it, seriesBy);

        // Build label excluding: group-by and per-group common keys.
        // Series-by is NOT excluded — each bar has a different series value
        // and it needs to be visible in the label for identification.
        var excludeKeys = new Set();
        if (groupBy !== 'none') excludeKeys.add(groupBy);
        var groupCommon = perGroupCommonKeys[gv];
        if (groupCommon) groupCommon.forEach(function (k) { excludeKeys.add(k); });
        var label = buildIterLabel(it, varyingKeys, excludeKeys);

        var entry = {
          name: label,
          value: mean,
          errorY: stddev,
          iterationId: it.iterationId,
          stddevPct: mv ? mv.stddevPct : null,
          samples: mv ? mv.sampleValues.length : 0,
          groupValue: gv,
          seriesValue: sv,
          color: seriesBy !== 'none' ? seriesColorMap[sv] : COLORS[i % COLORS.length],
          isGap: false,
        };
        // Add supplemental metric values with stddev for error bars
        supplementalMetrics.forEach(function (sm, si) {
          var smv = sm.values[it.iterationId];
          entry['supp_' + si] = smv ? smv.mean : null;
          entry['supp_' + si + '_stddevPct'] = smv ? smv.stddevPct : null;
          entry['supp_' + si + '_error'] = smv ? computeStddev(smv) : 0;
          entry['supp_' + si + '_samples'] = smv ? smv.sampleValues.length : 0;
        });
        chartData.push(entry);
      }

      // Build legend entries for series
      var legendData = [];
      if (seriesBy !== 'none') {
        Object.keys(seriesColorMap).forEach(function (sv) {
          legendData.push({ value: formatDimValue(seriesBy, sv), color: seriesColorMap[sv] });
        });
      }

      // Compute group sizes and per-group common items for labels above the chart
      var groupInfo = [];
      if (groupBy !== 'none') {
        // Collect iterations per group
        var groupIters = {};
        sorted.forEach(function (it) {
          var gv = getDimValue(it, groupBy);
          if (!groupIters[gv]) groupIters[gv] = [];
          groupIters[gv].push(it);
        });
        // Keys to exclude from per-group common: globally common, group-by, series-by
        var excludeFromGroupCommon = new Set();
        if (groupBy !== 'none') excludeFromGroupCommon.add(groupBy);
        if (seriesBy !== 'none') excludeFromGroupCommon.add(seriesBy);

        var currentGroup = null;
        var currentCount = 0;
        chartData.forEach(function (d) {
          if (d.isGap) return;
          if (d.groupValue !== currentGroup) {
            if (currentGroup !== null) {
              var gi = buildGroupInfo(currentGroup, currentCount, groupIters[currentGroup] || [], varyingKeys, excludeFromGroupCommon);
              groupInfo.push(gi);
            }
            currentGroup = d.groupValue;
            currentCount = 0;
          }
          currentCount++;
        });
        if (currentGroup !== null) {
          var gi = buildGroupInfo(currentGroup, currentCount, groupIters[currentGroup] || [], varyingKeys, excludeFromGroupCommon);
          groupInfo.push(gi);
        }
      }

      result.push({ metricName: metricName, data: chartData, legendData: legendData, commonItems: commonItems, groupInfo: groupInfo });
    });

    return result;
  }, [iterations, metricValues, groupBy, seriesBy, supplementalMetrics]);

  if (loading) {
    return (
      <div className="compare-view">
        <div className="compare-loading"><span className="spinner" /> Loading metric values...</div>
      </div>
    );
  }

  if (iterations.length === 0) {
    return (
      <div className="compare-view">
        <div className="empty-msg">Select iterations from the Search view to compare.</div>
      </div>
    );
  }

  return (
    <div className="compare-view">
      <div className="compare-controls">
        <div className="compare-control">
          <label>Group by</label>
          <select value={groupBy} onChange={function (e) { setGroupBy(e.target.value); }}>
            {dimOptions.map(function (o) { return <option key={o.value} value={o.value}>{o.label}</option>; })}
          </select>
        </div>
        <div className="compare-control">
          <label>Series by</label>
          <select value={seriesBy} onChange={function (e) { setSeriesBy(e.target.value); }}>
            {dimOptions.map(function (o) { return <option key={o.value} value={o.value}>{o.label}</option>; })}
          </select>
        </div>
        <div className="compare-control-spacer" />
        {!showAddMetric && (
          <button className="btn btn-sm btn-secondary" onClick={handleShowAddMetric}>
            + Add Metric
          </button>
        )}
        {showAddMetric && (
          <div className="compare-control">
            <label>Source</label>
            <select value={addMetricSource} onChange={function (e) { handleSourceChange(e.target.value); }}>
              <option value="">Select...</option>
              {(availableSources || []).map(function (s) { return <option key={s} value={s}>{s}</option>; })}
            </select>
          </div>
        )}
        {showAddMetric && addMetricSource && (
          <div className="compare-control">
            <label>Type</label>
            <select value={addMetricType} onChange={function (e) { setAddMetricType(e.target.value); }}>
              <option value="">Select...</option>
              {(availableTypes || []).map(function (t) { return <option key={t} value={t}>{t}</option>; })}
            </select>
          </div>
        )}
        {showAddMetric && addMetricSource && addMetricType && (
          <div className="compare-control">
            <label>Display</label>
            <div className="compare-display-toggle">
              <button className={'btn btn-sm ' + (addMetricDisplay === 'overlay' ? 'btn-primary' : 'btn-secondary')} onClick={function () { setAddMetricDisplay('overlay'); }}>Overlay</button>
              <button className={'btn btn-sm ' + (addMetricDisplay === 'panel' ? 'btn-primary' : 'btn-secondary')} onClick={function () { setAddMetricDisplay('panel'); }}>Own Panel</button>
            </div>
          </div>
        )}
        {showAddMetric && addMetricSource && addMetricType && (
          <button className="btn btn-sm btn-primary" onClick={handleAddMetric} disabled={addMetricLoading}>
            {addMetricLoading ? <><span className="spinner" style={{ marginRight: 4 }} /> Loading...</> : 'Add'}
          </button>
        )}
        {showAddMetric && (
          <button className="btn btn-sm btn-secondary" onClick={function () { setShowAddMetric(false); }}>Cancel</button>
        )}
      </div>
      {supplementalMetrics.length > 0 && (
        <div className="compare-supp-list">
          {supplementalMetrics.map(function (sm, si) {
            return (
              <span key={si} className="compare-supp-chip" style={{ borderColor: SUPP_COLORS[si % SUPP_COLORS.length], color: SUPP_COLORS[si % SUPP_COLORS.length] }}>
                {sm.source}::{sm.type}
                <span className="compare-supp-mode">{sm.display === 'panel' ? 'panel' : 'overlay'}</span>
                <button onClick={function () { handleRemoveMetric(si); }}>&times;</button>
              </span>
            );
          })}
        </div>
      )}

      {charts.map(function (chart, ci) {
        var nonGapData = chart.data.filter(function (d) { return !d.isGap; });
        if (nonGapData.length === 0) {
          return (
            <div key={ci} className="compare-chart-panel">
              <h3>{chart.metricName}</h3>
              <div className="empty-msg">No metric values available for these iterations.</div>
            </div>
          );
        }

        var chartHeight = Math.max(400, nonGapData.length * 30 + 150);
        var hasOverlays = supplementalMetrics.some(function (m) { return m.display !== 'panel'; });

        return (
          <div key={ci} className="compare-chart-panel">
            <h3>{chart.metricName}</h3>
            {chart.commonItems.length > 0 && (
              <div className="compare-subtitle">
                {chart.commonItems.map(function (c) { return c.key + '=' + c.val; }).join(', ')}
              </div>
            )}

            {chart.legendData.length > 0 && (
              <div className="compare-legend">
                {chart.legendData.map(function (ld) {
                  return (
                    <span key={ld.value} className="compare-legend-item">
                      <span className="compare-legend-swatch" style={{ background: ld.color }} />
                      {ld.value}
                    </span>
                  );
                })}
              </div>
            )}

            {chart.groupInfo.length > 0 && (
              <div className="compare-group-bar">
                {chart.groupInfo.map(function (g, gi) {
                  return (
                    <div key={gi} className="compare-group-bar-item" style={{ flex: g.size }}>
                      <div className="compare-group-bar-label">{g.label}</div>
                      {g.groupCommon && g.groupCommon.length > 0 && (
                        <div className="compare-group-bar-common">{g.groupCommon.join(', ')}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Panel-mode supplemental metrics: rendered above the primary chart */}
            {supplementalMetrics.map(function (sm, si) {
              if (sm.display !== 'panel') return null;
              var color = SUPP_COLORS[si % SUPP_COLORS.length];
              var dataKey = 'supp_' + si;
              var vals = [];
              chart.data.forEach(function (d) { if (!d.isGap && d[dataKey] != null) vals.push(d[dataKey]); });
              var min = vals.length > 0 ? Math.min.apply(null, vals) : 0;
              var max = vals.length > 0 ? Math.max.apply(null, vals) : 1;
              var pad = (max - min) * 0.1 || 0.1;
              return (
                <div key={'panel-' + si} className="compare-panel-metric">
                  <div className="compare-chart-with-labels">
                    <div className="compare-yaxis-label compare-yaxis-left" style={{ color: color }}>{sm.source}::{sm.type}</div>
                    <div className="compare-chart-area">
                  <ResponsiveContainer width="100%" height={180}>
                    <ComposedChart data={chart.data} margin={{ top: 10, right: 30, left: 60, bottom: 5 }} barCategoryGap="10%">
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="name" hide={true} />
                      <YAxis
                        yAxisId="left"
                        domain={[Math.max(0, min - pad), max + pad]}
                        tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                        tickFormatter={formatYTick}
                        stroke="var(--border)"
                      />
                      <Tooltip
                        content={function (props) {
                          if (!props.active || !props.payload || props.payload.length === 0) return null;
                          var entry = props.payload[0].payload;
                          if (!entry || entry.isGap) return null;
                          var v = entry[dataKey];
                          return (
                            <div style={{
                              background: 'var(--surface)', border: '1px solid var(--border)',
                              borderRadius: 'var(--radius)', padding: '8px 12px', color: 'var(--text)',
                              fontSize: 12, boxShadow: 'var(--shadow)',
                            }}>
                              {entry.name && <div>{entry.name}</div>}
                              <div style={{ fontWeight: 600, color: color, marginTop: 4 }}>
                                {sm.source}::{sm.type}: {v != null ? (function () {
                                  var txt = formatValue(v);
                                  var pct = entry[dataKey + '_stddevPct'];
                                  var samp = entry[dataKey + '_samples'];
                                  if (samp > 1 && pct != null) txt += ' (\u00b1' + pct.toFixed(1) + '%)';
                                  return txt;
                                })() : 'no data'}
                              </div>
                            </div>
                          );
                        }}
                      />
                      {hasOverlays ? (
                        <YAxis yAxisId="right" orientation="right" width={80} tick={false} axisLine={false} />
                      ) : (
                        <YAxis yAxisId="right" orientation="right" width={1} tick={false} axisLine={false} />
                      )}
                      <Bar dataKey={dataKey} yAxisId="left" radius={[3, 3, 0, 0]}>
                        <ErrorBar dataKey={dataKey + '_error'} width={4} strokeWidth={2} stroke="var(--text-secondary)" />
                        {chart.data.map(function (entry, idx) {
                          return <Cell key={idx} fill={entry.isGap ? 'transparent' : color} fillOpacity={0.7} />;
                        })}
                      </Bar>
                    </ComposedChart>
                  </ResponsiveContainer>
                    </div>
                    {hasOverlays && <div className="compare-yaxis-label compare-yaxis-right">&nbsp;</div>}
                  </div>
                </div>
              );
            })}

            <div className="compare-chart-with-labels">
              <div className="compare-yaxis-label compare-yaxis-left">{chart.metricName}</div>
              <div className="compare-chart-area">
            <ResponsiveContainer width="100%" height={chartHeight}>
              <ComposedChart data={chart.data} margin={{ top: 20, right: 30, left: 60, bottom: 120 }} barCategoryGap="10%">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="name"
                  height={120}
                  tick={<WrappedAxisTick />}
                  stroke="var(--border)"
                  interval={0}
                />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
                  tickFormatter={formatYTick}
                  stroke="var(--border)"
                />
                {supplementalMetrics.some(function (m) { return m.display !== 'panel'; }) && (function () {
                  // Compute domain from overlay-mode supplemental values only
                  var allVals = [];
                  chart.data.forEach(function (d) {
                    if (d.isGap) return;
                    supplementalMetrics.forEach(function (sm, si) {
                      if (sm.display === 'panel') return;
                      var v = d['supp_' + si];
                      if (v != null) allVals.push(v);
                    });
                  });
                  var min = allVals.length > 0 ? Math.min.apply(null, allVals) : 0;
                  var max = allVals.length > 0 ? Math.max.apply(null, allVals) : 1;
                  var pad = (max - min) * 0.1 || 0.1;
                  return (
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      width={80}
                      domain={[Math.max(0, min - pad), max + pad]}
                      tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
                      tickFormatter={formatYTick}
                      stroke="var(--border)"
                    />
                  );
                })()}
                {!hasOverlays && (
                  <YAxis yAxisId="right" orientation="right" width={1} tick={false} axisLine={false} />
                )}
                <Tooltip
                  content={function (props) {
                    if (!props.active || !props.payload || props.payload.length === 0) return null;
                    var entry = props.payload[0].payload;
                    if (!entry || entry.isGap || entry.value == null) return null;
                    var text = formatValue(entry.value);
                    if (entry.samples > 1 && entry.stddevPct != null) {
                      text += ' (\u00b1' + entry.stddevPct.toFixed(1) + '%)';
                    }
                    var lines = [];
                    if (entry.name) lines.push(entry.name);
                    if (entry.groupValue && entry.groupValue !== '__all__')
                      lines.push(formatDimLabel(groupBy) + ': ' + formatDimValue(groupBy, entry.groupValue));
                    if (entry.seriesValue && entry.seriesValue !== '__all__')
                      lines.push(formatDimLabel(seriesBy) + ': ' + formatDimValue(seriesBy, entry.seriesValue));
                    var metricLines = [];
                    metricLines.push({ label: chart.metricName, value: text, color: entry.color });
                    supplementalMetrics.forEach(function (sm, si) {
                      var sv = entry['supp_' + si];
                      var svPct = entry['supp_' + si + '_stddevPct'];
                      var svSamples = entry['supp_' + si + '_samples'];
                      var valText = sv != null ? formatValue(sv) : 'no data';
                      if (sv != null && svSamples > 1 && svPct != null) {
                        valText += ' (\u00b1' + svPct.toFixed(1) + '%)';
                      }
                      metricLines.push({
                        label: sm.source + '::' + sm.type,
                        value: valText,
                        color: SUPP_COLORS[si % SUPP_COLORS.length],
                      });
                    });
                    return (
                      <div style={{
                        background: 'var(--surface)', border: '1px solid var(--border)',
                        borderRadius: 'var(--radius)', padding: '8px 12px', color: 'var(--text)',
                        fontSize: 12, boxShadow: 'var(--shadow)',
                      }}>
                        {lines.map(function (l, i) {
                          return <div key={i} style={{ color: i === 0 ? 'var(--text)' : 'var(--text-secondary)', marginBottom: 2 }}>{l}</div>;
                        })}
                        {metricLines.map(function (ml, i) {
                          return <div key={'m' + i} style={{ fontWeight: 600, color: ml.color, marginTop: i === 0 ? 4 : 2 }}>{ml.label}: {ml.value}</div>;
                        })}
                      </div>
                    );
                  }}
                />
                <Bar dataKey="value" yAxisId="left" radius={[4, 4, 0, 0]}>
                  <ErrorBar dataKey="errorY" width={4} strokeWidth={2} stroke="var(--text-secondary)" />
                  {chart.data.map(function (entry, idx) {
                    return <Cell key={idx} fill={entry.isGap ? 'transparent' : entry.color} />;
                  })}
                </Bar>
                {supplementalMetrics.map(function (sm, si) {
                  if (sm.display === 'panel') return null;
                  return (
                    <Line
                      key={si}
                      dataKey={'supp_' + si}
                      yAxisId="right"
                      type="monotone"
                      stroke={SUPP_COLORS[si % SUPP_COLORS.length]}
                      strokeWidth={2}
                      dot={{ r: 5, fill: SUPP_COLORS[si % SUPP_COLORS.length] }}
                      connectNulls={false}
                      name={sm.source + '::' + sm.type}
                    />
                  );
                })}
              </ComposedChart>
            </ResponsiveContainer>
              </div>
              {hasOverlays ? (
                <div className="compare-yaxis-label compare-yaxis-right">
                  {supplementalMetrics.filter(function (m) { return m.display !== 'panel'; }).map(function (m) { return m.source + '::' + m.type; }).join(', ')}
                </div>
              ) : supplementalMetrics.length > 0 ? (
                <div className="compare-yaxis-label compare-yaxis-right">&nbsp;</div>
              ) : null}
            </div>

          </div>
        );
      })}
    </div>
  );
}
