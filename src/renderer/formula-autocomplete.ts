/**
 * Lightweight inline-completion helper for the formula bar.
 *
 * Behavior:
 *  - When the user is typing the FUNCTION NAME (e.g. "=MOD"), we show a
 *    suggestion list of matching MODBUS_* names. Tab / Enter inserts the
 *    selected name and opens the parens.
 *  - When the user is INSIDE a MODBUS_* call, we show a parameter-hint
 *    pill that highlights the current argument index.
 *
 * Keeping this dependency-free and DOM-driven so it works against the
 * existing formula <input> without dragging in a heavier UI dep.
 */

interface FnSpec {
  name: string;
  signature: string;
  /** Plain-text parameter labels in declaration order. */
  params: string[];
  description: string;
}

const FUNCTIONS: FnSpec[] = [
  {
    name: 'MODBUS_READ_REGISTER',
    signature: 'MODBUS_READ_REGISTER(address, [datatype], [poll_rate])',
    params: ['address', '[datatype="int16"]', '[poll_rate=-1]'],
    description: 'Read a typed value from the configured interface. datatype defaults to "int16"; poll_rate=-1 uses the interface base poll rate.',
  },
  {
    name: 'MODBUS_READ_COIL',
    signature: 'MODBUS_READ_COIL(address, [bit], [poll_rate])',
    params: ['address', '[bit=-1]', '[poll_rate=-1]'],
    description: 'Read a coil/discrete or a single bit of a register. bit defaults to -1 (derive from address text e.g. 40001.5).',
  },
  {
    name: 'MODBUS_WRITE_REGISTER',
    signature: 'MODBUS_WRITE_REGISTER(value, address, [datatype], [poll_rate], [readback_address])',
    params: ['value', 'address', '[datatype="int16"]', '[poll_rate=-1]', '[readback_address]'],
    description: 'Write a typed value to a holding register. value is typically a cell reference. readback_address defaults to the same address.',
  },
  {
    name: 'MODBUS_WRITE_COIL',
    signature: 'MODBUS_WRITE_COIL(value, address, [bit], [poll_rate], [readback_address])',
    params: ['value', 'address', '[bit=-1]', '[poll_rate=-1]', '[readback_address]'],
    description: 'Write a coil or a single bit of a holding register.',
  },
  {
    name: 'UI_BUTTON_SET',
    signature: 'UI_BUTTON_SET(button_text, reference, value)',
    params: ['button_text', 'reference', 'value'],
    description: 'Render cell as a clickable button. Clicking writes value to the referenced cell.',
  },
  {
    name: 'UI_BUTTON_PULSE',
    signature: 'UI_BUTTON_PULSE(button_text, reference, on_value, off_value, [pulse_seconds])',
    params: ['button_text', 'reference', 'on_value', 'off_value', '[pulse_seconds=1]'],
    description: 'Render cell as a clickable button. Click writes on_value to the referenced cell; after pulse_seconds the cell is reset to off_value.',
  },
];

export function attachFormulaAutocomplete(input: HTMLInputElement): () => void {
  const popup = document.createElement('div');
  popup.className = 'formula-autocomplete';
  popup.style.cssText = [
    'position:absolute',
    'z-index:1000',
    'background:var(--bg-alt)',
    'color:var(--fg)',
    'border:1px solid var(--border)',
    'border-radius:3px',
    'box-shadow:0 4px 10px rgba(0,0,0,0.18)',
    'font-family:Segoe UI, sans-serif',
    'font-size:12px',
    'min-width:280px',
    'max-width:480px',
    'display:none',
    'padding:0',
  ].join(';');
  document.body.appendChild(popup);

  let suggestions: FnSpec[] = [];
  let activeIndex = 0;
  let mode: 'list' | 'hint' | 'hidden' = 'hidden';

  function position(): void {
    const r = input.getBoundingClientRect();
    popup.style.left = `${r.left}px`;
    popup.style.top = `${r.bottom + 2}px`;
    popup.style.minWidth = `${Math.max(280, r.width)}px`;
  }

  function update(): void {
    const value = input.value;
    const caret = input.selectionStart ?? value.length;
    if (!value.startsWith('=')) {
      hide();
      return;
    }
    // Find the active token: the identifier the caret is currently inside.
    const upToCaret = value.slice(0, caret);
    // Detect "inside a MODBUS_* call" by searching backward for the most
    // recent function name followed by '(' that hasn't been closed yet.
    const callMatch = findEnclosingCall(upToCaret);
    if (callMatch) {
      const spec = FUNCTIONS.find((f) => f.name === callMatch.name);
      if (spec) {
        showHint(spec, callMatch.argIndex);
        return;
      }
    }
    // Otherwise: are we typing an identifier?
    const idMatch = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(upToCaret);
    if (idMatch) {
      const prefix = idMatch[1]!.toUpperCase();
      const matches = FUNCTIONS.filter((f) => f.name.startsWith(prefix));
      if (matches.length > 0 && prefix.length >= 2) {
        suggestions = matches;
        activeIndex = 0;
        showList();
        return;
      }
    }
    hide();
  }

  function showList(): void {
    mode = 'list';
    popup.innerHTML = suggestions
      .map(
        (s, i) => `
        <div data-i="${i}" class="ac-item" style="
          padding:6px 10px;
          cursor:pointer;
          background:${i === activeIndex ? 'var(--accent)' : 'transparent'};
          color:${i === activeIndex ? '#fff' : 'var(--fg)'};
          border-bottom:1px solid var(--border);
        ">
          <div style="font-family:monospace;font-weight:600;">${escapeHtml(s.name)}</div>
          <div style="font-family:monospace;font-size:11px;opacity:0.85;">${escapeHtml(s.signature)}</div>
        </div>`,
      )
      .join('');
    popup.querySelectorAll<HTMLElement>('.ac-item').forEach((el) => {
      el.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        activeIndex = Number(el.dataset.i);
        commit();
      });
    });
    position();
    popup.style.display = 'block';
  }

  function showHint(spec: FnSpec, argIndex: number): void {
    mode = 'hint';
    const parts = spec.params.map((p, i) =>
      i === argIndex
        ? `<span style="background:var(--accent);color:#fff;padding:0 4px;border-radius:2px;">${escapeHtml(p)}</span>`
        : escapeHtml(p),
    );
    popup.innerHTML = `
      <div style="padding:6px 10px;font-family:monospace;">
        <span style="font-weight:600;">${escapeHtml(spec.name)}</span>(${parts.join(', ')})
      </div>
      <div style="padding:0 10px 6px;color:var(--fg-muted);font-size:11px;">
        ${escapeHtml(spec.description)}
      </div>
    `;
    position();
    popup.style.display = 'block';
  }

  function hide(): void {
    mode = 'hidden';
    popup.style.display = 'none';
  }

  function commit(): void {
    if (mode !== 'list') return;
    const spec = suggestions[activeIndex];
    if (!spec) return;
    const value = input.value;
    const caret = input.selectionStart ?? value.length;
    const upToCaret = value.slice(0, caret);
    const fromCaret = value.slice(caret);

    // Replace the entire identifier the caret is inside, not just the
    // portion before the caret. Without this, completing while the cursor
    // sits in the middle of an existing function name would leave the
    // trailing characters orphaned (e.g. caret in MOD|BUS_... -> would
    // produce MODBUS_READ_REGISTER(BUS_...).
    const idStart = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(upToCaret);
    const idEnd = /^([A-Za-z0-9_]*)/.exec(fromCaret);
    const start = idStart ? upToCaret.length - idStart[1]!.length : caret;
    const endOffset = idEnd ? idEnd[1]!.length : 0;
    const end = caret + endOffset;

    // If the user already typed a '(' after the identifier, leave it alone
    // — we just replace the name and place the caret before the existing
    // '('. This protects existing arguments from being clobbered.
    const charAfterId = value.charAt(end);
    const insertion = charAfterId === '(' ? spec.name : spec.name + '(';

    const before = value.slice(0, start);
    const after = value.slice(end);
    input.value = before + insertion + after;
    const newCaret = before.length + insertion.length + (charAfterId === '(' ? 1 : 0);
    input.setSelectionRange(newCaret, newCaret);
    update();
  }

  const onInput = (): void => update();
  const onKeyDown = (e: KeyboardEvent): void => {
    if (mode === 'list') {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = (activeIndex + 1) % suggestions.length;
        showList();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
        showList();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && suggestions.length > 0)) {
        e.preventDefault();
        e.stopPropagation();
        commit();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hide();
        return;
      }
    }
  };
  const onBlur = (): void => {
    // Defer so click on a list item still registers.
    setTimeout(() => hide(), 120);
  };
  const onScroll = (): void => {
    if (mode !== 'hidden') position();
  };

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown, true);
  input.addEventListener('blur', onBlur);
  input.addEventListener('click', onInput);
  input.addEventListener('keyup', onInput);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);

  return () => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('keydown', onKeyDown, true);
    input.removeEventListener('blur', onBlur);
    input.removeEventListener('click', onInput);
    input.removeEventListener('keyup', onInput);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    popup.remove();
  };
}

/**
 * Walk backward from the caret looking for the innermost open '(' whose
 * matching function name is one we recognize. Returns the function name and
 * which argument the caret is positioned in (0-based).
 */
function findEnclosingCall(text: string): { name: string; argIndex: number } | null {
  let depth = 0;
  let argIndex = 0;
  let inString: '"' | "'" | null = null;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'";
      continue;
    }
    if (ch === ')') {
      depth++;
      continue;
    }
    if (ch === '(') {
      if (depth === 0) {
        // Capture the identifier just before this '('.
        const idMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(text.slice(0, i));
        if (!idMatch) return null;
        const name = idMatch[1]!.toUpperCase();
        if (FUNCTIONS.some((f) => f.name === name)) {
          return { name, argIndex };
        }
        return null;
      }
      depth--;
      continue;
    }
    if (ch === ',' && depth === 0) {
      argIndex++;
    }
  }
  return null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
