import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import * as api from '../api/cdm';
import { timeWork } from '../debugLog';

var COLORS = [
  '#5b8def', '#ef5b5b', '#5bef8d', '#efb85b', '#b85bef',
  '#5bcdef', '#ef5bcd', '#8def5b', '#cd5bef', '#ef8d5b',
  '#5b5bef', '#5bef5b', '#ef5b8d', '#8d5bef', '#5befcd',
];

function formatValue(v) {
  if (v == null) return '';
  v = Number(v);
  if (isNaN(v)) return '';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}

function formatElapsed(ms) {
  if (ms == null) return '';
  var sec = ms / 1000;
  if (sec < 60) return sec.toFixed(1) + 's';
  if (sec < 3600) return (sec / 60).toFixed(1) + 'm';
  return (sec / 3600).toFixed(1) + 'h';
}

// Build a short label for an iteration from its varying params
function buildIterShortLabel(it, allIterations) {
  if (!it) return '';
  // Compute varying params across all iterations
  var paramValues = {};
  var tagValues = {};
  allIterations.forEach(function (iter) {
    (iter.params || []).forEach(function (p) {
      if (!paramValues[p.arg]) paramValues[p.arg] = new Set();
      paramValues[p.arg].add(String(p.val));
    });
    (iter.tags || []).forEach(function (t) {
      if (!tagValues[t.name]) tagValues[t.name] = new Set();
      tagValues[t.name].add(t.val);
    });
  });
  var parts = [];
  (it.params || []).forEach(function (p) {
    if (paramValues[p.arg] && paramValues[p.arg].size > 1) {
      parts.push(p.arg + '=' + p.val);
    }
  });
  (it.tags || []).forEach(function (t) {
    if (tagValues[t.name] && tagValues[t.name].size > 1) {
      parts.push(t.name + '=' + t.val);
    }
  });
  return parts.join(', ') || it.iterationId.substring(0, 8);
}

// Parse breakout label like "<host1>-<0>" into segments ["host1", "0"]
function parseSegments(label) {
  if (!label) return [];
  var matches = label.match(/<[^>]*>/g);
  if (!matches) return [label];
  return matches.map(function (s) { return s.replace(/^</, '').replace(/>$/, ''); });
}

// Natural sort
function naturalCompare(a, b) {
  var na = Number(a);
  var nb = Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export default function DeepDiveView({ selected, deepDiveMetrics, metricConfigs: metricConfigsProp }) {
  var [resolution, setResolution] = useState(100);
  var [periodInfo, setPeriodInfo] = useState(null);
  var [metricData, setMetricData] = useState({});
  var [loadingPeriods, setLoadingPeriods] = useState(false);
  var [loadingMetrics, setLoadingMetrics] = useState(new Set());
  var [pinnedElapsed, setPinnedElapsed] = useState(null); // elapsed ms value for pinned (locked) time
  var [hoverElapsed, setHoverElapsed] = useState(null); // elapsed ms value for live hover time
  var abortRef = useRef(false);

  var iterations = useMemo(function () {
    return Array.from(selected.values());
  }, [selected]);

  var metricList = useMemo(function () {
    return Array.from(deepDiveMetrics);
  }, [deepDiveMetrics]);

  // Build a lookup of metric configs from the snapshot passed by App
  var configLookup = useMemo(function () {
    var lookup = {};
    (metricConfigsProp || []).forEach(function (sm) {
      var key = sm.source + '::' + sm.type;
      lookup[key] = {
        breakouts: sm.breakouts || [],
        filter: sm.filter || null,
        sampleIndex: sm.sampleIndex,
      };
    });
    return lookup;
  }, [metricConfigsProp]);

  // Fetch period info on mount
  useEffect(function () {
    if (iterations.length === 0 || metricList.length === 0) return;
    abortRef.current = false;
    setLoadingPeriods(true);
    setMetricData({});

    var ctx = {
      iterations: iterations.map(function (it) { return { iterationId: it.iterationId, runId: it.runId }; }),
    };
    // Infer date range
    var begins = iterations.filter(function (it) { return it.runBegin; }).map(function (it) { return Number(it.runBegin); });
    var startDate = begins.length > 0 ? new Date(Math.min.apply(null, begins)) : null;
    var endDate = begins.length > 0 ? new Date(Math.max.apply(null, begins)) : null;
    ctx.start = startDate ? startDate.getFullYear() + '.' + String(startDate.getMonth() + 1).padStart(2, '0') : null;
    ctx.end = endDate ? endDate.getFullYear() + '.' + String(endDate.getMonth() + 1).padStart(2, '0') : null;

    timeWork('Fetch period info for deep dive', function () {
      return api.getPeriodInfo(ctx);
    }).then(function (res) {
      if (abortRef.current) return;
      setPeriodInfo(res.periods || {});
      setLoadingPeriods(false);

      // Fetch metric data sequentially per metric, iterations within each metric run concurrently.
      // Serializing metrics avoids overwhelming OpenSearch with concurrent aggregation queries
      // that cause thread pool contention and multi-minute stalls.
      var periods = res.periods || {};
      (async function () {
        for (var mi = 0; mi < metricList.length; mi++) {
          if (abortRef.current) return;
          var metricKey = metricList[mi];
          var parts = metricKey.split('::');
          if (parts.length < 2) continue;
          var source = parts[0];
          var type = parts[1];
          var config = configLookup[metricKey] || {};
          var breakouts = config.breakouts || [];

          // Mark all iterations for this metric as loading
          var loadKeys = [];
          iterations.forEach(function (it) {
            if (periods[it.iterationId]) {
              var loadKey = metricKey + '::' + it.iterationId;
              loadKeys.push(loadKey);
              setLoadingMetrics(function (prev) { var next = new Set(prev); next.add(loadKey); return next; });
            }
          });

          // Fetch all iterations for this metric concurrently, then wait for all to complete
          var promises = iterations.map(function (it) {
            var pi = periods[it.iterationId];
            if (!pi) return Promise.resolve();
            var loadKey = metricKey + '::' + it.iterationId;

            return timeWork('Deep dive ' + source + '::' + type + ' ' + it.iterationId.substring(0, 8), function () {
              return api.getMetricData({
                run: pi.runId,
                period: pi.periodId,
                source: source,
                type: type,
                begin: pi.begin,
                end: pi.end,
                resolution: resolution,
                breakout: breakouts,
                filter: config.filter || null,
              });
            }).then(function (data) {
              if (abortRef.current) return;
              setMetricData(function (prev) {
                var next = Object.assign({}, prev);
                if (!next[metricKey]) next[metricKey] = {};
                next[metricKey][it.iterationId] = {
                  values: data.values || {},
                  periodBegin: pi.begin,
                  periodEnd: pi.end,
                };
                return next;
              });
            }).catch(function (err) {
              console.error('Deep dive fetch failed:', source, type, it.iterationId, err);
            }).finally(function () {
              setLoadingMetrics(function (prev) { var next = new Set(prev); next.delete(loadKey); return next; });
            });
          });

          // Wait for all iterations of this metric to complete before starting next metric
          await Promise.all(promises);
        }
      })();
    }).catch(function (err) {
      console.error('Failed to fetch period info:', err);
      setLoadingPeriods(false);
    });

    return function () { abortRef.current = true; };
  }, [iterations.length, metricList.join(','), resolution]);

  if (loadingPeriods) {
    return (
      <div className="deepdive-view">
        <div className="compare-loading"><span className="spinner" /> Loading period info...</div>
      </div>
    );
  }

  if (!periodInfo || metricList.length === 0) {
    return (
      <div className="deepdive-view">
        <div className="empty-msg">Select metrics in Compare view using the "Dive" checkboxes, then switch to Deep Dive.</div>
      </div>
    );
  }

  return (
    <div className="deepdive-view">
      <div className="deepdive-controls">
        <span className="compare-filter-group">
          <label className="compare-filter-label">Resolution:</label>
          <input type="number" className="compare-filter-input" value={resolution} min={10} max={1000} step={10}
            style={{ width: 70 }}
            onChange={function (e) { setResolution(parseInt(e.target.value, 10) || 100); }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>data points</span>
        </span>
        {loadingMetrics.size > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            <span className="spinner" style={{ marginRight: 4 }} />
            Loading {loadingMetrics.size} metric(s)...
          </span>
        )}
      </div>

      {metricList.map(function (metricKey, mi) {
        var parts = metricKey.split('::');
        var source = parts[0];
        var type = parts[1];
        var metricResults = metricData[metricKey] || {};

        // Build chart data: merge all iterations into a unified elapsed-time dataset
        // With breakouts, each breakout label becomes a separate line per iteration
        var allPoints = []; // { elapsed, lineKey, value }
        var lineKeys = []; // { key, label (display), iterationId }
        var lineColors = {};
        var colorIdx = 0;

        iterations.forEach(function (it) {
          var result = metricResults[it.iterationId];
          if (!result || !result.values) return;
          var iterLabel = buildIterShortLabel(it, iterations);

          var periodBegin = Number(result.periodBegin);
          var labelKeys = Object.keys(result.values);

          labelKeys.forEach(function (lk) {
            var entries = result.values[lk];
            if (!Array.isArray(entries)) return;
            // Build a unique line key: "iterLabel" or "iterLabel <breakoutLabel>" if breakouts
            var lineKey = labelKeys.length > 1 ? iterLabel + ' ' + lk : iterLabel;
            var displayLabel = lineKey;
            if (!lineKeys.find(function (l) { return l.key === lineKey; })) {
              lineKeys.push({ key: lineKey, label: displayLabel, iterationId: it.iterationId });
              lineColors[lineKey] = COLORS[colorIdx % COLORS.length];
              colorIdx++;
            }
            entries.forEach(function (entry) {
              var elapsed = (Number(entry.begin) + Number(entry.end)) / 2 - periodBegin;
              allPoints.push({ elapsed: elapsed, lineKey: lineKey, value: entry.value });
            });
          });
        });

        // Build unified time axis
        var timeSet = new Set();
        allPoints.forEach(function (p) { timeSet.add(p.elapsed); });
        var times = Array.from(timeSet).sort(function (a, b) { return a - b; });

        // Build chart data array
        var chartData = times.map(function (t) {
          return { elapsed: t };
        });

        // Index for fast lookup
        var timeIndex = {};
        times.forEach(function (t, i) { timeIndex[t] = i; });

        // Fill in values per line
        allPoints.forEach(function (p) {
          var idx = timeIndex[p.elapsed];
          if (idx != null) {
            chartData[idx][p.lineKey] = p.value;
          }
        });

        var hasData = lineKeys.length > 0 && chartData.length > 0;

        // Build legend data: group by iteration, then by breakout segments
        var legendByIter = {};
        lineKeys.forEach(function (lk) {
          var itId = lk.iterationId;
          if (!legendByIter[itId]) legendByIter[itId] = { iterLabel: '', items: [] };
          // Extract breakout label from key (key = "iterLabel" or "iterLabel <breakoutLabel>")
          var iterLabel = buildIterShortLabel(iterations.find(function (it) { return it.iterationId === itId; }), iterations);
          legendByIter[itId].iterLabel = iterLabel;
          var breakoutPart = lk.key.substring(iterLabel.length).trim();
          var segments = breakoutPart ? parseSegments(breakoutPart) : [];
          legendByIter[itId].items.push({ key: lk.key, segments: segments, color: lineColors[lk.key] });
        });

        // Sort items within each iteration by segments
        Object.values(legendByIter).forEach(function (group) {
          group.items.sort(function (a, b) {
            for (var i = 0; i < Math.max(a.segments.length, b.segments.length); i++) {
              var cmp = naturalCompare(a.segments[i] || '', b.segments[i] || '');
              if (cmp !== 0) return cmp;
            }
            return 0;
          });
        });

        // Get breakout dimension names from config
        var config = configLookup[metricKey] || {};
        var breakoutNames = (config.breakouts || []).map(function (b) {
          var eqIdx = b.indexOf('=');
          return eqIdx >= 0 ? b.substring(0, eqIdx) : b;
        });

        // Get active entry: find nearest data point to the shared elapsed time
        var activeElapsed = pinnedElapsed != null ? pinnedElapsed : hoverElapsed;
        var isPinned = pinnedElapsed != null;
        var activeEntry = null;
        if (activeElapsed != null && chartData.length > 0) {
          // Binary-ish search for nearest elapsed time in this chart's data
          var bestIdx = 0;
          var bestDiff = Math.abs(chartData[0].elapsed - activeElapsed);
          for (var ai = 1; ai < chartData.length; ai++) {
            var diff = Math.abs(chartData[ai].elapsed - activeElapsed);
            if (diff < bestDiff) { bestDiff = diff; bestIdx = ai; }
            if (chartData[ai].elapsed > activeElapsed) break; // sorted, can stop early
          }
          activeEntry = chartData[bestIdx];
        }

        return (
          <div key={metricKey} className="deepdive-chart-panel">
            <h3 className="deepdive-chart-title">{source}::{type}</h3>
            {!hasData && (
              <div className="deepdive-chart-loading">
                {loadingMetrics.size > 0 ? (
                  <><span className="spinner" style={{ marginRight: 4 }} /> Loading...</>
                ) : 'No data available'}
              </div>
            )}
            {hasData && (
              <>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={chartData} margin={{ top: 10, right: 30, left: 60, bottom: 30 }}
                    onMouseMove={function (e) {
                      if (pinnedElapsed == null && e && e.activeTooltipIndex != null) {
                        var entry = chartData[e.activeTooltipIndex];
                        if (entry) setHoverElapsed(entry.elapsed);
                      }
                    }}
                    onMouseLeave={function () {
                      // Keep last hovered values visible when pointer leaves
                    }}
                    onClick={function (e) {
                      if (e && e.activeTooltipIndex != null) {
                        var entry = chartData[e.activeTooltipIndex];
                        if (entry) {
                          var clickedElapsed = entry.elapsed;
                          setPinnedElapsed(function (prev) {
                            if (prev != null) {
                              setHoverElapsed(clickedElapsed);
                              return null;
                            }
                            return clickedElapsed;
                          });
                        }
                      }
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="elapsed"
                      tickFormatter={formatElapsed}
                      stroke="var(--border)"
                      tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                      label={{ value: 'Elapsed Time', position: 'insideBottom', offset: -15, fontSize: 11, fill: 'var(--text-muted)' }}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                      stroke="var(--border)"
                    />
                    <Tooltip
                      content={function () { return <div style={{ display: 'none' }} />; }}
                      cursor={{ stroke: 'var(--text-muted)', strokeWidth: 1, strokeDasharray: '3 3' }}
                    />
                    {activeEntry && (
                      <ReferenceLine x={activeEntry.elapsed} stroke={isPinned ? '#ff6b6b' : 'var(--text-muted)'} strokeDasharray={isPinned ? '6 4' : '3 3'} strokeWidth={isPinned ? 2 : 1} />
                    )}
                    {lineKeys.map(function (lk) {
                      return (
                        <Line
                          key={lk.key}
                          dataKey={lk.key}
                          type="monotone"
                          stroke={lineColors[lk.key]}
                          strokeWidth={1.5}
                          dot={false}
                          connectNulls={false}
                          name={lk.label}
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>

                {/* Series legend table */}
                <div className="deepdive-legend">
                  <div className="deepdive-legend-header">
                    {activeEntry ? (
                      <span className="deepdive-legend-time">
                        {isPinned ? '\u{1F512} ' : ''}{formatElapsed(activeEntry.elapsed)}
                        {isPinned && <button className="deepdive-legend-unpin" onClick={function () { setPinnedElapsed(null); }}>&times;</button>}
                      </span>
                    ) : (
                      <span className="deepdive-legend-hint">Move pointer over chart to see values</span>
                    )}
                  </div>
                  <div className="deepdive-legend-body">
                    {Object.keys(legendByIter).map(function (itId) {
                      var group = legendByIter[itId];
                      var items = group.items;
                      var numCols = items.length > 0 && items[0].segments.length > 0 ? items[0].segments.length : 0;

                      // Strip common prefix/suffix from each segment column
                      var colStripped = [];
                      for (var col = 0; col < numCols; col++) {
                        var vals = items.map(function (it) { return it.segments[col] || ''; });
                        var unique = Array.from(new Set(vals));
                        var stripped = vals;
                        if (unique.length > 1) {
                          // Find common suffix (split at delimiter boundaries)
                          var suffix = '';
                          var first = unique[0];
                          for (var si2 = first.length - 1; si2 > 0; si2--) {
                            var ch = first[si2];
                            if (ch === '.' || ch === '-' || ch === '_') {
                              var candidate = first.substring(si2);
                              if (unique.every(function (v) { return v.endsWith(candidate); })) {
                                suffix = candidate;
                              }
                            }
                          }
                          if (suffix) {
                            stripped = vals.map(function (v) { return v.substring(0, v.length - suffix.length); });
                          } else {
                            // Try common prefix
                            var prefix = '';
                            for (var pi = 0; pi < first.length - 1; pi++) {
                              var pch = first[pi];
                              if (pch === '.' || pch === '-' || pch === '_') {
                                var pcandidate = first.substring(0, pi + 1);
                                if (unique.every(function (v) { return v.startsWith(pcandidate); })) {
                                  prefix = pcandidate;
                                }
                              }
                            }
                            if (prefix) {
                              stripped = vals.map(function (v) { return v.substring(prefix.length); });
                            }
                          }
                        }
                        colStripped.push(stripped);
                      }

                      // Compute rowSpans for hierarchical grouping
                      var rowSpans = items.map(function () { return new Array(numCols).fill(1); });
                      for (var col2 = 0; col2 < numCols; col2++) {
                        var spanStart = 0;
                        for (var row = 1; row <= items.length; row++) {
                          var same = row < items.length;
                          if (same) {
                            for (var c = 0; c <= col2; c++) {
                              if ((colStripped[c] ? colStripped[c][row] : '') !== (colStripped[c] ? colStripped[c][spanStart] : '')) { same = false; break; }
                            }
                          }
                          if (!same) {
                            rowSpans[spanStart][col2] = row - spanStart;
                            for (var r = spanStart + 1; r < row; r++) rowSpans[r][col2] = 0;
                            spanStart = row;
                          }
                        }
                      }

                      return (
                        <div key={itId} className="deepdive-legend-group">
                          <div className="deepdive-legend-iter">{group.iterLabel}</div>
                          <table className="deepdive-legend-table">
                            <thead>
                              <tr>
                                {breakoutNames.map(function (name, ni) {
                                  return <th key={ni}>{name}</th>;
                                })}
                                {breakoutNames.length === 0 && <th>Series</th>}
                                <th className="deepdive-legend-color-col"></th>
                                <th className="deepdive-legend-value-col">Value</th>
                              </tr>
                            </thead>
                            <tbody>
                              {items.map(function (item, ri) {
                                var value = activeEntry ? activeEntry[item.key] : null;
                                return (
                                  <tr key={item.key}>
                                    {numCols > 0 ? (function () {
                                      var cells = [];
                                      for (var ci = 0; ci < numCols; ci++) {
                                        if (rowSpans[ri][ci] > 0) {
                                          var span = rowSpans[ri][ci];
                                          cells.push(
                                            <td key={ci} className="deepdive-legend-seg" rowSpan={span > 1 ? span : undefined}>
                                              {span > 1 ? (
                                                <div className="deepdive-legend-seg-sticky">{colStripped[ci] ? colStripped[ci][ri] : item.segments[ci]}</div>
                                              ) : (colStripped[ci] ? colStripped[ci][ri] : item.segments[ci])}
                                            </td>
                                          );
                                        }
                                      }
                                      return cells;
                                    })() : <td className="deepdive-legend-seg">-</td>}
                                    <td><span className="deepdive-legend-swatch" style={{ backgroundColor: item.color }}></span></td>
                                    <td className="deepdive-legend-val">{value != null ? formatValue(value) : '-'}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
