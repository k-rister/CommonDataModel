import { useState, useEffect, useMemo, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
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

export default function DeepDiveView({ selected, deepDiveMetrics, metricConfigs: metricConfigsProp }) {
  var [resolution, setResolution] = useState(100);
  var [periodInfo, setPeriodInfo] = useState(null); // { iterationId: { periodId, begin, end, runId } }
  var [metricData, setMetricData] = useState({}); // { "source::type": { iterationId: { values, breakouts } } }
  var [loadingPeriods, setLoadingPeriods] = useState(false);
  var [loadingMetrics, setLoadingMetrics] = useState(new Set()); // Set of "source::type::iterationId" currently loading
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
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={chartData} margin={{ top: 10, right: 30, left: 60, bottom: 30 }}>
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
                    content={function (props) {
                      if (!props.active || !props.payload || props.payload.length === 0) return null;
                      var entry = props.payload[0].payload;
                      return (
                        <div className="deepdive-tooltip">
                          <div className="deepdive-tooltip-time">{formatElapsed(entry.elapsed)}</div>
                          {lineKeys.map(function (lk) {
                            var v = entry[lk.key];
                            if (v == null) return null;
                            return (
                              <div key={lk.key} className="deepdive-tooltip-item" style={{ color: lineColors[lk.key] }}>
                                {lk.label}: {formatValue(v)}
                              </div>
                            );
                          })}
                        </div>
                      );
                    }}
                  />
                  {lineKeys.map(function (lk) {
                    return (
                      <Line
                        key={lk.key}
                        dataKey={lk.key}
                        type="monotone"
                        stroke={lineColors[lk.key]}
                        strokeWidth={2}
                        dot={false}
                        connectNulls={false}
                        name={lk.label}
                      />
                    );
                  })}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        );
      })}
    </div>
  );
}
