import { useState, useRef, useEffect, useMemo } from 'react';

// When multi=true, value is a comma-separated string of selected values.
// The component renders chips for each selected value and a text input for filtering.
export default function AutocompleteInput({ value, onChange, options, presentValues, placeholder, onFocus, onKeyDown, multi }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [inputText, setInputText] = useState('');
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);

  // Parse multi-value string into array
  var selected = multi && value ? value.split(',').filter(Boolean) : [];
  var selectedSet = new Set(selected);

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
  var filterText = multi ? inputText : (value || '');
  const { present, absent } = useMemo(() => {
    var all = options || [];
    var q = filterText.toLowerCase();
    var filtered = q ? all.filter((o) => String(o).toLowerCase().includes(q)) : all;
    // In multi mode, hide already-selected values from the dropdown
    if (multi) {
      filtered = filtered.filter((o) => !selectedSet.has(String(o)));
    }
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
  }, [options, filterText, presentValues, multi ? value : null]);

  var items = present.concat(absent);

  function handleFocus(e) {
    setOpen(true);
    if (onFocus) onFocus(e);
  }

  function handleChange(e) {
    if (multi) {
      setInputText(e.target.value);
    } else {
      onChange(e.target.value);
    }
    setOpen(true);
    setHighlight(-1);
  }

  function selectItem(val) {
    if (multi) {
      var next = [...selected, String(val)];
      onChange(next.join(','));
      setInputText('');
      setHighlight(-1);
      // Keep dropdown open for more selections
      if (inputRef.current) inputRef.current.focus();
    } else {
      onChange(val);
      setOpen(false);
      setHighlight(-1);
    }
  }

  function removeChip(val) {
    var next = selected.filter((s) => s !== val);
    onChange(next.join(','));
  }

  function handleKeyDownInternal(e) {
    if (multi && e.key === 'Backspace' && inputText === '' && selected.length > 0) {
      // Remove last chip on backspace in empty input
      removeChip(selected[selected.length - 1]);
      return;
    }
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
      {multi ? (
        <div className="autocomplete-multi-input" onClick={() => inputRef.current && inputRef.current.focus()}>
          {selected.map((s) => (
            <span key={s} className="autocomplete-chip">
              {s}
              <button type="button" onMouseDown={(e) => { e.stopPropagation(); removeChip(s); }}>&times;</button>
            </span>
          ))}
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            placeholder={selected.length === 0 ? placeholder : ''}
            onChange={handleChange}
            onFocus={handleFocus}
            onKeyDown={handleKeyDownInternal}
          />
        </div>
      ) : (
        <input
          ref={inputRef}
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={handleChange}
          onFocus={handleFocus}
          onKeyDown={handleKeyDownInternal}
        />
      )}
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
