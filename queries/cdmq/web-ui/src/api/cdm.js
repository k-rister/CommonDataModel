import { addEntry, updateEntry } from '../debugLog';

const BASE = '/api/v1';

async function request(method, path, body) {
  const label = `${method} ${path}`;
  const id = addEntry({ type: 'api', label, method, path, status: 'pending' });
  const start = performance.now();
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${BASE}${path}`, opts);
    const elapsed = performance.now() - start;
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      updateEntry(id, { status: 'error', elapsed, httpStatus: res.status, error: err.error });
      throw new Error(err.error || `${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    updateEntry(id, { status: 'done', elapsed, httpStatus: res.status });
    return data;
  } catch (err) {
    const elapsed = performance.now() - start;
    updateEntry(id, { status: 'error', elapsed, error: err.message });
    throw err;
  }
}

export async function searchRuns(filters = {}) {
  const params = new URLSearchParams();
  if (filters.run) params.set('run', filters.run);
  if (filters.name) params.set('name', filters.name);
  if (filters.email) params.set('email', filters.email);
  if (filters.harness) params.set('harness', filters.harness);
  if (filters.benchmark) params.set('benchmark', filters.benchmark);
  if (filters.primaryMetric) params.set('primaryMetric', filters.primaryMetric);
  if (filters.start) params.set('start', filters.start);
  if (filters.end) params.set('end', filters.end);
  if (filters.tags && filters.tags.length > 0) params.set('tags', JSON.stringify(filters.tags));
  if (filters.params && filters.params.length > 0) params.set('params', JSON.stringify(filters.params));
  const qs = params.toString();
  return request('GET', `/runs${qs ? '?' + qs : ''}`);
}

export async function getIterationDetails(runIds, start, end) {
  return request('POST', '/iterations/details', { runIds, start, end });
}

export async function getIterationMetricValues(runIds, start, end) {
  return request('POST', '/iterations/metric-values', { runIds, start, end });
}

export async function getFieldValues(fieldType, filterParams = {}) {
  const params = new URLSearchParams(filterParams);
  const qs = params.toString();
  return request('GET', `/fields/${fieldType}${qs ? '?' + qs : ''}`);
}

export async function getTags(runId) {
  return request('GET', `/run/${runId}/tags`);
}

export async function getBenchmark(runId) {
  return request('GET', `/run/${runId}/benchmark`);
}

export async function getIterations(runId) {
  return request('GET', `/run/${runId}/iterations`);
}

export async function getIterationParams(runId, iterations) {
  return request('POST', `/run/${runId}/iterations/params`, { iterations });
}

export async function getPrimaryPeriodName(runId, iterations) {
  return request('POST', `/run/${runId}/iterations/primary-period-name`, { iterations });
}

export async function getSamples(runId, iterations) {
  return request('POST', `/run/${runId}/iterations/samples`, { iterations });
}

export async function getSampleStatuses(runId, sampleIds) {
  return request('POST', `/run/${runId}/samples/statuses`, { sampleIds });
}

export async function getPrimaryPeriodId(runId, sampleIds, periodNames) {
  return request('POST', `/run/${runId}/samples/primary-period-id`, { sampleIds, periodNames });
}

export async function getPeriodRange(runId, periodIds) {
  return request('POST', `/run/${runId}/periods/range`, { periodIds });
}

export async function getPrimaryMetric(runId, iterations) {
  return request('POST', `/run/${runId}/iterations/primary-metric`, { iterations });
}

export async function getMetricSources(runId) {
  return request('GET', `/run/${runId}/metric-sources`);
}

export async function getMetricTypes(runId, sources) {
  return request('POST', `/run/${runId}/metric-types`, { sources });
}

export async function getIterationMetricSources(runIds, start, end) {
  return request('POST', '/iterations/metric-sources', { runIds, start, end });
}

export async function getIterationMetricTypes(runIds, start, end, source) {
  return request('POST', '/iterations/metric-types', { runIds, start, end, source });
}

export async function getSupplementalMetric(params) {
  return request('POST', '/iterations/supplemental-metric', {
    iterations: params.iterations || null,
    runIds: params.runIds || null,
    start: params.start,
    end: params.end,
    source: params.source,
    type: params.type,
    breakout: params.breakout || [],
    filter: params.filter || null,
    sampleIndex: params.sampleIndex != null ? params.sampleIndex : null,
  });
}

export async function getBreakoutValues(params) {
  return request('POST', '/iterations/breakout-values', {
    runIds: params.runIds,
    start: params.start,
    end: params.end,
    source: params.source,
    type: params.type,
    breakouts: params.breakouts,
  });
}

export async function getMetricData(params) {
  return request('POST', `/metric-data`, params);
}
