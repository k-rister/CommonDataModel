import { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ErrorBar, ResponsiveContainer, Legend, Cell, ReferenceLine } from 'recharts';
import * as api from '../api/cdm';
import { timeWork } from '../debugLog';

const COLORS = [
  '#5b8def', '#4ade80', '#fbbf24', '#f87171', '#a78bfa',
  '#34d399', '#fb923c', '#f472b6', '#38bdf8', '#facc15',
  '#818cf8', '#2dd4bf', '#e879f9', '#f97316', '#a3e635',
];

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
  var opts = [{ value: 'none', label: 'None' }, { value: 'run', label: 'Run' }, { value: 'benchmark', label: 'Benchmark' }];
  var paramArgs = new Set();
  var tagNames = new Set();
  for (var i = 0; i < iterations.length; i++) {
    var it = iterations[i];
    (it.params || []).forEach(function (p) { paramArgs.add(p.arg); });
    (it.tags || []).forEach(function (t) { tagNames.add(t.name); });
  }
  Array.from(paramArgs).sort().forEach(function (arg) {
    opts.push({ value: 'param:' + arg, label: 'Param: ' + arg });
  });
  Array.from(tagNames).sort().forEach(function (name) {
    opts.push({ value: 'tag:' + name, label: 'Tag: ' + name });
  });
  return opts;
}

export default function CompareView({ selected }) {
  var [metricValues, setMetricValues] = useState({});
  var [loading, setLoading] = useState(false);
  var [groupBy, setGroupBy] = useState('none');
  var [seriesBy, setSeriesBy] = useState('none');

  var iterations = useMemo(function () {
    return Array.from(selected.values());
  }, [selected]);

  useEffect(function () {
    if (iterations.length === 0) return;
    var runIdSet = new Set();
    iterations.forEach(function (it) { runIdSet.add(it.runId); });
    var runIds = Array.from(runIdSet);
    var begins = iterations.filter(function (it) { return it.runBegin; }).map(function (it) { return Number(it.runBegin); });
    var startDate = begins.length > 0 ? new Date(Math.min.apply(null, begins)) : null;
    var endDate = begins.length > 0 ? new Date(Math.max.apply(null, begins)) : null;
    var start = startDate ? startDate.getFullYear() + '.' + String(startDate.getMonth() + 1).padStart(2, '0') : null;
    var end = endDate ? endDate.getFullYear() + '.' + String(endDate.getMonth() + 1).padStart(2, '0') : null;

    setLoading(true);
    timeWork('Fetch metric values for compare (' + iterations.length + ' iterations)', function () {
      return api.getIterationMetricValues(runIds, start, end);
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

        chartData.push({
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
        });
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
  }, [iterations, metricValues, groupBy, seriesBy]);

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
      </div>

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

            <ResponsiveContainer width="100%" height={chartHeight}>
              <BarChart data={chart.data} margin={{ top: 20, right: 30, left: 60, bottom: 120 }} barCategoryGap="10%">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="name"
                  height={120}
                  tick={<WrappedAxisTick />}
                  stroke="var(--border)"
                  interval={0}
                />
                <YAxis
                  tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
                  stroke="var(--border)"
                  label={{
                    value: chart.metricName,
                    angle: -90,
                    position: 'insideLeft',
                    offset: -45,
                    style: { fontSize: 13, fill: 'var(--text-secondary)' },
                  }}
                />
                <Tooltip
                  content={function (props) {
                    if (!props.active || !props.payload || props.payload.length === 0) return null;
                    var entry = props.payload[0].payload;
                    if (!entry || entry.isGap || entry.isGroupLabel || entry.value == null) return null;
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
                    return (
                      <div style={{
                        background: 'var(--surface)', border: '1px solid var(--border)',
                        borderRadius: 'var(--radius)', padding: '8px 12px', color: 'var(--text)',
                        fontSize: 12, boxShadow: 'var(--shadow)',
                      }}>
                        {lines.map(function (l, i) {
                          return <div key={i} style={{ color: i === 0 ? 'var(--text)' : 'var(--text-secondary)', marginBottom: 2 }}>{l}</div>;
                        })}
                        <div style={{ fontWeight: 600, color: entry.color, marginTop: 4 }}>
                          {chart.metricName}: {text}
                        </div>
                      </div>
                    );
                  }}
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  <ErrorBar dataKey="errorY" width={4} strokeWidth={2} stroke="var(--text-secondary)" />
                  {chart.data.map(function (entry, idx) {
                    return <Cell key={idx} fill={entry.isGap || entry.isGroupLabel ? 'transparent' : entry.color} />;
                  })}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        );
      })}
    </div>
  );
}
