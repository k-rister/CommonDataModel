// Shared debug log store.
// Components subscribe via onChange to get notified of new entries.

let entries = [];
let listeners = [];
let idSeq = 0;

export function addEntry(entry) {
  const e = { id: idSeq++, ts: Date.now(), ...entry };
  entries.push(e);
  listeners.forEach((fn) => fn(entries));
  return e.id;
}

export function updateEntry(id, updates) {
  const idx = entries.findIndex((e) => e.id === id);
  if (idx >= 0) {
    entries[idx] = { ...entries[idx], ...updates };
    listeners.forEach((fn) => fn(entries));
  }
}

export function clearEntries() {
  entries = [];
  idSeq = 0;
  listeners.forEach((fn) => fn(entries));
}

export function getEntries() {
  return entries;
}

export function onChange(fn) {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((l) => l !== fn);
  };
}

// Convenience: time an async operation and log it
export async function timeWork(label, fn) {
  const id = addEntry({ type: 'work', label, status: 'running' });
  const start = performance.now();
  try {
    const result = await fn();
    const elapsed = performance.now() - start;
    updateEntry(id, { status: 'done', elapsed });
    return result;
  } catch (err) {
    const elapsed = performance.now() - start;
    updateEntry(id, { status: 'error', elapsed, error: err.message });
    throw err;
  }
}
