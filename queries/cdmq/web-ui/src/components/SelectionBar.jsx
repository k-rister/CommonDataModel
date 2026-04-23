import { buildIterItems } from '../utils/iterLabel';

export default function SelectionBar({ selected, onRemove, onClear }) {
  const items = Array.from(selected.values());

  return (
    <div className="selection-bar">
      <div className="selection-bar-header">
        <span className="count">{selected.size} selected</span>
        <button className="btn btn-sm btn-secondary" onClick={onClear}>
          Clear All
        </button>
      </div>
      <div className="selection-chips">
        {items.slice(0, 10).map(function (it) {
          var iterItems = buildIterItems(it, items, null);
          return (
            <div key={it.iterationId} className="selection-chip-card">
              <button className="selection-chip-remove" onClick={function (e) { e.stopPropagation(); onRemove(it.iterationId); }} title="Remove">&times;</button>
              {iterItems.length > 0 ? iterItems.map(function (item, pi) {
                var label = item.type === 'benchmark' ? item.val : item.names.join(',') + '=' + item.val;
                return (
                  <span key={pi} className={'selection-chip-param ' + (item.type === 'benchmark' ? 'benchmark-badge' : item.type === 'tag' ? 'tag' : 'param')}>
                    {item.type === 'tag' && <span className="tag-key">{item.names.join(',')}</span>}
                    {item.type === 'tag' ? '=' + item.val : label}
                  </span>
                );
              }) : <span className="selection-chip-id">{it.iterationId.substring(0, 8)}</span>}
            </div>
          );
        })}
        {items.length > 10 && <span className="selection-chip-more">+{items.length - 10} more</span>}
      </div>
    </div>
  );
}
