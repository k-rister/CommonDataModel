import { useState, useEffect, useRef } from 'react';
import { getEntries, onChange, clearEntries } from '../debugLog';

function formatElapsed(ms) {
  if (ms == null) return '';
  if (ms < 1000) return ms.toFixed(0) + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 });
}

function statusClass(status) {
  if (status === 'error') return 'dbg-error';
  if (status === 'pending' || status === 'running') return 'dbg-pending';
  return '';
}

function typeIcon(type) {
  if (type === 'api') return 'API';
  if (type === 'work') return 'WORK';
  return 'INFO';
}

export default function DebugConsole() {
  const [entries, setEntries] = useState(getEntries);
  const [open, setOpen] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    return onChange((e) => setEntries([...e]));
  }, []);

  useEffect(() => {
    if (open && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries, open]);

  const apiEntries = entries.filter((e) => e.type === 'api');
  const totalApiTime = apiEntries.reduce((sum, e) => sum + (e.elapsed || 0), 0);
  const pendingCount = entries.filter((e) => e.status === 'pending' || e.status === 'running').length;

  return (
    <div className="debug-console">
      <div className="debug-header" onClick={() => setOpen(!open)}>
        <span className="debug-toggle">{open ? '\u25BC' : '\u25B6'}</span>
        <span className="debug-title">Debug Console</span>
        <span className="debug-stats">
          {entries.length} entries
          {pendingCount > 0 && <span className="dbg-pending"> ({pendingCount} pending)</span>}
          {apiEntries.length > 0 && <> | {apiEntries.length} API calls, {formatElapsed(totalApiTime)} total</>}
        </span>
        {entries.length > 0 && (
          <button
            className="btn btn-sm btn-secondary"
            onClick={(e) => {
              e.stopPropagation();
              clearEntries();
            }}
            style={{ marginLeft: 'auto' }}
          >
            Clear
          </button>
        )}
      </div>
      {open && (
        <div className="debug-body">
          {entries.length === 0 && <div className="debug-empty">No log entries yet. Perform a search to see timing data.</div>}
          {entries.map((e) => (
            <div key={e.id} className={`debug-entry ${statusClass(e.status)}`}>
              <span className="debug-time">{formatTime(e.ts)}</span>
              <span className={`debug-type debug-type-${e.type}`}>{typeIcon(e.type)}</span>
              <span className="debug-label">{e.label}</span>
              {e.elapsed != null && e.elapsed > 0 && <span className="debug-elapsed">{formatElapsed(e.elapsed)}</span>}
              {e.httpStatus && <span className="debug-http">{e.httpStatus}</span>}
              {e.error && <span className="debug-error-msg">{e.error}</span>}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
