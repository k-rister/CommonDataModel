export default function SelectionBar({ selected, onRemove, onClear }) {
  const items = Array.from(selected.values());

  return (
    <div className="selection-bar">
      <span className="count">{selected.size} selected</span>
      <div className="selection-chips">
        {items.slice(0, 10).map((it) => (
          <span key={it.iterationId} className="selection-chip">
            {it.benchmark}
            {it.uniqueParams.length > 0 && (
              <> ({it.uniqueParams.map((p) => `${p.arg}=${p.val}`).join(', ')})</>
            )}
            <button onClick={() => onRemove(it.iterationId)} title="Remove">
              x
            </button>
          </span>
        ))}
        {items.length > 10 && <span className="selection-chip">+{items.length - 10} more</span>}
      </div>
      <button className="btn btn-sm btn-secondary" onClick={onClear}>
        Clear All
      </button>
    </div>
  );
}
