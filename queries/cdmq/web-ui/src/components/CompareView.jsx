import { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ErrorBar, ResponsiveContainer, Cell } from 'recharts';
import * as api from '../api/cdm';
import { timeWork } from '../debugLog';

const COLORS = [
  '#5b8def', '#4ade80', '#fbbf24', '#f87171', '#a78bfa',
  '#34d399', '#fb923c', '#f472b6', '#38bdf8', '#facc15',
];

function formatLabel(it) {
  var parts = [];
  if (it.uniqueParams && it.uniqueParams.length > 0) {
    parts = it.uniqueParams.map(function (p) { return p.arg + '=' + p.val; });
  } else if (it.params && it.params.length > 0) {
    parts = it.params.slice(0, 3).map(function (p) { return p.arg + '=' + p.val; });
  }
  return parts.join(', ') || it.iterationId.substring(0, 8);
}

function formatValue(v) {
  if (v == null) return '';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toPrecision(3);
}

export default function CompareView({ selected }) {
  var [metricValues, setMetricValues] = useState({});
  var [loading, setLoading] = useState(false);

  var iterations = useMemo(function () {
    return Array.from(selected.values());
  }, [selected]);

  // Fetch metric values for selected iterations on mount or selection change
  useEffect(function () {
    if (iterations.length === 0) return;
    var runIdSet = new Set();
    iterations.forEach(function (it) { runIdSet.add(it.runId); });
    var runIds = Array.from(runIdSet);

    // Compute date range from run begin times
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

  // Group iterations by primary metric (different metrics get separate charts)
  var groups = useMemo(function () {
    var map = {};
    for (var i = 0; i < iterations.length; i++) {
      var it = iterations[i];
      var pm = it.primaryMetric || 'unknown';
      if (!map[pm]) map[pm] = [];
      map[pm].push(it);
    }
    return map;
  }, [iterations]);

  if (loading) {
    return (
      <div className="compare-view">
        <div className="compare-loading">
          <span className="spinner" /> Loading metric values...
        </div>
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
      {Object.keys(groups).map(function (metricName) {
        var groupIters = groups[metricName];
        var chartData = groupIters.map(function (it, idx) {
          var mv = metricValues[it.iterationId];
          var mean = mv ? mv.mean : null;
          var sampleValues = mv ? mv.sampleValues : [];
          var stddev = 0;
          if (sampleValues.length > 1 && mean != null) {
            var variance = 0;
            for (var v = 0; v < sampleValues.length; v++) {
              variance += (sampleValues[v] - mean) * (sampleValues[v] - mean);
            }
            stddev = Math.sqrt(variance / (sampleValues.length - 1));
          }
          return {
            name: formatLabel(it),
            value: mean,
            errorY: stddev,
            iterationId: it.iterationId,
            benchmark: it.benchmark,
            samples: sampleValues.length,
            stddevPct: mv ? mv.stddevPct : null,
            idx: idx,
          };
        }).filter(function (d) { return d.value != null; });

        if (chartData.length === 0) {
          return (
            <div key={metricName} className="compare-chart-panel">
              <h3>{metricName}</h3>
              <div className="empty-msg">No metric values available for these iterations.</div>
            </div>
          );
        }

        return (
          <div key={metricName} className="compare-chart-panel">
            <h3>{metricName}</h3>
            <ResponsiveContainer width="100%" height={Math.max(350, chartData.length * 40 + 100)}>
              <BarChart data={chartData} margin={{ top: 20, right: 30, left: 60, bottom: 80 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="name"
                  angle={-30}
                  textAnchor="end"
                  height={80}
                  tick={{ fontSize: 11, fill: 'var(--text-secondary)' }}
                  stroke="var(--border)"
                />
                <YAxis
                  tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
                  stroke="var(--border)"
                  label={{
                    value: metricName,
                    angle: -90,
                    position: 'insideLeft',
                    offset: -45,
                    style: { fontSize: 13, fill: 'var(--text-secondary)' },
                  }}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)',
                    color: 'var(--text)',
                  }}
                  formatter={function (value, name, props) {
                    var entry = props.payload;
                    var lines = [formatValue(value)];
                    if (entry.samples > 1 && entry.stddevPct != null) {
                      lines[0] += ' (\u00b1' + entry.stddevPct.toFixed(1) + '%)';
                    }
                    return [lines[0], metricName];
                  }}
                  labelFormatter={function (label) { return label; }}
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  <ErrorBar dataKey="errorY" width={4} strokeWidth={2} stroke="var(--text-secondary)" />
                  {chartData.map(function (entry) {
                    return <Cell key={entry.iterationId} fill={COLORS[entry.idx % COLORS.length]} />;
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
