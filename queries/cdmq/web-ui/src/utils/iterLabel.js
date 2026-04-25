// Build consolidated iteration items: groups params/tags with same value
// Returns array of { names: ['bs','rw'], val: '4k', type: 'param' } objects
// Only includes varying dimensions (>1 distinct value), excludes hidden fields
export function buildIterItems(it, allIterations, hiddenFields) {
  if (!it) return [];
  var hiddenSet = hiddenFields ? new Set(hiddenFields) : new Set();
  var paramValues = {};
  var tagValues = {};
  var benchmarks = new Set();
  allIterations.forEach(function (iter) {
    if (iter.benchmark) benchmarks.add(iter.benchmark);
    (iter.params || []).forEach(function (p) {
      if (!paramValues[p.arg]) paramValues[p.arg] = new Set();
      paramValues[p.arg].add(String(p.val));
    });
    (iter.tags || []).forEach(function (t) {
      if (!tagValues[t.name]) tagValues[t.name] = new Set();
      tagValues[t.name].add(t.val);
    });
  });

  // Collect varying items
  var items = [];
  if (benchmarks.size > 1 && !hiddenSet.has('benchmark')) {
    items.push({ name: 'benchmark', val: it.benchmark || '', type: 'benchmark' });
  }
  (it.params || []).forEach(function (p) {
    if (paramValues[p.arg] && paramValues[p.arg].size > 1 && !hiddenSet.has('param:' + p.arg)) {
      items.push({ name: p.arg, val: String(p.val), type: 'param' });
    }
  });
  (it.tags || []).forEach(function (t) {
    if (tagValues[t.name] && tagValues[t.name].size > 1 && !hiddenSet.has('tag:' + t.name)) {
      items.push({ name: t.name, val: t.val, type: 'tag' });
    }
  });

  // Consolidate: group items with the same value
  var byVal = {};
  var valOrder = [];
  items.forEach(function (item) {
    var key = item.type + ':' + item.val;
    if (!byVal[key]) {
      byVal[key] = { names: [], val: item.val, type: item.type };
      valOrder.push(key);
    }
    byVal[key].names.push(item.name);
  });

  return valOrder.map(function (key) { return byVal[key]; });
}

// Render items as a flat string (for bar labels, legend headers)
export function iterItemsToString(items) {
  if (items.length === 0) return '';
  return items.map(function (item) {
    if (item.type === 'benchmark') return item.val;
    return item.names.join(',') + '=' + item.val;
  }).join(', ');
}
