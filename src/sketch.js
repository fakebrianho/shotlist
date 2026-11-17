// Full-screen drawing editor on a blank white 16:9 canvas.
const W = 1600;
const H = 900;

export function openSketch(shot, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'sketch-overlay';
  overlay.innerHTML = `
    <div class="sketch-toolbar">
      <div class="tool-group">
        <button class="tool active" data-tool="pen" title="Pen (P)">Pen</button>
        <button class="tool" data-tool="eraser" title="Eraser (E)">Eraser</button>
      </div>
      <div class="tool-group">
        <label>Size <input type="range" min="1" max="40" value="4" class="size" /></label>
      </div>
      <div class="tool-group colors">
        ${['#111111', '#d62828', '#1d4ed8', '#16a34a', '#9ca3af']
          .map((c, i) => `<button class="swatch${i === 0 ? ' active' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`)
          .join('')}
      </div>
      <div class="tool-group">
        <button class="btn undo" title="Undo (Ctrl+Z)">Undo</button>
        <button class="btn redo" title="Redo (Ctrl+Shift+Z)">Redo</button>
        <button class="btn clear">Clear</button>
      </div>
      <div class="spacer"></div>
      <button class="btn cancel">Cancel</button>
      <button class="btn primary save">Save</button>
    </div>
    <div class="sketch-stage"><canvas width="${W}" height="${H}"></canvas></div>
  `;
  document.body.append(overlay);

  const canvas = overlay.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  const q = (s) => overlay.querySelector(s);

  let tool = 'pen';
  let color = '#111111';
  let size = 4;
  const undoStack = [];
  const redoStack = [];

  function fillWhite() {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  fillWhite();
  if (shot.image) {
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, W, H);
    img.src = shot.image;
  }

  const snapshot = () => ctx.getImageData(0, 0, W, H);
  const pushUndo = () => {
    undoStack.push(snapshot());
    if (undoStack.length > 50) undoStack.shift();
    redoStack.length = 0;
  };

  function toCanvas(e) {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  }

  let drawing = false;
  let last = null;

  function strokeTo(p, pressure) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Eraser paints white so the canvas stays a solid white image
    ctx.strokeStyle = tool === 'eraser' ? '#ffffff' : color;
    const scale = W / canvas.getBoundingClientRect().width;
    const base = (tool === 'eraser' ? size * 4 : size) * scale;
    ctx.lineWidth = base * (pressure > 0 && pressure !== 0.5 ? 0.5 + pressure : 1);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    pushUndo();
    drawing = true;
    last = toCanvas(e);
    strokeTo({ x: last.x + 0.01, y: last.y }, e.pressure); // dot on single click
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) strokeTo(toCanvas(ev), ev.pressure);
  });
  const stop = () => (drawing = false);
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    ctx.putImageData(undoStack.pop(), 0, 0);
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    ctx.putImageData(redoStack.pop(), 0, 0);
  }

  function setTool(t) {
    tool = t;
    overlay.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    canvas.classList.toggle('erasing', t === 'eraser');
  }

  overlay.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  overlay.querySelectorAll('.swatch').forEach((b) =>
    b.addEventListener('click', () => {
      color = b.dataset.color;
      overlay.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s === b));
      setTool('pen');
    })
  );
  q('.size').addEventListener('input', (e) => (size = +e.target.value));
  q('.undo').addEventListener('click', undo);
  q('.redo').addEventListener('click', redo);
  q('.clear').addEventListener('click', () => {
    pushUndo();
    fillWhite();
  });

  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  function save() {
    onSave(canvas.toDataURL('image/png'));
    close();
  }
  q('.cancel').addEventListener('click', close);
  q('.save').addEventListener('click', save);

  function onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      if (!undoStack.length || confirm('Discard changes to this sketch?')) close();
    } else if (e.key === 'p') setTool('pen');
    else if (e.key === 'e') setTool('eraser');
  }
  document.addEventListener('keydown', onKey);
}
