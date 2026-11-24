// Screenplay editor modelled on Final Draft: a script is a list of elements
// ({ id, type, text }) laid out in industry-standard screenplay format.
import { el, formatTime } from './dom.js';

export const ELEMENTS = [
  ['heading', 'Scene Heading'],
  ['action', 'Action'],
  ['character', 'Character'],
  ['parenthetical', 'Parenthetical'],
  ['dialogue', 'Dialogue'],
  ['transition', 'Transition'],
  ['shot', 'Shot'],
];
const LABEL = Object.fromEntries(ELEMENTS);

// What Enter creates after each element, and what Tab / Shift+Tab switch it to (as in Final Draft)
const ENTER_NEXT = { heading: 'action', action: 'action', character: 'dialogue', parenthetical: 'dialogue', dialogue: 'character', transition: 'heading', shot: 'action' };
const TAB_NEXT = { action: 'character', character: 'transition', transition: 'heading', heading: 'action', dialogue: 'parenthetical', parenthetical: 'dialogue', shot: 'action' };
const TAB_PREV = { action: 'heading', character: 'action', transition: 'character', heading: 'transition', dialogue: 'character', parenthetical: 'dialogue', shot: 'action' };

const PLACEHOLDER = {
  heading: 'INT. LOCATION - DAY',
  action: 'Action',
  character: 'CHARACTER',
  parenthetical: '(beat)',
  dialogue: 'Dialogue',
  transition: 'CUT TO:',
  shot: 'ANGLE ON',
};

const HEADING_PREFIXES = ['INT. ', 'EXT. ', 'INT./EXT. '];
const TIMES = ['DAY', 'NIGHT', 'MORNING', 'AFTERNOON', 'EVENING', 'DAWN', 'DUSK', 'CONTINUOUS', 'LATER', 'MOMENTS LATER', 'SAME'];
const TRANSITIONS = ['CUT TO:', 'FADE IN:', 'FADE OUT.', 'FADE TO BLACK.', 'DISSOLVE TO:', 'SMASH CUT TO:', 'MATCH CUT TO:', 'JUMP CUT TO:', 'CUT TO BLACK.'];
const HEADING_RE = /^(INT\.\/EXT\.|INT\/EXT\.?|I\/E\.?|INT\.|EXT\.|EST\.)\s+(.*)$/i;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const newElement = (type, text = '') => ({ id: uid(), type, text });
const clone = (blocks) => blocks.map((b) => ({ ...b }));
export const hasContent = (blocks) => (blocks || []).some((b) => b.text.trim());

const characterName = (text) => text.trim().toUpperCase().replace(/\s*\(.*\)\s*$/, '');

/* ---------- Page count (Final Draft-style estimate: ~55 lines per page, 1 page ≈ 1 minute) ---------- */

const CHARS_PER_LINE = { heading: 60, action: 60, shot: 60, transition: 60, character: 38, dialogue: 35, parenthetical: 23 };
const SPACE_BEFORE = { heading: 2, action: 1, shot: 1, transition: 1, character: 1, dialogue: 0, parenthetical: 0 };

export function pageCount(blocks) {
  let lines = 0;
  blocks.forEach((b, i) => {
    if (!b.text.trim()) return;
    if (i > 0) lines += SPACE_BEFORE[b.type] ?? 1;
    lines += Math.max(1, Math.ceil(b.text.length / (CHARS_PER_LINE[b.type] || 60)));
  });
  return lines / 55;
}

export function lengthLabel(blocks) {
  const pages = pageCount(blocks);
  if (!pages) return '';
  return `${pages < 1 ? `${Math.max(1, Math.round(pages * 8))}/8` : pages.toFixed(1)} pg · ~${formatTime(Math.round(pages * 60))}`;
}

/* ---------- Shared rendering ---------- */

// Final Draft adds (CONT'D) when the same character speaks again after action.
function markContinueds(page) {
  let last = null;
  for (const node of page.children) {
    const type = node.dataset.type;
    if (type === 'heading' || type === 'transition') last = null;
    if (type !== 'character') continue;
    const name = characterName(node.textContent);
    node.toggleAttribute('data-contd', !!name && name === last && !/CONT'?D/i.test(node.textContent));
    if (name) last = name;
  }
}

/** Read-only, formatted script (client page, printing). */
export function renderScript(blocks) {
  const page = el(
    'div',
    { class: 'script-page readonly' },
    blocks.filter((b) => b.text.trim()).map((b) => el('div', { class: `sp-el sp-${b.type}`, 'data-type': b.type }, b.text))
  );
  markContinueds(page);
  return page;
}

/** Print the given script blocks as standard screenplay pages (or save as PDF). */
export function printScript(title, blocks) {
  const root = el(
    'div',
    { class: 'print-root' },
    el('div', { class: 'print-title' }, el('h1', {}, title), el('p', {}, 'Screenplay')),
    renderScript(blocks)
  );
  document.body.append(root);
  document.body.classList.add('printing');
  const done = () => {
    root.remove();
    document.body.classList.remove('printing');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

/* ---------- Final Draft (.fdx) import / export ---------- */

const FDX_TYPES = {
  heading: 'Scene Heading',
  action: 'Action',
  character: 'Character',
  parenthetical: 'Parenthetical',
  dialogue: 'Dialogue',
  transition: 'Transition',
  shot: 'Shot',
};
const FROM_FDX = Object.fromEntries(Object.entries(FDX_TYPES).map(([k, v]) => [v, k]));
const UPPERCASE = new Set(['heading', 'character', 'transition', 'shot']);

export function toFDX(blocks) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const paragraphs = blocks
    .filter((b) => b.text.trim())
    .map((b) => {
      const text = UPPERCASE.has(b.type) ? b.text.toUpperCase() : b.text;
      return `    <Paragraph Type="${FDX_TYPES[b.type]}">\n      <Text>${esc(text)}</Text>\n    </Paragraph>`;
    });
  return `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5">
  <Content>
${paragraphs.join('\n')}
  </Content>
</FinalDraft>
`;
}

export function parseFDX(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const content = doc.querySelector('FinalDraft > Content');
  if (doc.querySelector('parsererror') || !content) throw new Error('That isn’t a Final Draft (.fdx) file.');
  return [...content.querySelectorAll('Paragraph')]
    .filter((p) => !p.querySelector('Paragraph')) // dual dialogue wraps its own paragraphs
    .map((p) => {
      const text = [...p.getElementsByTagName('Text')].map((t) => t.textContent).join('');
      return newElement(FROM_FDX[p.getAttribute('Type')] || 'action', text.replace(/\s*\n\s*/g, ' ').trim());
    })
    .filter((b) => b.text);
}

/** Split a script into chunks that each start at a scene heading. */
export function splitByHeading(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'heading' || !out.length) out.push([]);
    out[out.length - 1].push(b);
  }
  return out;
}

/** Turn pasted plain text (or Fountain) into script elements. */
export function parsePlain(text) {
  const out = [];
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  for (const para of paragraphs) {
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const first = lines[0];
    const isCaps = (s) => /[A-Z]/.test(s) && s === s.toUpperCase();
    if (HEADING_RE.test(first) || /^\.[^.]/.test(first)) {
      out.push(newElement('heading', first.replace(/^\./, '')));
      lines.slice(1).forEach((l) => out.push(newElement('action', l)));
    } else if (lines.length === 1 && (/^>/.test(first) && !/<$/.test(first) || (isCaps(first) && /TO:$/.test(first)))) {
      out.push(newElement('transition', first.replace(/^>\s*/, '')));
    } else if (lines.length > 1 && (isCaps(first) || first.startsWith('@')) && !/^!/.test(first)) {
      out.push(newElement('character', first.replace(/^@/, '')));
      let speech = [];
      const flush = () => speech.length && out.push(newElement('dialogue', speech.join(' '))) && (speech = []);
      for (const l of lines.slice(1)) {
        if (/^\(.*\)$/.test(l)) {
          flush();
          out.push(newElement('parenthetical', l));
        } else speech.push(l);
      }
      flush();
    } else {
      lines.forEach((l) => out.push(newElement('action', l.replace(/^!/, ''))));
    }
  }
  return out;
}

/* ---------- Caret helpers ---------- */

function selectionIn(node) {
  const sel = getSelection();
  if (!sel.rangeCount || !node.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(node);
  pre.setEnd(r.startContainer, r.startOffset);
  const start = pre.toString().length;
  return { start, end: start + r.toString().length, range: r };
}

function placeCaret(node, offset) {
  if (!node) return;
  node.focus({ preventScroll: false });
  const range = document.createRange();
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let t;
  let placed = false;
  while ((t = walker.nextNode())) {
    if (remaining <= t.length) {
      range.setStart(t, remaining);
      placed = true;
      break;
    }
    remaining -= t.length;
  }
  if (!placed) range.selectNodeContents(node);
  range.collapse(placed);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function caretRect(range) {
  const rects = range.getClientRects();
  return rects.length ? rects[0] : range.getBoundingClientRect();
}

function caretFromPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p && { node: p.offsetNode, offset: p.offset };
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r && { node: r.startContainer, offset: r.startOffset };
}

const PLAINTEXT_ONLY = (() => {
  const d = document.createElement('div');
  d.contentEditable = 'plaintext-only';
  return d.contentEditable === 'plaintext-only';
})();

/* ---------- Editor ---------- */

/**
 * @param {object} o
 * @param {Array} o.blocks       the scene's script (copied; changes come back through onChange)
 * @param {Function} o.onChange  called with a fresh copy of the blocks after every edit
 * @param {Function} o.getOtherBlocks  elements from other scenes, for SmartType suggestions
 * @param {Node[]} o.actions     extra toolbar buttons (import / export / print)
 */
export function scriptEditor({ blocks: initial, onChange, getOtherBlocks = () => [], actions = [] }) {
  let blocks = initial?.length ? clone(initial) : [newElement('heading')];
  let cur = 0;
  let history = [];
  let future = [];
  let lastTyping = 0;
  let suggestions = [];
  let picked = 0;

  const page = el('div', { class: 'script-page', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Screenplay' });
  const popup = el('div', { class: 'sp-suggest', hidden: '' });
  const sheet = el('div', { class: 'script-sheet' }, page, popup);
  const typeSelect = el(
    'select',
    {
      class: 'field sp-type',
      'aria-label': 'Element',
      onchange: (e) => setType(cur, e.target.value),
    },
    ELEMENTS.map(([v, label], i) => el('option', { value: v }, `${label}  (${i + 1})`))
  );
  const stats = el('span', { class: 'muted small runtime' });
  const help = el(
    'details',
    { class: 'sp-help' },
    el('summary', {}, 'Shortcuts'),
    el(
      'div',
      { class: 'sp-help-body' },
      el('p', {}, el('b', {}, 'Enter'), ' new element: Heading → Action, Character → Dialogue, Dialogue → Character. Enter on an empty element turns it into Action.'),
      el('p', {}, el('b', {}, 'Tab / Shift+Tab'), ' change element: Action ⇄ Character ⇄ Transition, Dialogue ⇄ Parenthetical.'),
      el('p', {}, el('b', {}, 'Alt/⌥ + 1–7'), ' jump to an element (order as in the menu).'),
      el('p', {}, el('b', {}, 'SmartType'), ' suggests character names, INT./EXT., locations, times of day and transitions. ↑↓ to pick, Enter or Tab to accept.'),
      el('p', {}, 'Type ', el('b', {}, 'int. '), ' in Action to start a scene heading, or ', el('b', {}, '('), ' in Dialogue for a parenthetical. Paste plain text or Fountain and it’s formatted for you.')
    )
  );
  const toolbar = el('div', { class: 'sp-toolbar' }, typeSelect, stats, el('div', { class: 'spacer' }), actions, help);

  const nodes = () => page.children;
  const snap = () => ({ blocks: clone(blocks), focus: { i: cur, off: selectionIn(nodes()[cur] || page)?.start ?? 0 } });
  let committed = { blocks: clone(blocks), focus: { i: 0, off: 0 } };

  function refreshChrome() {
    typeSelect.value = blocks[cur]?.type ?? 'action';
    stats.textContent = lengthLabel(blocks);
  }

  function changed(typing) {
    const now = Date.now();
    if (!typing || now - lastTyping > 1000) {
      history.push(committed);
      if (history.length > 300) history.shift();
      future = [];
    }
    lastTyping = typing ? now : 0;
    committed = snap();
    refreshChrome();
    onChange(clone(blocks));
  }

  function nodeFor(b, i) {
    const n = el('div', {
      class: `sp-el sp-${b.type}` + (b.text ? '' : ' is-empty'),
      contenteditable: PLAINTEXT_ONLY ? 'plaintext-only' : 'true',
      spellcheck: 'true',
      'data-type': b.type,
      'data-ph': PLACEHOLDER[b.type],
      'data-i': i,
    });
    n.textContent = b.text;
    return n;
  }

  function render(focus) {
    page.replaceChildren(...blocks.map(nodeFor));
    markContinueds(page);
    if (focus) {
      cur = Math.max(0, Math.min(focus.i, blocks.length - 1));
      placeCaret(nodes()[cur], Math.min(focus.off, blocks[cur].text.length));
    }
    refreshChrome();
  }

  function restore(state) {
    blocks = clone(state.blocks);
    committed = state;
    lastTyping = 0;
    hideSuggest();
    render(state.focus);
    onChange(clone(blocks));
  }
  const undo = () => history.length && (future.push(snap()), restore(history.pop()));
  const redo = () => future.length && (history.push(snap()), restore(future.pop()));

  function setType(i, type) {
    const b = blocks[i];
    if (!b || b.type === type) return placeCaret(nodes()[i], selectionIn(nodes()[i])?.start ?? b?.text.length ?? 0);
    let off = selectionIn(nodes()[i])?.start ?? b.text.length;
    if (b.type === 'parenthetical') {
      const m = b.text.match(/^\((.*)\)$/);
      if (m) {
        b.text = m[1];
        off = Math.max(0, off - 1);
      }
    }
    if (type === 'parenthetical') {
      if (!b.text) {
        b.text = '()';
        off = 1;
      } else if (!/^\(.*\)$/.test(b.text)) {
        b.text = `(${b.text})`;
        off += 1;
      }
    }
    b.type = type;
    render({ i, off });
    changed(false);
  }

  function enter() {
    const node = nodes()[cur];
    const b = blocks[cur];
    const s = selectionIn(node) ?? { start: b.text.length, end: b.text.length };
    if (!b.text.trim()) {
      if (b.type !== 'action') setType(cur, 'action');
      return;
    }
    if (s.start === 0 && s.end === 0) {
      // Enter at the very start: open a blank element above, like Final Draft
      blocks.splice(cur, 0, newElement(b.type));
      render({ i: cur + 1, off: 0 });
      return changed(false);
    }
    let before = b.text.slice(0, s.start);
    let after = b.text.slice(s.end);
    if (b.type === 'parenthetical' && after === ')') {
      before += ')';
      after = '';
    }
    b.text = before;
    blocks.splice(cur + 1, 0, newElement(after ? b.type : ENTER_NEXT[b.type], after));
    render({ i: cur + 1, off: 0 });
    changed(false);
  }

  function mergeWithPrevious(i) {
    const prev = blocks[i - 1];
    const b = blocks[i];
    if (!prev.text) {
      blocks.splice(i - 1, 1);
      render({ i: i - 1, off: 0 });
    } else {
      const off = prev.text.length;
      prev.text += b.text;
      blocks.splice(i, 1);
      render({ i: i - 1, off });
    }
    changed(false);
  }

  function moveVertical(dir, range) {
    const node = nodes()[cur];
    const target = nodes()[cur + dir];
    if (!target) return false;
    const lh = parseFloat(getComputedStyle(node).lineHeight) || 16;
    const r = node.getBoundingClientRect();
    const c = caretRect(range);
    const empty = !c.height;
    const onEdge = empty || (dir < 0 ? c.top - r.top < lh * 0.75 : r.bottom - c.bottom < lh * 0.75);
    if (!onEdge) return false;
    const tr = target.getBoundingClientRect();
    const x = empty ? tr.left + 1 : c.left;
    const pos = caretFromPoint(x, dir < 0 ? tr.bottom - lh / 2 : tr.top + lh / 2);
    cur += dir;
    if (pos && target.contains(pos.node)) {
      target.focus();
      const sel = getSelection();
      const nr = document.createRange();
      nr.setStart(pos.node, pos.offset);
      nr.collapse(true);
      sel.removeAllRanges();
      sel.addRange(nr);
    } else {
      placeCaret(target, dir < 0 ? blocks[cur].text.length : 0);
    }
    return true;
  }

  /* --- SmartType suggestions --- */

  function suggestionsFor(b) {
    const T = b.text.toUpperCase();
    const all = [...getOtherBlocks(), ...blocks];
    const unique = (list) => [...new Set(list)];
    if (b.type === 'character') {
      const typed = T.trim();
      if (!typed) return [];
      const names = unique(all.filter((x) => x.type === 'character' && x !== b).map((x) => characterName(x.text)).filter(Boolean));
      return names.filter((n) => n.startsWith(typed) && n !== typed).slice(0, 6);
    }
    if (b.type === 'transition') return TRANSITIONS.filter((t) => t.startsWith(T.trim()) && t !== T.trim());
    if (b.type === 'heading') {
      const m = T.match(HEADING_RE);
      if (!m) return HEADING_PREFIXES.filter((p) => p.startsWith(T) && p !== T);
      const [, prefix, rest] = m;
      const dash = rest.lastIndexOf(' - ');
      if (dash >= 0) {
        const tod = rest.slice(dash + 3);
        return TIMES.filter((t) => t.startsWith(tod) && t !== tod).map((t) => `${prefix} ${rest.slice(0, dash)} - ${t}`);
      }
      const locations = unique(
        all
          .filter((x) => x.type === 'heading' && x !== b)
          .map((x) => x.text.toUpperCase().match(HEADING_RE)?.[2].split(' - ')[0].trim())
          .filter(Boolean)
      );
      return locations.filter((l) => l.startsWith(rest.trim()) && l !== rest.trim()).slice(0, 6).map((l) => `${prefix} ${l} - `);
    }
    return [];
  }

  function hideSuggest() {
    suggestions = [];
    popup.hidden = true;
  }

  function showSuggest() {
    const node = nodes()[cur];
    const b = blocks[cur];
    suggestions = b && document.activeElement === node ? suggestionsFor(b) : [];
    if (!suggestions.length) return hideSuggest();
    picked = Math.min(picked, suggestions.length - 1);
    popup.replaceChildren(
      ...suggestions.map((s, k) =>
        el(
          'div',
          {
            class: 'sp-opt' + (k === picked ? ' on' : ''),
            onmousedown: (e) => {
              e.preventDefault();
              accept(k, false);
            },
          },
          s.trim()
        )
      )
    );
    popup.hidden = false;
    popup.style.top = `${node.offsetTop + node.offsetHeight + 2}px`;
    popup.style.left = `${node.offsetLeft}px`;
  }

  function accept(k, thenEnter) {
    const b = blocks[cur];
    b.text = suggestions[k];
    const node = nodes()[cur];
    node.textContent = b.text;
    node.classList.remove('is-empty');
    placeCaret(node, b.text.length);
    hideSuggest();
    changed(false);
    markContinueds(page);
    if (thenEnter && b.type === 'character') enter();
    else {
      picked = 0;
      showSuggest(); // e.g. location → time of day
    }
  }

  /* --- Events --- */

  page.addEventListener('focusin', (e) => {
    const i = Number(e.target.dataset?.i);
    if (Number.isInteger(i)) {
      if (i !== cur) hideSuggest();
      cur = i;
      refreshChrome();
    }
  });
  page.addEventListener('focusout', () => setTimeout(() => !page.contains(document.activeElement) && hideSuggest()));

  page.addEventListener('input', (e) => {
    const node = e.target;
    const i = Number(node.dataset.i);
    const b = blocks[i];
    if (!b) return;
    b.text = node.textContent.replace(/\n/g, ' ');
    node.classList.toggle('is-empty', !b.text);
    // Smart conversions, as in Final Draft
    if (b.type === 'dialogue' && b.text === '(') {
      b.type = 'parenthetical';
      b.text = '()';
      render({ i, off: 1 });
    } else if (b.type === 'action' && /^(INT|EXT|EST|INT\.\/EXT|I\/E)\.\s$/i.test(b.text)) {
      b.type = 'heading';
      render({ i, off: b.text.length });
    }
    changed(true);
    if (b.type === 'character') markContinueds(page);
    picked = 0;
    showSuggest();
  });

  page.addEventListener('beforeinput', (e) => {
    if (e.inputType === 'historyUndo') {
      e.preventDefault();
      undo();
    } else if (e.inputType === 'historyRedo') {
      e.preventDefault();
      redo();
    } else if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
      // Mobile keyboards send Enter this way
      e.preventDefault();
      enter();
    }
  });

  page.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    const node = nodes()[cur];
    const b = blocks[cur];
    if (!node || !b) return;

    if (!popup.hidden && suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        picked = (picked + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
        return showSuggest();
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        return accept(picked, e.key === 'Enter');
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        return hideSuggest();
      }
    }

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      return redo();
    }
    const digit = /^Digit([1-7])$/.exec(e.code);
    if (digit && (e.altKey || mod)) {
      e.preventDefault();
      return setType(cur, ELEMENTS[Number(digit[1]) - 1][0]);
    }
    if (e.key === 'Enter' && !mod && !e.altKey) {
      e.preventDefault();
      return enter();
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      return setType(cur, (e.shiftKey ? TAB_PREV : TAB_NEXT)[b.type]);
    }

    const s = selectionIn(node);
    if (!s) return;
    const collapsed = s.start === s.end;
    if (e.key === 'Backspace' && collapsed && s.start === 0 && !mod) {
      if (b.type === 'parenthetical' && b.text === '()') {
        e.preventDefault();
        b.text = '';
        return setType(cur, 'dialogue');
      }
      if (cur > 0) {
        e.preventDefault();
        mergeWithPrevious(cur);
      }
      return;
    }
    if (b.type === 'parenthetical' && b.text === '()' && e.key === 'Backspace' && collapsed) {
      e.preventDefault();
      b.text = '';
      return setType(cur, 'dialogue');
    }
    if (e.key === 'Delete' && collapsed && s.start === b.text.length && cur < blocks.length - 1) {
      e.preventDefault();
      cur += 1;
      return mergeWithPrevious(cur);
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && collapsed) {
      if (moveVertical(e.key === 'ArrowUp' ? -1 : 1, s.range)) e.preventDefault();
      return;
    }
    if (e.key === 'ArrowLeft' && collapsed && s.start === 0 && cur > 0 && !e.shiftKey) {
      e.preventDefault();
      cur -= 1;
      return placeCaret(nodes()[cur], blocks[cur].text.length);
    }
    if (e.key === 'ArrowRight' && collapsed && s.start === b.text.length && cur < blocks.length - 1 && !e.shiftKey) {
      e.preventDefault();
      cur += 1;
      return placeCaret(nodes()[cur], 0);
    }
  });

  page.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const node = nodes()[cur];
    const b = blocks[cur];
    if (!/\n/.test(text.trim())) {
      document.execCommand('insertText', false, text.replace(/\s*\n\s*/g, ' '));
      return;
    }
    const parsed = parsePlain(text);
    if (!parsed.length) return;
    const s = selectionIn(node) ?? { start: b.text.length, end: b.text.length };
    const before = b.text.slice(0, s.start);
    const after = b.text.slice(s.end);
    const last = parsed[parsed.length - 1];
    const off = last.text.length;
    last.text += after;
    if (before.trim()) {
      b.text = before;
      blocks.splice(cur + 1, 0, ...parsed);
      render({ i: cur + parsed.length, off });
    } else {
      blocks.splice(cur, 1, ...parsed);
      render({ i: cur + parsed.length - 1, off });
    }
    changed(false);
  });

  page.addEventListener('drop', (e) => e.preventDefault());

  // Click on the page margin → put the caret in the nearest element
  sheet.addEventListener('mousedown', (e) => {
    if (e.target !== page && e.target !== sheet) return;
    e.preventDefault();
    const list = [...nodes()];
    const near = list.find((n) => n.getBoundingClientRect().bottom >= e.clientY) ?? list[list.length - 1];
    cur = list.indexOf(near);
    placeCaret(near, blocks[cur].text.length);
  });

  render();

  const root = el('div', { class: 'script-editor' }, toolbar, el('div', { class: 'script-wrap' }, sheet));

  /** Add elements (e.g. from an imported file). Replaces the script if it's empty. */
  root.addBlocks = (more) => {
    blocks = hasContent(blocks) ? [...blocks, ...more] : clone(more);
    render({ i: blocks.length - 1, off: blocks[blocks.length - 1].text.length });
    changed(false);
  };
  return root;
}
