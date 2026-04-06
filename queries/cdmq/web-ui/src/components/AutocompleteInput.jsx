import { useState, useRef, useEffect, useMemo } from 'react';

export default function AutocompleteInput({ value, onChange, options, presentValues, placeholder, onFocus, onKeyDown }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);

  // Close on outside click
  useEffect(() => {
    function handleMouseDown(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, []);

  // Filter and partition options
  const { present, absent } = useMemo(() => {
    var all = options || [];
    var q = (value || '').toLowerCase();
    var filtered = q ? all.filter((o) => String(o).toLowerCase().includes(q)) : all;
    if (!presentValues || presentValues.size === 0) {
      return { present: filtered, absent: [] };
    }
    var p = [];
    var a = [];
    for (var i = 0; i < filtered.length; i++) {
      if (presentValues.has(filtered[i])) {
        p.push(filtered[i]);
      } else {
        a.push(filtered[i]);
      }
    }
    return { present: p, absent: a };
  }, [options, value, presentValues]);

  var items = present.concat(absent);

  function handleFocus(e) {
    setOpen(true);
    if (onFocus) onFocus(e);
  }

  function handleChange(e) {
    onChange(e.target.value);
    setOpen(true);
    setHighlight(-1);
  }

  function selectItem(val) {
    onChange(val);
    setOpen(false);
    setHighlight(-1);
  }

  function handleKeyDownInternal(e) {
    if (!open || items.length === 0) {
      if (onKeyDown) onKeyDown(e);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? items.length - 1 : h - 1));
    } else if (e.key === 'Enter' && highlight >= 0) {
      e.preventDefault();
      selectItem(items[highlight]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setHighlight(-1);
    } else {
      if (onKeyDown) onKeyDown(e);
    }
  }

  return (
    <div className="autocomplete-wrapper" ref={wrapperRef}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={handleChange}
        onFocus={handleFocus}
        onKeyDown={handleKeyDownInternal}
      />
      {open && items.length > 0 && (
        <ul className="autocomplete-dropdown">
          {present.map((item, i) => (
            <li
              key={'p-' + item}
              className={highlight === i ? 'highlighted' : ''}
              onMouseDown={() => selectItem(item)}
            >
              {item}
            </li>
          ))}
          {present.length > 0 && absent.length > 0 && <li className="section-divider" />}
          {absent.map((item, i) => (
            <li
              key={'a-' + item}
              className={'absent' + (highlight === present.length + i ? ' highlighted' : '')}
              onMouseDown={() => selectItem(item)}
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
