export const $ = (sel) => document.querySelector(sel);

/** Build an element. Children are added as text, so user content is never parsed as HTML. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = v;
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return node;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// Same rules as the beat sheet: "45", "1:30", "1:02:30" → seconds
export function parseTime(str) {
  const t = (str || '').trim();
  if (!/^\d+(:\d{1,2}){0,2}$/.test(t)) return null;
  return t.split(':').reduce((acc, n) => acc * 60 + Number(n), 0);
}

export function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function sceneRuntime(scene) {
  const secs = scene.beats.map((b) => parseTime(b.time)).filter((n) => n !== null);
  return secs.length ? formatTime(secs.reduce((a, b) => a + b, 0)) : null;
}
