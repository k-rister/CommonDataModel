import { useState, useEffect, useMemo, useCallback } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ErrorBar, ResponsiveContainer, Legend, Cell, ReferenceLine, LabelList } from 'recharts';
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

// Compact value for bar labels — max 4 significant digits
function formatBarLabel(v) {
  if (v == null) return '';
  var abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1000000) return (v / 1000000).toPrecision(3) + 'M';
  if (abs >= 1000) return (v / 1000).toPrecision(3) + 'k';
  if (abs >= 100) return v.toPrecision(4);
  if (abs >= 1) return v.toPrecision(3);
  return v.toPrecision(2);
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
function computeCommonVarying(iters, hiddenSet) {
  if (iters.length === 0) return { common: [], varyingKeys: new Set() };
  var hidden = hiddenSet || new Set();

  var benchmarks = new Set();
  var paramValues = {};
  var tagValues = {};

  iters.forEach(function (it) {
    if (it.benchmark && !hidden.has('benchmark')) benchmarks.add(it.benchmark);
    (it.params || []).forEach(function (p) {
      if (hidden.has('param:' + p.arg)) return;
      if (!paramValues[p.arg]) paramValues[p.arg] = new Set();
      paramValues[p.arg].add(String(p.val));
    });
    (it.tags || []).forEach(function (t) {
      if (hidden.has('tag:' + t.name)) return;
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
  // Collect varying params and tags, then group by value to consolidate
  // e.g., bs=4k, rw=4k, size=4k becomes bs,rw,size=4k
  var items = [];
  if (varyingKeys.has('benchmark') && !excludeKeys.has('benchmark')) {
    items.push({ name: 'benchmark', val: it.benchmark || '' });
  }
  (it.params || []).forEach(function (p) {
    var key = 'param:' + p.arg;
    if (varyingKeys.has(key) && !excludeKeys.has(key)) {
      items.push({ name: p.arg, val: String(p.val) });
    }
  });
  (it.tags || []).forEach(function (t) {
    var key = 'tag:' + t.name;
    if (varyingKeys.has(key) && !excludeKeys.has(key)) {
      items.push({ name: t.name, val: t.val });
    }
  });
  // Group names that share the same value
  var byVal = {};
  var valOrder = [];
  items.forEach(function (item) {
    if (!byVal[item.val]) {
      byVal[item.val] = [];
      valOrder.push(item.val);
    }
    byVal[item.val].push(item.name);
  });
  var parts = [];
  valOrder.forEach(function (val) {
    parts.push(byVal[val].join(',') + '=' + val);
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
  // groupValue is already the formatted compound label (e.g., "nthreads=1, gro=on")
  var label = groupValue;

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

// Compute compound group key from multiple group-by dimensions
function getCompoundGroupValue(it, groupByList) {
  if (!groupByList || groupByList.length === 0) return '__all__';
  return groupByList.map(function (dim) {
    return formatDimLabel(dim) + '=' + formatDimValue(dim, getDimValue(it, dim));
  }).join(', ');
}

function hasGroupBy(groupByList) {
  return groupByList && groupByList.length > 0;
}

// Parse a breakout label like "<host1>-<0>" into segments ["<host1>", "<0>"]
function parseBreakoutSegments(label) {
  if (!label) return [];
  // Match all <...> segments
  var matches = label.match(/<[^>]*>/g);
  return matches || [label];
}

// Render breakout items as a table with rowSpan for repeated segment values
// items: [{ segments: ["<host1>", "<0>"], value: "45.2", color: "#..." }, ...]
// breakoutNames: ["hostname", "package"]
function renderGroupedBreakouts(items, depth, breakoutNames) {
  if (items.length === 0) return null;

  // Build rows: each row has parsed segment values and the metric value
  var rows = items.map(function (it) {
    var segVals = it.segments.map(function (s) { return s.replace(/^</, '').replace(/>$/, ''); });
    return { segVals: segVals, value: it.value, color: it.color };
  });

  // Sort rows by segments (natural sort, left to right)
  rows.sort(function (a, b) {
    for (var i = 0; i < Math.max(a.segVals.length, b.segVals.length); i++) {
      var cmp = naturalCompare(a.segVals[i] || '', b.segVals[i] || '');
      if (cmp !== 0) return cmp;
    }
    return 0;
  });

  var numCols = rows.length > 0 ? rows[0].segVals.length : 0;

  // Compute rowSpans for each cell
  // rowSpans[row][col] = number of rows this cell spans, or 0 if hidden (spanned by cell above)
  var rowSpans = rows.map(function () { return new Array(numCols).fill(1); });
  for (var col = 0; col < numCols; col++) {
    for (var row = rows.length - 1; row > 0; row--) {
      // Check if this cell and all cells to its left match the row above
      var matches = true;
      for (var c = 0; c <= col; c++) {
        if (rows[row].segVals[c] !== rows[row - 1].segVals[c]) { matches = false; break; }
      }
      if (matches) {
        rowSpans[row][col] = 0; // hidden
        rowSpans[row - 1][col] += rowSpans[row][col] || 1; // not right, need to find the span start
      }
    }
  }
  // Recompute spans properly: scan top-down
  for (var col2 = 0; col2 < numCols; col2++) {
    rowSpans.forEach(function (r) { r[col2] = 1; }); // reset
    var spanStart = 0;
    for (var row2 = 1; row2 <= rows.length; row2++) {
      var same = row2 < rows.length;
      if (same) {
        for (var c2 = 0; c2 <= col2; c2++) {
          if (rows[row2].segVals[c2] !== rows[spanStart].segVals[c2]) { same = false; break; }
        }
      }
      if (!same) {
        rowSpans[spanStart][col2] = row2 - spanStart;
        for (var r2 = spanStart + 1; r2 < row2; r2++) rowSpans[r2][col2] = 0;
        spanStart = row2;
      }
    }
  }

  // Build column headers and deduplicate common suffixes from text values
  var headers = [];
  var commonSuffixes = [];
  for (var h = 0; h < numCols; h++) {
    var name = (breakoutNames && h < breakoutNames.length) ? breakoutNames[h] : '';
    if (name.indexOf('=') >= 0) name = name.substring(0, name.indexOf('='));

    // Collect unique values for this column
    var uniqueVals = [];
    var seen = {};
    rows.forEach(function (r) {
      var v = r.segVals[h] || '';
      if (!seen[v]) { seen[v] = true; uniqueVals.push(v); }
    });

    var suffix = '';
    var prefix = '';
    var delimiters = '.,-_/';
    // Only dedupe if: >1 unique value, all look like text (not purely numeric)
    if (uniqueVals.length > 1 && !uniqueVals.every(function (v) { return /^\d+$/.test(v); })) {
      // Try common suffix first (at a delimiter boundary)
      var first = uniqueVals[0];
      for (var si = first.length - 1; si > 0; si--) {
        if (delimiters.indexOf(first[si]) >= 0 || delimiters.indexOf(first[si - 1]) >= 0) {
          var candSuffix = first.substring(si);
          if (candSuffix.length >= 2 && uniqueVals.every(function (v) { return v.endsWith(candSuffix); })) {
            suffix = candSuffix;
          }
        }
      }
      // If no suffix found, try common prefix (at a delimiter boundary)
      if (!suffix) {
        for (var pi = 1; pi < first.length; pi++) {
          if (delimiters.indexOf(first[pi]) >= 0 || delimiters.indexOf(first[pi - 1]) >= 0) {
            var candPrefix = first.substring(0, pi + 1);
            if (candPrefix.length >= 2 && uniqueVals.every(function (v) { return v.startsWith(candPrefix); })) {
              prefix = candPrefix;
            }
          }
        }
      }
    }

    // Strip suffix or prefix from row values
    if (suffix) {
      rows.forEach(function (r) {
        if (r.segVals[h]) r.segVals[h] = r.segVals[h].substring(0, r.segVals[h].length - suffix.length);
      });
    } else if (prefix) {
      rows.forEach(function (r) {
        if (r.segVals[h]) r.segVals[h] = r.segVals[h].substring(prefix.length);
      });
    }

    commonSuffixes.push({ suffix: suffix, prefix: prefix });
    headers.push(name);
  }

  // Recompute rowSpans after suffix stripping may have changed values
  for (var col3 = 0; col3 < numCols; col3++) {
    var spanStart2 = 0;
    for (var row3 = 0; row3 <= rows.length; row3++) {
      var same2 = row3 < rows.length;
      if (same2) {
        for (var c3 = 0; c3 <= col3; c3++) {
          if (rows[row3].segVals[c3] !== rows[spanStart2].segVals[c3]) { same2 = false; break; }
        }
      }
      if (!same2) {
        rowSpans[spanStart2][col3] = row3 - spanStart2;
        for (var r3 = spanStart2 + 1; r3 < row3; r3++) rowSpans[r3][col3] = 0;
        spanStart2 = row3;
      }
    }
  }

  return (
    <table className="compare-sidebar-table">
      <thead>
        <tr>
          {headers.map(function (hdr, hi) {
            var cs = commonSuffixes[hi];
            return (
              <th key={hi}>
                {cs.prefix && <span className="compare-sidebar-table-affix">{cs.prefix}</span>}
                {hdr}
                {cs.suffix && <span className="compare-sidebar-table-affix">{cs.suffix}</span>}
              </th>
            );
          })}
          <th>value</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(function (row, ri) {
          return (
            <tr key={ri}>
              {row.segVals.map(function (sv, ci) {
                if (rowSpans[ri][ci] === 0) return null;
                return <td key={ci} rowSpan={rowSpans[ri][ci]} className="compare-sidebar-table-seg">{sv}</td>;
              })}
              <td className="compare-sidebar-table-val" style={{ color: row.color }}>{row.value}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
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

export default function CompareView({ selected, groupByList, setGroupByList, hiddenFields, setHiddenFields }) {
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
  var [pinnedEntry, setPinnedEntry] = useState(null);

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
    var iterPairs = iterations.map(function (it) { return { iterationId: it.iterationId, runId: it.runId }; });
    return { runIds: runIds, start: start, end: end, iterations: iterPairs };
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

  var hiddenSet = useMemo(function () { return new Set(hiddenFields); }, [hiddenFields]);

  var dimOptions = useMemo(function () {
    return buildDimOptions(iterations).filter(function (o) { return !hiddenSet.has(o.value); });
  }, [iterations, hiddenSet]);

  // All dimension options (including hidden) for the hide field picker
  var allDimOptions = useMemo(function () {
    return buildDimOptions(iterations).filter(function (o) { return o.value !== 'none'; });
  }, [iterations]);

  var handleAutoGroup = useCallback(function () {
    // Compute distinct value counts for each varying dimension
    var dimCounts = [];
    dimOptions.forEach(function (o) {
      if (o.value === 'none') return;
      var vals = new Set();
      iterations.forEach(function (it) {
        vals.add(getDimValue(it, o.value));
      });
      dimCounts.push({ value: o.value, count: vals.size });
    });
    // Sort by distinct count ascending (fewest values = best grouping level)
    dimCounts.sort(function (a, b) { return a.count - b.count; });
    // Use all but the last one as group-by (last one stays as bar label)
    if (dimCounts.length > 1) {
      setGroupByList(dimCounts.slice(0, dimCounts.length - 1).map(function (d) { return d.value; }));
    } else if (dimCounts.length === 1) {
      setGroupByList([dimCounts[0].value]);
    }
  }, [iterations, dimOptions]);

  // Auto-group on first render when no group-by is set
  useEffect(function () {
    if (groupByList.length === 0 && iterations.length > 0 && dimOptions.length > 1) {
      handleAutoGroup();
    }
  }, [iterations.length > 0 && dimOptions.length > 1]);

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

  // Compute best sample index from primary metric values (closest to mean)
  function computeBestSampleIndex() {
    // Find the most common sample count and compute best index from first iteration with values
    var bestIdx = 0;
    for (var itId in metricValues) {
      var mv = metricValues[itId];
      if (mv && mv.sampleValues && mv.sampleValues.length > 1) {
        var sum = 0;
        for (var v = 0; v < mv.sampleValues.length; v++) sum += mv.sampleValues[v];
        var mean = sum / mv.sampleValues.length;
        var bestDiff = Infinity;
        for (var s = 0; s < mv.sampleValues.length; s++) {
          var diff = Math.abs(mv.sampleValues[s] - mean);
          if (diff < bestDiff) { bestDiff = diff; bestIdx = s; }
        }
        break; // Use the first iteration's best sample as default
      }
    }
    return bestIdx;
  }

  var handleAddMetric = useCallback(function () {
    if (!addMetricSource || !addMetricType) return;
    var exists = supplementalMetrics.some(function (m) { return m.source === addMetricSource && m.type === addMetricType; });
    if (exists) { setShowAddMetric(false); return; }
    var ctx = getRunContext();
    var bestIdx = computeBestSampleIndex();
    setAddMetricLoading(true);
    timeWork('Fetch ' + addMetricSource + '::' + addMetricType, function () {
      return api.getSupplementalMetric({ iterations: ctx.iterations, start: ctx.start, end: ctx.end, source: addMetricSource, type: addMetricType, sampleIndex: bestIdx });
    }).then(function (res) {
      setSupplementalMetrics(function (prev) {
        return prev.concat([{
          source: addMetricSource,
          type: addMetricType,
          values: res.values || {},
          display: addMetricDisplay,
          chartType: 'bar',         // 'bar', 'stacked', 'line'
          filter: '',               // e.g., 'gt:0.01', 'lt:100'
          sampleIndex: bestIdx,     // client-computed best sample
          breakouts: [],            // active breakout dimensions
          remainingBreakouts: res.remainingBreakouts || [],
          loading: false,
        }]);
      });
      setShowAddMetric(false);
    }).catch(function (err) {
      console.error('Failed to fetch supplemental metric:', err);
    }).finally(function () {
      setAddMetricLoading(false);
    });
  }, [iterations, addMetricSource, addMetricType, addMetricDisplay, supplementalMetrics]);

  var handleAddBreakout = useCallback(function (si, breakoutName) {
    var sm = supplementalMetrics[si];
    var newBreakouts = sm.breakouts.concat([breakoutName]);
    // Mark as loading
    setSupplementalMetrics(function (prev) {
      var next = prev.slice();
      next[si] = Object.assign({}, next[si], { loading: true });
      return next;
    });
    var ctx = getRunContext();
    timeWork('Breakout ' + sm.source + '::' + sm.type + ' by ' + breakoutName, function () {
      return api.getSupplementalMetric({ iterations: ctx.iterations, start: ctx.start, end: ctx.end, source: sm.source, type: sm.type, breakout: newBreakouts, filter: sm.filter, sampleIndex: sm.sampleIndex });
    }).then(function (res) {
      setSupplementalMetrics(function (prev) {
        var next = prev.slice();
        next[si] = Object.assign({}, next[si], {
          values: res.values || {},
          sampleInfo: res.sampleInfo || next[si].sampleInfo,
          breakouts: newBreakouts,
          remainingBreakouts: res.remainingBreakouts || [],
          loading: false,
        });
        return next;
      });
    }).catch(function (err) {
      console.error('Failed to add breakout:', err);
      setSupplementalMetrics(function (prev) {
        var next = prev.slice();
        next[si] = Object.assign({}, next[si], { loading: false });
        return next;
      });
    });
  }, [iterations, supplementalMetrics]);

  var handleRemoveBreakout = useCallback(function (si, breakoutIdx) {
    var sm = supplementalMetrics[si];
    var newBreakouts = sm.breakouts.slice(0, breakoutIdx);
    setSupplementalMetrics(function (prev) {
      var next = prev.slice();
      next[si] = Object.assign({}, next[si], { loading: true });
      return next;
    });
    var ctx = getRunContext();
    timeWork('Remove breakout from ' + sm.source + '::' + sm.type, function () {
      return api.getSupplementalMetric({ iterations: ctx.iterations, start: ctx.start, end: ctx.end, source: sm.source, type: sm.type, breakout: newBreakouts, filter: sm.filter, sampleIndex: sm.sampleIndex });
    }).then(function (res) {
      setSupplementalMetrics(function (prev) {
        var next = prev.slice();
        next[si] = Object.assign({}, next[si], {
          values: res.values || {},
          sampleInfo: res.sampleInfo || next[si].sampleInfo,
          breakouts: newBreakouts,
          remainingBreakouts: res.remainingBreakouts || [],
          loading: false,
        });
        return next;
      });
    });
  }, [iterations, supplementalMetrics]);

  var handleSampleChange = useCallback(function (si, newSampleIndex) {
    var idx = newSampleIndex === 'auto' ? computeBestSampleIndex() : parseInt(newSampleIndex, 10);
    var sm = supplementalMetrics[si];
    setSupplementalMetrics(function (prev) {
      var next = prev.slice();
      next[si] = Object.assign({}, next[si], { sampleIndex: idx, loading: true });
      return next;
    });
    var ctx = getRunContext();
    timeWork('Switch sample for ' + sm.source + '::' + sm.type, function () {
      return api.getSupplementalMetric({ iterations: ctx.iterations, start: ctx.start, end: ctx.end, source: sm.source, type: sm.type, breakout: sm.breakouts, filter: sm.filter, sampleIndex: idx });
    }).then(function (res) {
      setSupplementalMetrics(function (prev) {
        var next = prev.slice();
        next[si] = Object.assign({}, next[si], {
          values: res.values || {},
          sampleInfo: res.sampleInfo || next[si].sampleInfo,
          remainingBreakouts: res.remainingBreakouts || [],
          loading: false,
        });
        return next;
      });
    }).catch(function (err) {
      console.error('Failed to switch sample:', err);
      setSupplementalMetrics(function (prev) {
        var next = prev.slice();
        next[si] = Object.assign({}, next[si], { loading: false });
        return next;
      });
    });
  }, [iterations, supplementalMetrics]);

  // Update metric filter value locally (no re-query yet)
  var handleUpdateFilter = useCallback(function (si, newFilter) {
    setSupplementalMetrics(function (prev) {
      var next = prev.slice();
      next[si] = Object.assign({}, next[si], { filter: newFilter });
      return next;
    });
  }, []);

  // Apply metric filter (re-query)
  var handleApplyFilter = useCallback(function (si) {
    var sm = supplementalMetrics[si];
    setSupplementalMetrics(function (prev) {
      var next = prev.slice();
      next[si] = Object.assign({}, next[si], { loading: true });
      return next;
    });
    var ctx = getRunContext();
    timeWork('Apply filter for ' + sm.source + '::' + sm.type, function () {
      return api.getSupplementalMetric({ iterations: ctx.iterations, start: ctx.start, end: ctx.end, source: sm.source, type: sm.type, breakout: sm.breakouts, filter: sm.filter, sampleIndex: sm.sampleIndex });
    }).then(function (res) {
      setSupplementalMetrics(function (prev) {
        var next = prev.slice();
        next[si] = Object.assign({}, next[si], {
          values: res.values || {},
          remainingBreakouts: res.remainingBreakouts || [],
          loading: false,
        });
        return next;
      });
    }).catch(function (err) {
      console.error('Failed to apply filter:', err);
      setSupplementalMetrics(function (prev) {
        var next = prev.slice();
        next[si] = Object.assign({}, next[si], { loading: false });
        return next;
      });
    });
  }, [iterations, supplementalMetrics]);

  // Update breakout filter value locally (no re-query yet)
  var handleUpdateBreakoutFilter = useCallback(function (si, bi, newBreakout) {
    setSupplementalMetrics(function (prev) {
      var next = prev.slice();
      var breakouts = next[si].breakouts.slice();
      breakouts[bi] = newBreakout;
      next[si] = Object.assign({}, next[si], { breakouts: breakouts });
      return next;
    });
  }, []);

  // Re-query metric with current breakout filters
  var handleApplyBreakoutFilter = useCallback(function (si) {
    var sm = supplementalMetrics[si];
    setSupplementalMetrics(function (prev) {
      var next = prev.slice();
      next[si] = Object.assign({}, next[si], { loading: true });
      return next;
    });
    var ctx = getRunContext();
    timeWork('Apply breakout filter for ' + sm.source + '::' + sm.type, function () {
      return api.getSupplementalMetric({ iterations: ctx.iterations, start: ctx.start, end: ctx.end, source: sm.source, type: sm.type, breakout: sm.breakouts, filter: sm.filter, sampleIndex: sm.sampleIndex });
    }).then(function (res) {
      setSupplementalMetrics(function (prev) {
        var next = prev.slice();
        next[si] = Object.assign({}, next[si], {
          values: res.values || {},
          remainingBreakouts: res.remainingBreakouts || [],
          loading: false,
        });
        return next;
      });
    }).catch(function (err) {
      console.error('Failed to apply breakout filter:', err);
      setSupplementalMetrics(function (prev) {
        var next = prev.slice();
        next[si] = Object.assign({}, next[si], { loading: false });
        return next;
      });
    });
  }, [iterations, supplementalMetrics]);

  var handleChartTypeChange = useCallback(function (si, chartType) {
    setSupplementalMetrics(function (prev) {
      var next = prev.slice();
      next[si] = Object.assign({}, next[si], { chartType: chartType });
      return next;
    });
  }, []);

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
      var cv = computeCommonVarying(iters, hiddenSet);
      var varyingKeys = cv.varyingKeys;
      var commonItems = cv.common;

      // Sort by compound group-by value, then series-by value (natural/numeric sort)
      var sorted = iters.slice().sort(function (a, b) {
        var ga = getCompoundGroupValue(a, groupByList);
        var gb = getCompoundGroupValue(b, groupByList);
        var cmp = naturalCompare(ga, gb);
        if (cmp !== 0) return cmp;
        return 0;
      });


      // Precompute per-group common keys (items that vary globally but are common within a group)
      var perGroupCommonKeys = {};
      if (hasGroupBy(groupByList)) {
        var groupedIters = {};
        sorted.forEach(function (it) {
          var gv = getCompoundGroupValue(it, groupByList);
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
        var gv = getCompoundGroupValue(it, groupByList);

        // Insert gap between groups
        if (hasGroupBy(groupByList) && gv !== prevGroup) {
          if (prevGroup !== null) {
            chartData.push({ name: '', value: null, isGap: true });
          }
        }
        prevGroup = gv;

        var mv = metricValues[it.iterationId];
        var mean = mv ? mv.mean : null;
        var stddev = computeStddev(mv);
        // Build label excluding: group-by and per-group common keys.
        var excludeKeys = new Set();
        groupByList.forEach(function (dim) { excludeKeys.add(dim); });
        hiddenSet.forEach(function (dim) { excludeKeys.add(dim); });
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
          color: COLORS[i % COLORS.length],
          isGap: false,
        };
        // Add supplemental metric values with stddev for error bars
        // Format: sm.values[iterId] = { labels: { label: { mean, stddevPct, sampleValues } } }
        supplementalMetrics.forEach(function (sm, si) {
          var smv = sm.values[it.iterationId];
          if (smv && smv.labels) {
            var labelKeys = Object.keys(smv.labels);
            // Use the first label for the aggregate value (works for no-breakout case)
            if (labelKeys.length >= 1) {
              var lv = smv.labels[labelKeys[0]];
              entry['supp_' + si] = lv.mean;
              entry['supp_' + si + '_stddevPct'] = lv.stddevPct;
              entry['supp_' + si + '_error'] = computeStddev(lv);
              entry['supp_' + si + '_samples'] = lv.sampleValues ? lv.sampleValues.length : 0;
            }
            // For breakouts with multiple labels, also store per-label data
            if (labelKeys.length > 1) {
              labelKeys.forEach(function (lk) {
                var lv = smv.labels[lk];
                entry['supp_' + si + '_' + lk] = lv.mean;
              });
            }
          } else {
            entry['supp_' + si] = null;
            entry['supp_' + si + '_stddevPct'] = null;
            entry['supp_' + si + '_error'] = 0;
            entry['supp_' + si + '_samples'] = 0;
          }
        });
        chartData.push(entry);
      }


      // Compute group sizes and per-group common items for labels above the chart
      var groupInfo = [];
      if (hasGroupBy(groupByList)) {
        // Collect iterations per group
        var groupIters = {};
        sorted.forEach(function (it) {
          var gv = getCompoundGroupValue(it, groupByList);
          if (!groupIters[gv]) groupIters[gv] = [];
          groupIters[gv].push(it);
        });
        // Keys to exclude from per-group common: group-by dims, series-by
        var excludeFromGroupCommon = new Set();
        groupByList.forEach(function (dim) { excludeFromGroupCommon.add(dim); });

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

      result.push({ metricName: metricName, data: chartData, commonItems: commonItems, groupInfo: groupInfo });
    });

    return result;
  }, [iterations, metricValues, groupByList, supplementalMetrics, hiddenSet]);

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
          {groupByList.map(function (dim, gi) {
            return (
              <span key={gi} className="compare-groupby-chip">
                {gi > 0 && (
                  <button className="compare-chip-arrow" onClick={function () {
                    var next = groupByList.slice();
                    next[gi] = next[gi - 1];
                    next[gi - 1] = dim;
                    setGroupByList(next);
                  }} title="Move left">&lsaquo;</button>
                )}
                <span className="compare-chip-label">{dimOptions.find(function (o) { return o.value === dim; })?.label || dim}</span>
                {gi < groupByList.length - 1 && (
                  <button className="compare-chip-arrow" onClick={function () {
                    var next = groupByList.slice();
                    next[gi] = next[gi + 1];
                    next[gi + 1] = dim;
                    setGroupByList(next);
                  }} title="Move right">&rsaquo;</button>
                )}
                <button onClick={function () { setGroupByList(groupByList.filter(function (_, i) { return i !== gi; })); }}>&times;</button>
              </span>
            );
          })}
          <select
            value=""
            onChange={function (e) {
              if (e.target.value && !groupByList.includes(e.target.value)) {
                setGroupByList(groupByList.concat([e.target.value]));
              }
            }}
          >
            <option value="">{groupByList.length === 0 ? 'None' : '+ Add'}</option>
            {dimOptions.filter(function (o) { return o.value !== 'none' && !groupByList.includes(o.value); }).map(function (o) {
              return <option key={o.value} value={o.value}>{o.label}</option>;
            })}
          </select>
          <button className="btn btn-sm btn-secondary" onClick={handleAutoGroup} title="Auto-select group-by dimensions to minimize bar labels">
            Auto
          </button>
          {groupByList.length > 0 && (
            <button className="btn btn-sm btn-secondary" onClick={function () { setGroupByList([]); }}>
              Clear
            </button>
          )}
        </div>
        <div className="compare-control">
          <label>Hide</label>
          {hiddenFields.map(function (dim, hi) {
            var opt = allDimOptions.find(function (o) { return o.value === dim; });
            return (
              <span key={hi} className="compare-hidden-chip">
                {opt ? opt.label : dim}
                <button onClick={function () { setHiddenFields(hiddenFields.filter(function (_, i) { return i !== hi; })); }}>&times;</button>
              </span>
            );
          })}
          <select
            value=""
            onChange={function (e) {
              if (e.target.value && !hiddenFields.includes(e.target.value)) {
                // Also remove from groupByList and seriesBy if hidden
                setHiddenFields(hiddenFields.concat([e.target.value]));
                if (groupByList.includes(e.target.value)) {
                  setGroupByList(groupByList.filter(function (d) { return d !== e.target.value; }));
                }
              }
            }}
          >
            <option value="">{hiddenFields.length === 0 ? 'None' : '+ Hide'}</option>
            {allDimOptions.filter(function (o) { return !hiddenFields.includes(o.value); }).map(function (o) {
              return <option key={o.value} value={o.value}>{o.label}</option>;
            })}
          </select>
        </div>
      </div>
      <div className="compare-add-metric-bar">
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
        <div className="compare-metric-panel">
          {supplementalMetrics.map(function (sm, si) {
            var color = SUPP_COLORS[si % SUPP_COLORS.length];
            return (
              <div key={si} className="compare-metric-row" style={{ borderLeftColor: color }}>
                <div className="compare-metric-row-header">
                  <span className="compare-metric-name" style={{ color: color }}>{sm.source}::{sm.type}</span>
                  <span className="compare-supp-mode">{sm.display === 'panel' ? 'panel' : 'overlay'}</span>
                  {sm.loading && <span className="spinner" style={{ marginLeft: 8 }} />}
                  {!sm.loading && sm.remainingBreakouts && sm.remainingBreakouts.length > 0 && (
                    <select
                      className="compare-breakout-select"
                      value=""
                      onChange={function (e) { if (e.target.value) handleAddBreakout(si, e.target.value); }}
                    >
                      <option value="">+ Breakout</option>
                      {sm.remainingBreakouts.map(function (b) { return <option key={b} value={b}>{b}</option>; })}
                    </select>
                  )}
                  {sm.breakouts.length > 0 && (
                    <select
                      className="compare-breakout-select"
                      value={sm.chartType || 'bar'}
                      onChange={function (e) { handleChartTypeChange(si, e.target.value); }}
                    >
                      <option value="bar">Bars</option>
                      <option value="stacked">Stacked</option>
                      <option value="line">Lines</option>
                    </select>
                  )}
                  {(function () {
                    // Show sample selector using primary metric values from metricValues
                    // Find first iteration with multiple samples
                    var sampleVals = null;
                    for (var ii = 0; ii < iterations.length; ii++) {
                      var mv2 = metricValues[iterations[ii].iterationId];
                      if (mv2 && mv2.sampleValues && mv2.sampleValues.length > 1) {
                        sampleVals = mv2.sampleValues;
                        break;
                      }
                    }
                    if (!sampleVals || sampleVals.length <= 1) return null;
                    return (
                      <span className="compare-filter-group">
                        <label className="compare-filter-label">Sample:</label>
                        <select
                          className="compare-breakout-select"
                          value={sm.sampleIndex != null ? sm.sampleIndex : 'auto'}
                          onChange={function (e) { handleSampleChange(si, e.target.value); }}
                        >
                          <option value="auto">Best (auto)</option>
                          {sampleVals.map(function (pmv, idx2) {
                            var label2 = 'Sample ' + (idx2 + 1);
                            if (pmv != null) label2 += ' (' + formatValue(pmv) + ')';
                            return <option key={idx2} value={idx2}>{label2}</option>;
                          })}
                        </select>
                      </span>
                    );
                  })()}
                  <span className="compare-filter-group">
                    <label className="compare-filter-label">Filter:</label>
                    <input
                      className="compare-filter-input"
                      type="text"
                      placeholder="e.g. gt:0.01"
                      value={sm.filter || ''}
                      title="gt:N, ge:N, lt:N, le:N"
                      onClick={function (e) { e.stopPropagation(); }}
                      onChange={function (e) { handleUpdateFilter(si, e.target.value); }}
                      onKeyDown={function (e) {
                        if (e.key === 'Enter') { e.preventDefault(); handleApplyFilter(si); }
                      }}
                    />
                    {sm.filter && (
                      <button className="btn btn-sm btn-secondary" onClick={function () { handleApplyFilter(si); }}
                        disabled={sm.loading} style={{ fontSize: 10, padding: '2px 6px' }}>
                        Apply
                      </button>
                    )}
                  </span>
                  <button className="compare-metric-remove" onClick={function () { handleRemoveMetric(si); }}>&times;</button>
                </div>
                {sm.breakouts.length > 0 && (
                  <div className="compare-metric-breakouts">
                    {sm.breakouts.map(function (b, bi) {
                      // Parse breakout: "field" or "field=value"
                      var eqIdx = b.indexOf('=');
                      var fieldName = eqIdx >= 0 ? b.substring(0, eqIdx) : b;
                      var filterVal = eqIdx >= 0 ? b.substring(eqIdx + 1) : '';
                      return (
                        <span key={bi} className="compare-breakout-chip">
                          <span className="compare-breakout-field">{fieldName}</span>
                          <input
                            className="compare-breakout-filter"
                            type="text"
                            placeholder="all"
                            value={filterVal}
                            title="Filter: exact value, val1+val2, r/regex/, R/regex/"
                            onClick={function (e) { e.stopPropagation(); }}
                            onChange={function (e) {
                              var newVal = e.target.value;
                              var newBreakout = newVal ? fieldName + '=' + newVal : fieldName;
                              handleUpdateBreakoutFilter(si, bi, newBreakout);
                            }}
                            onKeyDown={function (e) {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                handleApplyBreakoutFilter(si);
                              }
                            }}
                          />
                          <button onClick={function () { handleRemoveBreakout(si, bi); }}>&times;</button>
                        </span>
                      );
                    })}
                    <button className="btn btn-sm btn-secondary" onClick={function () { handleApplyBreakoutFilter(si); }}
                      disabled={sm.loading} style={{ fontSize: 10, padding: '2px 6px' }}>
                      Apply
                    </button>
                  </div>
                )}
              </div>
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


            {false && supplementalMetrics.map(function (sm, si) {
              if (sm.display !== 'panel') return null;
              var color = SUPP_COLORS[si % SUPP_COLORS.length];
              var dataKey = 'supp_' + si;
              var vals = [];
              chart.data.forEach(function (d) {
                if (d.isGap) return;
                if (d[dataKey] != null) vals.push(d[dataKey]);
                // Also include breakout label values for domain
                Object.keys(d).forEach(function (k) {
                  if (k.startsWith(dataKey + '_') && !k.endsWith('_stddevPct') && !k.endsWith('_error') && !k.endsWith('_samples') && d[k] != null) {
                    vals.push(d[k]);
                  }
                });
              });
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
                          return (
                            <div className="compare-tooltip-mini">
                              {entry.name}
                            </div>
                          );
                        }}
                      />
                      {hasOverlays ? (
                        <YAxis yAxisId="right" orientation="right" width={80} tick={false} axisLine={false} />
                      ) : (
                        <YAxis yAxisId="right" orientation="right" width={1} tick={false} axisLine={false} />
                      )}
                      {(function () {
                        // Detect breakout labels from chart data
                        if (sm.breakouts.length > 0) {
                          var labelSet = new Set();
                          chart.data.forEach(function (d) {
                            if (d.isGap) return;
                            Object.keys(d).forEach(function (k) {
                              var prefix = dataKey + '_';
                              if (k.startsWith(prefix) && !k.endsWith('_stddevPct') && !k.endsWith('_error') && !k.endsWith('_samples')) {
                                labelSet.add(k);
                              }
                            });
                          });
                          var labels = Array.from(labelSet).sort(naturalCompare);
                          var ct = sm.chartType || 'bar';
                          if (labels.length > 0) {
                            return labels.map(function (lk, li) {
                              var labelName = lk.substring((dataKey + '_').length);
                              var itemColor = SUPP_COLORS[(si + li) % SUPP_COLORS.length];
                              if (ct === 'line') {
                                return (
                                  <Line key={lk} dataKey={lk} yAxisId="left" type="monotone"
                                    stroke={itemColor} strokeWidth={2}
                                    dot={{ r: 4, fill: itemColor }}
                                    connectNulls={false} name={labelName} />
                                );
                              }
                              return (
                                <Bar key={lk} dataKey={lk} yAxisId="left"
                                  radius={ct === 'stacked' ? [0, 0, 0, 0] : [3, 3, 0, 0]}
                                  stackId={ct === 'stacked' ? 'stack' : undefined}
                                  name={labelName}>
                                  <LabelList dataKey={lk} content={function (props) {
                                    if (ct === 'stacked') {
                                      // For stacked: check both width and individual segment height
                                      var val3 = props.value;
                                      var w3 = props.width;
                                      var h3 = props.height;
                                      if (val3 == null || w3 == null || h3 == null) return null;
                                      var text3 = formatBarLabel(val3);
                                      if (text3.length * 8 > w3 - 4 || Math.abs(h3) < 14) return null;
                                      return (
                                        <text x={props.x + w3 / 2} y={props.y + h3 / 2} textAnchor="middle" dominantBaseline="middle"
                                          fontSize={12} fontWeight={700} fontFamily="ui-monospace, Consolas, monospace"
                                          fill="rgba(255,255,255,0.9)">{text3}</text>
                                      );
                                    }
                                    var val2 = props.value;
                                    var w2 = props.width;
                                    var h2 = props.height;
                                    if (val2 == null || w2 == null || h2 == null) return null;
                                    var text2 = formatBarLabel(val2);
                                    if (text2.length * 8 > w2 - 4 || h2 < 16) return null;
                                    return (
                                      <text x={props.x + w2 / 2} y={props.y + h2 / 2} textAnchor="middle" dominantBaseline="middle"
                                        fontSize={12} fontWeight={700} fontFamily="ui-monospace, Consolas, monospace"
                                        fill="rgba(255,255,255,0.9)">{text2}</text>
                                    );
                                  }} />
                                  {chart.data.map(function (entry, idx) {
                                    var isPinnedBk = pinnedEntry && pinnedEntry.entry && pinnedEntry.entry.iterationId === entry.iterationId;
                                    var bkOpacity = pinnedEntry ? (isPinnedBk ? 0.9 : 0.2) : 0.7;
                                    return <Cell key={idx} fill={entry.isGap ? 'transparent' : itemColor} fillOpacity={bkOpacity} />;
                                  })}
                                </Bar>
                              );
                            });
                          }
                        }
                        // No breakouts — single bar
                        return (
                          <Bar dataKey={dataKey} yAxisId="left" radius={[3, 3, 0, 0]}>
                            <ErrorBar dataKey={dataKey + '_error'} width={4} strokeWidth={2} stroke="var(--text-secondary)" />
                            <LabelList dataKey={dataKey} content={function (props) {
                              var val4 = props.value;
                              var w4 = props.width;
                              var h4 = props.height;
                              if (val4 == null || w4 == null || h4 == null) return null;
                              var text4 = formatBarLabel(val4);
                              if (text4.length * 8 > w4 - 4 || h4 < 16) return null;
                              return (
                                <text x={props.x + w4 / 2} y={props.y + h4 / 2} textAnchor="middle" dominantBaseline="middle"
                                  fontSize={12} fontWeight={700} fontFamily="ui-monospace, Consolas, monospace"
                                  fill="rgba(255,255,255,0.9)">{text4}</text>
                              );
                            }} />
                            {chart.data.map(function (entry, idx) {
                              var isPinnedCell = pinnedEntry && pinnedEntry.entry && pinnedEntry.entry.iterationId === entry.iterationId;
                              var cellOpacity = pinnedEntry ? (isPinnedCell ? 0.9 : 0.2) : 0.7;
                              return <Cell key={idx} fill={entry.isGap ? 'transparent' : color} fillOpacity={cellOpacity} />;
                            })}
                          </Bar>
                        );
                      })()}
                    </ComposedChart>
                  </ResponsiveContainer>
                    </div>
                    {supplementalMetrics.length > 0 && <div className="compare-yaxis-label compare-yaxis-right">&nbsp;</div>}
                    <div className="compare-sidebar" style={{ maxHeight: 180 }}>
                    {pinnedEntry && pinnedEntry.entry && !pinnedEntry.entry.isGap ? (function () {
                      var e = pinnedEntry.entry;
                      if (sm.breakouts.length > 0) {
                        var prefix = dataKey + '_';
                        var flatItems = [];
                        Object.keys(e).filter(function (k) {
                          return k.startsWith(prefix) && !k.endsWith('_stddevPct') && !k.endsWith('_error') && !k.endsWith('_samples');
                        }).sort(naturalCompare).forEach(function (k, ki) {
                          var labelName = k.substring(prefix.length);
                          flatItems.push({ label: labelName, value: e[k] != null ? formatValue(e[k]) : '-', color: SUPP_COLORS[(si + ki) % SUPP_COLORS.length] });
                        });
                          // Parse labels into segments for hierarchical grouping
                        var groupItems = flatItems.map(function (item) {
                          return { segments: parseBreakoutSegments(item.label), value: item.value, color: item.color };
                        });
                        return renderGroupedBreakouts(groupItems, 0, sm.breakouts);
                      } else {
                        var v = e[dataKey];
                        return (
                          <div className="compare-sidebar-item" style={{ color: color }}>
                            <div className="compare-sidebar-label">{sm.source}::{sm.type}</div>
                            <div className="compare-sidebar-value">{v != null ? formatValue(v) : '-'}</div>
                          </div>
                        );
                      }
                    })() : <div className="compare-sidebar-empty">Click a bar</div>}
                    </div>
                  </div>
                </div>
              );
            })}

            <div className="compare-chart-with-labels">
              <div className="compare-yaxis-label compare-yaxis-left">{chart.metricName}</div>
              <div className="compare-chart-area">
            {/* Hierarchical group-by headers — inside chart-area for alignment */}
            {hasGroupBy(groupByList) && (function () {
              var nonGaps = chart.data.filter(function (d) { return !d.isGap; });
              var iterMap = {};
              iterations.forEach(function (it) { iterMap[it.iterationId] = it; });
              var levels = [];
              groupByList.forEach(function (dim) {
                var spans = [];
                var currentVal = null;
                var currentCount = 0;
                nonGaps.forEach(function (d) {
                  var origIter = iterMap[d.iterationId];
                  var val = origIter ? getDimValue(origIter, dim) : '';
                  if (val !== currentVal) {
                    if (currentVal !== null) spans.push({ value: formatDimValue(dim, currentVal), count: currentCount });
                    currentVal = val;
                    currentCount = 0;
                  }
                  currentCount++;
                });
                if (currentVal !== null) spans.push({ value: formatDimValue(dim, currentVal), count: currentCount });
                levels.push({ label: formatDimLabel(dim), spans: spans });
              });
              return levels.map(function (level, li) {
                return (
                  <div key={li} className="compare-hier-row" style={{ marginLeft: 60, marginRight: 30 }}>
                    <div className="compare-hier-label">{level.label}</div>
                    <div className="compare-hier-spans">
                      {level.spans.map(function (span, si2) {
                        return (
                          <div key={si2} className="compare-hier-span" style={{ flex: span.count }}>
                            {span.value}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              });
            })()}
            <ResponsiveContainer width="100%" height={chartHeight}>
              <ComposedChart data={chart.data} margin={{ top: 20, right: 30, left: 60, bottom: 40 }} barCategoryGap="10%">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="name"
                  height={40}
                  tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                  angle={-45}
                  textAnchor="end"
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
                    return (
                      <div className="compare-tooltip-mini">
                        {entry.name}
                      </div>
                    );
                  }}
                />
                {pinnedEntry && pinnedEntry.entry && pinnedEntry.entry.name && (
                  <ReferenceLine x={pinnedEntry.entry.name} yAxisId="left" stroke="#ff6b6b" strokeDasharray="6 4" strokeWidth={2} />
                )}
                <Bar dataKey="value" yAxisId="left" radius={[4, 4, 0, 0]} style={{ cursor: 'pointer' }}
                  onClick={function (data) {
                    if (data && !data.isGap && data.value != null) {
                      setPinnedEntry(function (prev) {
                        if (prev && prev.entry && prev.entry.iterationId === data.iterationId) return null;
                        return { entry: data, metricName: chart.metricName };
                      });
                    }
                  }}
                >
                  <ErrorBar dataKey="errorY" width={4} strokeWidth={2} stroke="var(--text-secondary)" />
                  <LabelList dataKey="value" content={function (props) {
                    var val = props.value;
                    var w = props.width;
                    var h = props.height;
                    if (val == null || w == null || h == null) return null;
                    var text = formatBarLabel(val);
                    var charWidth = 8; // approximate pixels per character at font-size 12
                    var textWidth = text.length * charWidth;
                    // Show inside bar if it fits width-wise and bar is tall enough
                    if (textWidth > w - 4) return null;
                    if (h < 16) return null;
                    return (
                      <text x={props.x + w / 2} y={props.y + h / 2} textAnchor="middle" dominantBaseline="middle"
                        fontSize={12} fontWeight={700} fontFamily="ui-monospace, Consolas, monospace"
                        fill="rgba(255,255,255,0.9)">
                        {text}
                      </text>
                    );
                  }} />
                  {chart.data.map(function (entry, idx) {
                    var isPinned = pinnedEntry && pinnedEntry.entry && pinnedEntry.entry.iterationId === entry.iterationId;
                    var opacity = pinnedEntry ? (isPinned ? 1 : 0.3) : 1;
                    return <Cell key={idx} fill={entry.isGap ? 'transparent' : entry.color} fillOpacity={opacity} />;
                  })}
                </Bar>
                {supplementalMetrics.map(function (sm, si) {
                  if (sm.display === 'panel') return null;
                  var color = SUPP_COLORS[si % SUPP_COLORS.length];
                  // If breakouts produce multiple labels, render one line per label
                  if (sm.breakouts.length > 0) {
                    var labelSet = new Set();
                    chart.data.forEach(function (d) {
                      if (d.isGap) return;
                      Object.keys(d).forEach(function (k) {
                        if (k.startsWith('supp_' + si + '_') && !k.endsWith('_stddevPct') && !k.endsWith('_error') && !k.endsWith('_samples') && k !== 'supp_' + si) {
                          labelSet.add(k);
                        }
                      });
                    });
                    return Array.from(labelSet).sort(naturalCompare).map(function (lk, li) {
                      var labelName = lk.substring(('supp_' + si + '_').length);
                      return (
                        <Line
                          key={si + '-' + li}
                          dataKey={lk}
                          yAxisId="right"
                          type="monotone"
                          stroke={SUPP_COLORS[(si + li) % SUPP_COLORS.length]}
                          strokeWidth={2}
                          dot={{ r: 4, fill: SUPP_COLORS[(si + li) % SUPP_COLORS.length] }}
                          connectNulls={false}
                          name={labelName}
                        />
                      );
                    });
                  }
                  return (
                    <Line
                      key={si}
                      dataKey={'supp_' + si}
                      yAxisId="right"
                      type="monotone"
                      stroke={color}
                      strokeWidth={2}
                      dot={{ r: 5, fill: color }}
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
              <div className="compare-sidebar" style={{ maxHeight: chartHeight }}>
                {pinnedEntry && pinnedEntry.entry && !pinnedEntry.entry.isGap && pinnedEntry.entry.value != null ? (function () {
                  var e = pinnedEntry.entry;
                  var items = [];
                  var pmText = formatValue(e.value);
                  if (e.samples > 1 && e.stddevPct != null) pmText += ' (\u00b1' + e.stddevPct.toFixed(1) + '%)';
                  items.push({ label: chart.metricName, value: pmText, color: e.color });
                  supplementalMetrics.forEach(function (sm2, si2) {
                    if (sm2.display === 'panel') return;
                    var sv = e['supp_' + si2];
                    items.push({ label: sm2.source + '::' + sm2.type, value: sv != null ? formatValue(sv) : '-', color: SUPP_COLORS[si2 % SUPP_COLORS.length] });
                  });
                  return (
                    <>
                      <div className="compare-sidebar-iter">{e.name}</div>
                      {items.map(function (item, ii) {
                        return (
                          <div key={ii} className="compare-sidebar-item" style={{ color: item.color }}>
                            <div className="compare-sidebar-label">{item.label}</div>
                            <div className="compare-sidebar-value">{item.value}</div>
                          </div>
                        );
                      })}
                    </>
                  );
                })() : <div className="compare-sidebar-empty">Click a bar</div>}
              </div>
            </div>

            {/* Panel-mode supplemental metrics: rendered below the primary chart */}
            {supplementalMetrics.map(function (sm, si) {
              if (sm.display !== 'panel') return null;
              var color = SUPP_COLORS[si % SUPP_COLORS.length];
              var dataKey = 'supp_' + si;
              var vals = [];
              chart.data.forEach(function (d) {
                if (d.isGap) return;
                if (d[dataKey] != null) vals.push(d[dataKey]);
                Object.keys(d).forEach(function (k) {
                  if (k.startsWith(dataKey + '_') && !k.endsWith('_stddevPct') && !k.endsWith('_error') && !k.endsWith('_samples') && d[k] != null) {
                    vals.push(d[k]);
                  }
                });
              });
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
                          return (
                            <div className="compare-tooltip-mini">
                              {entry.name}
                            </div>
                          );
                        }}
                      />
                      {hasOverlays ? (
                        <YAxis yAxisId="right" orientation="right" width={80} tick={false} axisLine={false} />
                      ) : (
                        <YAxis yAxisId="right" orientation="right" width={1} tick={false} axisLine={false} />
                      )}
                      {pinnedEntry && pinnedEntry.entry && pinnedEntry.entry.name && (
                        <ReferenceLine x={pinnedEntry.entry.name} yAxisId="left" stroke="#ff6b6b" strokeDasharray="6 4" strokeWidth={2} />
                      )}
                      {(function () {
                        if (sm.breakouts.length > 0) {
                          var labelSet = new Set();
                          chart.data.forEach(function (d) {
                            if (d.isGap) return;
                            Object.keys(d).forEach(function (k) {
                              var prefix = dataKey + '_';
                              if (k.startsWith(prefix) && !k.endsWith('_stddevPct') && !k.endsWith('_error') && !k.endsWith('_samples')) {
                                labelSet.add(k);
                              }
                            });
                          });
                          var labels = Array.from(labelSet).sort(naturalCompare);
                          var ct = sm.chartType || 'bar';
                          if (labels.length > 0) {
                            return labels.map(function (lk, li) {
                              var labelName = lk.substring((dataKey + '_').length);
                              var itemColor = SUPP_COLORS[(si + li) % SUPP_COLORS.length];
                              if (ct === 'line') {
                                return (
                                  <Line key={lk} dataKey={lk} yAxisId="left" type="monotone"
                                    stroke={itemColor} strokeWidth={2}
                                    dot={{ r: 4, fill: itemColor }}
                                    connectNulls={false} name={labelName} />
                                );
                              }
                              return (
                                <Bar key={lk} dataKey={lk} yAxisId="left"
                                  radius={ct === 'stacked' ? [0, 0, 0, 0] : [3, 3, 0, 0]}
                                  stackId={ct === 'stacked' ? 'stack' : undefined}
                                  name={labelName}>
                                  <LabelList dataKey={lk} content={function (props) {
                                    if (ct === 'stacked') {
                                      // For stacked: check both width and individual segment height
                                      var val3 = props.value;
                                      var w3 = props.width;
                                      var h3 = props.height;
                                      if (val3 == null || w3 == null || h3 == null) return null;
                                      var text3 = formatBarLabel(val3);
                                      if (text3.length * 8 > w3 - 4 || Math.abs(h3) < 14) return null;
                                      return (
                                        <text x={props.x + w3 / 2} y={props.y + h3 / 2} textAnchor="middle" dominantBaseline="middle"
                                          fontSize={12} fontWeight={700} fontFamily="ui-monospace, Consolas, monospace"
                                          fill="rgba(255,255,255,0.9)">{text3}</text>
                                      );
                                    }
                                    var val2 = props.value;
                                    var w2 = props.width;
                                    var h2 = props.height;
                                    if (val2 == null || w2 == null || h2 == null) return null;
                                    var text2 = formatBarLabel(val2);
                                    if (text2.length * 8 > w2 - 4 || h2 < 16) return null;
                                    return (
                                      <text x={props.x + w2 / 2} y={props.y + h2 / 2} textAnchor="middle" dominantBaseline="middle"
                                        fontSize={12} fontWeight={700} fontFamily="ui-monospace, Consolas, monospace"
                                        fill="rgba(255,255,255,0.9)">{text2}</text>
                                    );
                                  }} />
                                  {chart.data.map(function (entry, idx) {
                                    var isPinnedBk = pinnedEntry && pinnedEntry.entry && pinnedEntry.entry.iterationId === entry.iterationId;
                                    var bkOpacity = pinnedEntry ? (isPinnedBk ? 0.9 : 0.2) : 0.7;
                                    return <Cell key={idx} fill={entry.isGap ? 'transparent' : itemColor} fillOpacity={bkOpacity} />;
                                  })}
                                </Bar>
                              );
                            });
                          }
                        }
                        return (
                          <Bar dataKey={dataKey} yAxisId="left" radius={[3, 3, 0, 0]}>
                            <ErrorBar dataKey={dataKey + '_error'} width={4} strokeWidth={2} stroke="var(--text-secondary)" />
                            <LabelList dataKey={dataKey} content={function (props) {
                              var val4 = props.value;
                              var w4 = props.width;
                              var h4 = props.height;
                              if (val4 == null || w4 == null || h4 == null) return null;
                              var text4 = formatBarLabel(val4);
                              if (text4.length * 8 > w4 - 4 || h4 < 16) return null;
                              return (
                                <text x={props.x + w4 / 2} y={props.y + h4 / 2} textAnchor="middle" dominantBaseline="middle"
                                  fontSize={12} fontWeight={700} fontFamily="ui-monospace, Consolas, monospace"
                                  fill="rgba(255,255,255,0.9)">{text4}</text>
                              );
                            }} />
                            {chart.data.map(function (entry, idx) {
                              var isPinnedCell = pinnedEntry && pinnedEntry.entry && pinnedEntry.entry.iterationId === entry.iterationId;
                              var cellOpacity = pinnedEntry ? (isPinnedCell ? 0.9 : 0.2) : 0.7;
                              return <Cell key={idx} fill={entry.isGap ? 'transparent' : color} fillOpacity={cellOpacity} />;
                            })}
                          </Bar>
                        );
                      })()}
                    </ComposedChart>
                  </ResponsiveContainer>
                    </div>
                    {supplementalMetrics.length > 0 && <div className="compare-yaxis-label compare-yaxis-right">&nbsp;</div>}
                    <div className="compare-sidebar" style={{ maxHeight: 180 }}>
                    {pinnedEntry && pinnedEntry.entry && !pinnedEntry.entry.isGap ? (function () {
                      var e = pinnedEntry.entry;
                      if (sm.breakouts.length > 0) {
                        var prefix = dataKey + '_';
                        var flatItems = [];
                        Object.keys(e).filter(function (k) {
                          return k.startsWith(prefix) && !k.endsWith('_stddevPct') && !k.endsWith('_error') && !k.endsWith('_samples');
                        }).sort(naturalCompare).forEach(function (k, ki) {
                          var labelName = k.substring(prefix.length);
                          flatItems.push({ label: labelName, value: e[k] != null ? formatValue(e[k]) : '-', color: SUPP_COLORS[(si + ki) % SUPP_COLORS.length] });
                        });
                          // Parse labels into segments for hierarchical grouping
                        var groupItems = flatItems.map(function (item) {
                          return { segments: parseBreakoutSegments(item.label), value: item.value, color: item.color };
                        });
                        return renderGroupedBreakouts(groupItems, 0, sm.breakouts);
                      } else {
                        var v = e[dataKey];
                        return (
                          <div className="compare-sidebar-item" style={{ color: color }}>
                            <div className="compare-sidebar-label">{sm.source}::{sm.type}</div>
                            <div className="compare-sidebar-value">{v != null ? formatValue(v) : '-'}</div>
                          </div>
                        );
                      }
                    })() : <div className="compare-sidebar-empty">Click a bar</div>}
                    </div>
                  </div>
                </div>
              );
            })}

          </div>
        );
      })}

    </div>
  );
}
