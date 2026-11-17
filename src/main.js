import './style.css';
import * as db from './db.js';
import { imageUrl, onSaveStatus } from './api.js';
import { $, el, plural, timeAgo, sceneRuntime } from './dom.js';
import { openSketch } from './sketch.js';

const projectList = $('#project-list');
const main = $('#main');

let projects = [];
let currentId = null;
// The project on screen: { project, scenes, shots, comments }
let current = null;
// Comments drawer: null when closed, otherwise { targetId } (null targetId = all comments)
let drawer = null;

const SHOT_TYPES = ['', 'EWS', 'WS', 'MS', 'MCU', 'CU', 'ECU', 'OTS', 'POV', 'Insert'];

// Beats whose shot list is expanded (remembered across reloads)
const openBeats = new Set(JSON.parse(localStorage.getItem('openBeats') || '[]'));
const saveOpenBeats = () => localStorage.setItem('openBeats', JSON.stringify([...openBeats]));

/* ---------- Saving ---------- */

// Edits are saved shortly after you stop typing. Before reloading data from the
// server we flush any that are still waiting, so nothing typed gets lost.
const pending = new Map();
function debounce(fn, ms = 400) {
  let t;
  const run = () => {
    clearTimeout(t);
    pending.delete(run);
    return fn();
  };
  return () => {
    clearTimeout(t);
    pending.set(run, true);
    t = setTimeout(run, ms);
  };
}
const flushPending = () => Promise.all([...pending.keys()].map((run) => run()));
window.addEventListener('beforeunload', (e) => {
  if (pending.size) {
    flushPending();
    e.preventDefault();
  }
});

const status = el('div', { class: 'save-status', role: 'status', 'aria-live': 'polite' });
document.body.append(status);
let statusTimer;
function showStatus(msg, kind = '') {
  clearTimeout(statusTimer);
  status.textContent = msg;
  status.className = `save-status show ${kind}`;
  if (kind !== 'error' && kind !== 'busy') statusTimer = setTimeout(() => (status.className = 'save-status'), 1500);
}
onSaveStatus((s) => {
  if (s === 'saving') showStatus('Saving…', 'busy');
  else if (s === 'saved') showStatus('Saved');
  else showStatus('Couldn’t save — check your connection', 'error');
});

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason?.status === 401) showLogin();
  else if (e.reason?.message) showStatus(e.reason.message, 'error');
});

/* ---------- Login ---------- */

function showLogin(error = '') {
  $('#app').hidden = true;
  $('.login')?.remove();
  const input = el('input', { type: 'password', class: 'field', placeholder: 'Password', autocomplete: 'current-password', required: '' });
  const msg = el('p', { class: 'form-error' }, error);
  const form = el(
    'form',
    {
      class: 'login-card',
      onsubmit: async (e) => {
        e.preventDefault();
        msg.textContent = '';
        try {
          await db.login(input.value);
          $('.login').remove();
          $('#app').hidden = false;
          start();
        } catch (err) {
          msg.textContent = err.message;
          input.select();
        }
      },
    },
    el('h1', {}, 'Shot List'),
    el('p', { class: 'muted' }, 'Log in to edit your projects.'),
    input,
    msg,
    el('button', { class: 'btn primary', type: 'submit' }, 'Log in')
  );
  document.body.append(el('div', { class: 'login' }, form));
  input.focus();
}

/* ---------- Projects (folders) ---------- */

async function loadProjects() {
  projects = await db.getProjects();
  if (!projects.find((p) => p.id === currentId)) currentId = projects[0]?.id ?? null;
  if (currentId) localStorage.setItem('lastProject', currentId);
  renderSidebar();
  renderMain();
}

function renderSidebar() {
  projectList.replaceChildren(
    ...projects.map((p) =>
      el(
        'button',
        {
          class: 'project' + (p.id === currentId ? ' active' : ''),
          onclick: async () => {
            await flushPending();
            currentId = p.id;
            drawer = null;
            localStorage.setItem('lastProject', p.id);
            renderSidebar();
            renderMain();
          },
        },
        el('span', { class: 'folder-icon', 'aria-hidden': 'true' }, '▤'),
        el('span', { class: 'project-name' }, p.name)
      )
    )
  );
  if (!projects.length) {
    projectList.append(el('p', { class: 'muted pad' }, 'No projects yet.'));
  }
}

$('#new-project').addEventListener('click', async () => {
  const name = prompt('Project name', `Project ${projects.length + 1}`);
  if (!name?.trim()) return;
  const p = { id: db.uid(), name: name.trim(), createdAt: Date.now() };
  await db.putProject(p);
  currentId = p.id;
  await loadProjects();
});

/* ---------- Project: scenes → beats → shots ---------- */

const newBeat = (number) => ({
  id: db.uid(),
  number: String(number),
  title: '',
  description: '',
  about: '',
  mustSee: '',
  time: '',
});

// Shots made before scenes existed (or from old backups) aren't attached to a beat.
// Put them in their own scene so nothing is lost.
async function adoptOrphanShots(projectId, shots, scenes) {
  const beatIds = new Set(scenes.flatMap((sc) => sc.beats.map((b) => b.id)));
  const orphans = shots.filter((s) => !beatIds.has(s.beatId));
  if (!orphans.length) return false;
  const beat = { ...newBeat(1), title: 'Existing shots' };
  const scene = {
    id: db.uid(),
    projectId,
    order: scenes.length ? Math.max(...scenes.map((s) => s.order)) + 1 : 0,
    name: 'Unsorted shots',
    beats: [beat],
    createdAt: Date.now(),
  };
  await db.putScene(scene);
  await Promise.all(orphans.map((s) => db.putShot({ ...s, sceneId: scene.id, beatId: beat.id })));
  openBeats.add(beat.id);
  saveOpenBeats();
  return true;
}

let renderSeq = 0;
async function renderMain() {
  await flushPending();
  const seq = ++renderSeq;
  const project = projects.find((p) => p.id === currentId);
  if (!project) {
    current = null;
    renderDrawer();
    main.replaceChildren(
      el(
        'div',
        { class: 'empty' },
        el('h2', {}, 'Create a project to start'),
        el('p', { class: 'muted' }, 'Each project holds scenes → beats → shots.'),
        el('button', { class: 'btn primary', onclick: () => $('#new-project').click() }, '+ New project')
      )
    );
    return;
  }

  const { scenes, shots, comments } = await db.getProjectData(project.id);
  if (seq !== renderSeq) return; // a newer render started while loading
  if (await adoptOrphanShots(project.id, shots, scenes)) return renderMain();
  current = { project, scenes, shots, comments };

  const shotsByBeat = new Map();
  for (const s of shots) {
    if (!shotsByBeat.has(s.beatId)) shotsByBeat.set(s.beatId, []);
    shotsByBeat.get(s.beatId).push(s); // already sorted by order
  }
  const openComments = comments.filter((c) => !c.resolved && !c.fromOwner).length;

  const header = el(
    'header',
    { class: 'main-head' },
    el('input', {
      class: 'project-title',
      value: project.name,
      'aria-label': 'Project name',
      onchange: async (e) => {
        project.name = e.target.value.trim() || 'Untitled';
        await db.putProject(project);
        renderSidebar();
      },
    }),
    el('span', { class: 'muted' }, `${plural(scenes.length, 'scene')} · ${plural(shots.length, 'shot')}`),
    el('div', { class: 'spacer' }),
    el(
      'button',
      { class: 'btn' + (openComments ? ' has-badge' : ''), onclick: () => openDrawer(null) },
      'Comments',
      openComments ? el('span', { class: 'badge' }, String(openComments)) : null
    ),
    el('button', { class: 'btn', onclick: () => openShareDialog(project) }, 'Share'),
    el(
      'button',
      {
        class: 'btn danger',
        onclick: async () => {
          if (!confirm(`Delete "${project.name}" with all its scenes, shots, share links and comments?`)) return;
          await db.deleteProject(project.id);
          currentId = null;
          drawer = null;
          await loadProjects();
        },
      },
      'Delete project'
    ),
    el('button', { class: 'btn primary', onclick: () => addScene(project.id, scenes) }, '+ New scene')
  );

  main.replaceChildren(header, scenesView(project, scenes, shotsByBeat));
  renderDrawer();
}

/* ---------- Comment badges ---------- */

function commentBadge(targetId) {
  const list = current.comments.filter((c) => c.targetId === targetId);
  if (!list.length) return null;
  const open = list.filter((c) => !c.resolved && !c.fromOwner).length;
  return el(
    'button',
    {
      class: 'comment-chip' + (open ? ' open' : ''),
      title: open ? `${plural(open, 'open comment')}` : 'Comments',
      onclick: () => openDrawer(targetId),
    },
    `💬 ${list.length}`
  );
}

/* ---------- Shots (belong to a beat) ---------- */

const sketchOf = (shot) => ({ ...shot, image: imageUrl(shot) });

async function saveDrawing(shot, dataUrl) {
  await db.putShot({ ...shot, image: dataUrl });
  renderMain();
}

async function addShot(scene, beat, beatShots) {
  const order = beatShots.length ? Math.max(...beatShots.map((s) => s.order)) + 1 : 0;
  const shot = {
    id: db.uid(),
    projectId: scene.projectId,
    sceneId: scene.id,
    beatId: beat.id,
    order,
    title: '',
    type: '',
    notes: '',
    imageV: null,
    createdAt: Date.now(),
  };
  await db.putShot(shot);
  openBeats.add(beat.id);
  saveOpenBeats();
  await renderMain();
  // Jump straight into drawing the new blank canvas
  openSketch(sketchOf(shot), (dataUrl) => saveDrawing(shot, dataUrl));
}

function shotCard(shot, index, shots, label) {
  const save = debounce(() => db.putShot(shot));
  const src = imageUrl(shot);

  const thumb = el(
    'button',
    {
      class: 'canvas-thumb',
      title: 'Click to draw',
      onclick: () => openSketch(sketchOf(shot), (dataUrl) => saveDrawing(shot, dataUrl)),
    },
    src ? el('img', { src, alt: `Sketch for shot ${label}`, loading: 'lazy' }) : el('span', { class: 'muted' }, 'Click to draw')
  );

  const move = async (dir) => {
    const other = shots[index + dir];
    if (!other) return;
    [shot.order, other.order] = [other.order, shot.order];
    await Promise.all([db.putShot(shot), db.putShot(other)]);
    renderMain();
  };

  return el(
    'article',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('span', { class: 'shot-num' }, label),
      el('input', {
        class: 'shot-title',
        placeholder: 'Shot title',
        value: shot.title,
        oninput: (e) => {
          shot.title = e.target.value;
          save();
        },
      }),
      el(
        'select',
        {
          class: 'shot-type',
          'aria-label': 'Shot size',
          onchange: (e) => {
            shot.type = e.target.value;
            save();
          },
        },
        SHOT_TYPES.map((t) => {
          const o = el('option', { value: t }, t || 'Size');
          if (t === shot.type) o.selected = true;
          return o;
        })
      )
    ),
    thumb,
    el('textarea', {
      class: 'shot-notes',
      placeholder: 'Notes — action, lens, movement, dialogue…',
      rows: 2,
      oninput: (e) => {
        shot.notes = e.target.value;
        save();
      },
    }, shot.notes),
    el(
      'div',
      { class: 'card-actions' },
      el('button', { class: 'icon-btn', title: 'Move earlier', disabled: index === 0 ? '' : null, onclick: () => move(-1) }, '←'),
      el('button', { class: 'icon-btn', title: 'Move later', disabled: index === shots.length - 1 ? '' : null, onclick: () => move(1) }, '→'),
      commentBadge(shot.id),
      el('div', { class: 'spacer' }),
      el(
        'button',
        {
          class: 'icon-btn danger',
          title: 'Delete shot',
          onclick: async () => {
            if (!confirm('Delete this shot?')) return;
            await db.deleteShots([shot.id]);
            renderMain();
          },
        },
        'Delete'
      )
    )
  );
}

/* ---------- Scenes & beat sheets ---------- */

const sceneKey = (projectId) => `lastScene:${projectId}`;

async function addScene(projectId, scenes) {
  const name = prompt('Scene name', `Scene ${scenes.length + 1}`);
  if (!name?.trim()) return;
  const order = scenes.length ? Math.max(...scenes.map((s) => s.order)) + 1 : 0;
  const scene = {
    id: db.uid(),
    projectId,
    order,
    name: name.trim(),
    beats: [newBeat(1)],
    createdAt: Date.now(),
  };
  await db.putScene(scene);
  localStorage.setItem(sceneKey(projectId), scene.id);
  renderMain();
}

function scenesView(project, scenes, shotsByBeat) {
  if (!scenes.length) {
    return el(
      'div',
      { class: 'empty scenes-empty' },
      el('h2', {}, 'No scenes yet'),
      el('p', { class: 'muted' }, 'Each scene gets its own tab with a beat sheet, and each beat its own shot list.'),
      el('button', { class: 'btn primary', onclick: () => addScene(project.id, scenes) }, '+ New scene')
    );
  }

  const savedId = localStorage.getItem(sceneKey(project.id));
  const scene = scenes.find((s) => s.id === savedId) ?? scenes[0];

  const tabs = el(
    'div',
    { class: 'scene-tabs', role: 'tablist' },
    scenes.map((s) =>
      el(
        'button',
        {
          class: 'scene-tab' + (s.id === scene.id ? ' active' : ''),
          role: 'tab',
          'aria-selected': String(s.id === scene.id),
          title: s.name,
          onclick: () => {
            localStorage.setItem(sceneKey(project.id), s.id);
            renderMain();
          },
        },
        s.name || 'Untitled scene'
      )
    ),
    el('button', { class: 'scene-tab add', title: 'New scene', onclick: () => addScene(project.id, scenes) }, '+')
  );

  return el('section', { class: 'scenes' }, tabs, beatSheet(scene, scenes, shotsByBeat));
}

function beatSheet(scene, scenes, shotsByBeat) {
  const shotsFor = (beat) => shotsByBeat.get(beat.id) ?? [];
  const sceneShotCount = scene.beats.reduce((n, b) => n + shotsFor(b).length, 0);
  const save = debounce(() => db.putScene(scene));
  const runtimeEl = el('span', { class: 'muted runtime' });
  const updateRuntime = () => {
    const rt = sceneRuntime(scene);
    runtimeEl.textContent = rt ? `Runtime ${rt}` : '';
  };
  updateRuntime();

  const index = scenes.indexOf(scene);
  const moveScene = async (dir) => {
    const other = scenes[index + dir];
    if (!other) return;
    [scene.order, other.order] = [other.order, scene.order];
    await Promise.all([db.putScene(scene), db.putScene(other)]);
    renderMain();
  };

  const toolbar = el(
    'div',
    { class: 'scene-bar' },
    el('input', {
      class: 'scene-name',
      value: scene.name,
      'aria-label': 'Scene name',
      placeholder: 'Scene name',
      onchange: async (e) => {
        scene.name = e.target.value.trim() || 'Untitled scene';
        await db.putScene(scene);
        renderMain();
      },
    }),
    el('span', { class: 'muted' }, `${plural(scene.beats.length, 'beat')} · ${plural(sceneShotCount, 'shot')}`),
    runtimeEl,
    commentBadge(scene.id),
    el('div', { class: 'spacer' }),
    el('button', { class: 'icon-btn', title: 'Move scene tab left', disabled: index === 0 ? '' : null, onclick: () => moveScene(-1) }, '←'),
    el('button', { class: 'icon-btn', title: 'Move scene tab right', disabled: index === scenes.length - 1 ? '' : null, onclick: () => moveScene(1) }, '→'),
    el(
      'button',
      {
        class: 'icon-btn danger',
        onclick: async () => {
          if (!confirm(`Delete scene "${scene.name}" with all its beats, shots and comments?`)) return;
          await db.deleteShots(scene.beats.flatMap((b) => shotsFor(b).map((s) => s.id)));
          await db.deleteScene(scene.id);
          renderMain();
        },
      },
      'Delete scene'
    )
  );

  const COLS = [
    ['number', 'Beat #', 'input', '#'],
    ['title', 'Beat title', 'input', 'Beat title'],
    ['description', 'Description', 'textarea', 'What happens on screen'],
    ['about', "What it's about", 'textarea', 'The point / emotion / subtext'],
    ['mustSee', 'Must-see', 'textarea', 'Moments or shots we can’t miss'],
    ['time', 'Time', 'input', 'm:ss'],
  ];

  const moveBeat = async (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= scene.beats.length) return;
    [scene.beats[i], scene.beats[j]] = [scene.beats[j], scene.beats[i]];
    await db.putScene(scene);
    renderMain();
  };

  const beatRow = (beat, i) =>
    el(
      'div',
      { class: 'beat-row', role: 'row' },
      COLS.map(([key, label, tag, placeholder]) =>
        el(tag, {
          class: `beat-cell beat-${key}`,
          'aria-label': label,
          placeholder,
          rows: tag === 'textarea' ? 2 : null,
          value: tag === 'input' ? beat[key] : null,
          oninput: (e) => {
            beat[key] = e.target.value;
            if (key === 'time') updateRuntime();
            save();
          },
        }, tag === 'textarea' ? beat[key] : null)
      ),
      el(
        'div',
        { class: 'beat-actions' },
        el('button', { class: 'icon-btn', title: 'Move beat up', disabled: i === 0 ? '' : null, onclick: () => moveBeat(i, -1) }, '↑'),
        el('button', { class: 'icon-btn', title: 'Move beat down', disabled: i === scene.beats.length - 1 ? '' : null, onclick: () => moveBeat(i, 1) }, '↓'),
        el(
          'button',
          {
            class: 'icon-btn danger',
            title: 'Delete beat',
            onclick: async () => {
              const n = shotsFor(beat).length;
              if (!confirm(n ? `Delete this beat and its ${plural(n, 'shot')}?` : 'Delete this beat?')) return;
              await db.deleteShots(shotsFor(beat).map((s) => s.id));
              scene.beats.splice(i, 1);
              await db.putScene(scene);
              renderMain();
            },
          },
          '✕'
        )
      )
    );

  const shotList = (beat) => {
    const list = shotsFor(beat);
    const open = openBeats.has(beat.id);
    const toggle = el(
      'button',
      {
        class: 'shots-toggle' + (open ? ' open' : ''),
        'aria-expanded': String(open),
        onclick: () => {
          open ? openBeats.delete(beat.id) : openBeats.add(beat.id);
          saveOpenBeats();
          renderMain();
        },
      },
      el('span', { class: 'chev', 'aria-hidden': 'true' }, '▶'),
      `Shot list · ${plural(list.length, 'shot')}`
    );
    const bar = el('div', { class: 'beat-shots-bar' }, toggle, commentBadge(beat.id));
    if (!open) return el('div', { class: 'beat-shots' }, bar);

    // Shot numbers follow the beat: beat 3 → 3.1, 3.2, …
    const prefix = beat.number?.trim() || '';
    const grid = el(
      'div',
      { class: 'grid shot-grid' },
      list.map((s, j) => shotCard(s, j, list, prefix ? `${prefix}.${j + 1}` : String(j + 1))),
      el(
        'button',
        { class: 'add-card', onclick: () => addShot(scene, beat, list) },
        el('span', { class: 'plus' }, '+'),
        'Add shot'
      )
    );
    return el('div', { class: 'beat-shots' }, bar, grid);
  };

  const rows = scene.beats.map((beat, i) => el('div', { class: 'beat' }, beatRow(beat, i), shotList(beat)));

  const addBeat = async () => {
    const nums = scene.beats.map((b) => parseInt(b.number, 10)).filter((n) => !isNaN(n));
    scene.beats.push(newBeat(nums.length ? Math.max(...nums) + 1 : scene.beats.length + 1));
    await db.putScene(scene);
    await renderMain();
    // Focus the new beat's title so you can keep typing
    main.querySelector('.beat:last-child .beat-title')?.focus();
  };

  const table = el(
    'div',
    { class: 'beat-sheet', role: 'table', 'aria-label': `Beat sheet for ${scene.name}` },
    el(
      'div',
      { class: 'beat-row beat-head', role: 'row' },
      COLS.map(([, label]) => el('div', { role: 'columnheader' }, label)),
      el('div', {})
    ),
    rows
  );

  return el(
    'div',
    { class: 'scene-panel' },
    toolbar,
    el('div', { class: 'beat-scroll' }, table),
    el('button', { class: 'add-beat', onclick: addBeat }, '+ Add beat')
  );
}

/* ---------- Comments drawer ---------- */

// "Scene › Beat 3: Title › Shot 3.2" labels for every commentable item, in story order
function commentTargets() {
  const out = [];
  for (const scene of current.scenes) {
    out.push({ id: scene.id, type: 'scene', label: scene.name, sceneId: scene.id });
    for (const beat of scene.beats) {
      const beatLabel = `Beat ${beat.number}${beat.title ? `: ${beat.title}` : ''}`;
      out.push({ id: beat.id, type: 'beat', label: `${scene.name} › ${beatLabel}`, sceneId: scene.id });
      current.shots
        .filter((s) => s.beatId === beat.id)
        .forEach((s, j) => {
          const num = beat.number?.trim() ? `${beat.number.trim()}.${j + 1}` : j + 1;
          out.push({
            id: s.id,
            type: 'shot',
            label: `${scene.name} › Beat ${beat.number} › Shot ${num}${s.title ? `: ${s.title}` : ''}`,
            sceneId: scene.id,
          });
        });
    }
  }
  return out;
}

function openDrawer(targetId) {
  drawer = { targetId };
  renderDrawer();
}

function ownerName() {
  let name = localStorage.getItem('ownerName');
  if (!name) {
    name = prompt('Name to show on your replies', 'Director')?.trim();
    if (!name) return null;
    localStorage.setItem('ownerName', name);
  }
  return name;
}

function renderDrawer() {
  $('.drawer')?.remove();
  document.body.classList.toggle('drawer-open', !!(drawer && current));
  if (!drawer || !current) return;

  const close = () => {
    drawer = null;
    renderDrawer();
  };
  const targets = commentTargets();
  const groups = targets
    .filter((t) => !drawer.targetId || t.id === drawer.targetId)
    .map((t) => ({ ...t, comments: current.comments.filter((c) => c.targetId === t.id) }))
    .filter((g) => g.comments.length || g.id === drawer.targetId);

  const thread = (g) =>
    el(
      'section',
      { class: 'thread' },
      el(
        'button',
        {
          class: 'thread-target',
          title: 'Go to this scene',
          onclick: () => {
            localStorage.setItem(sceneKey(current.project.id), g.sceneId);
            renderMain();
          },
        },
        g.label
      ),
      g.comments.map((c) =>
        el(
          'div',
          { class: 'comment' + (c.resolved ? ' resolved' : '') + (c.fromOwner ? ' mine' : '') },
          el(
            'div',
            { class: 'comment-meta' },
            el('strong', {}, c.author),
            c.fromOwner ? el('span', { class: 'tag' }, 'You') : null,
            el('span', { class: 'muted' }, timeAgo(c.createdAt)),
            c.resolved ? el('span', { class: 'tag ok' }, 'Resolved') : null
          ),
          el('p', { class: 'comment-body' }, c.body),
          el(
            'div',
            { class: 'comment-actions' },
            el(
              'button',
              {
                class: 'icon-btn',
                onclick: async () => {
                  await db.resolveComment(c.id, !c.resolved);
                  c.resolved = !c.resolved;
                  renderMain();
                },
              },
              c.resolved ? 'Reopen' : 'Resolve'
            ),
            el(
              'button',
              {
                class: 'icon-btn danger',
                onclick: async () => {
                  if (!confirm('Delete this comment?')) return;
                  await db.deleteComment(c.id);
                  renderMain();
                },
              },
              'Delete'
            )
          )
        )
      ),
      replyForm(g)
    );

  const replyForm = (g) => {
    const input = el('textarea', { class: 'field', rows: 2, placeholder: g.comments.length ? 'Reply…' : 'Add a note…' });
    return el(
      'form',
      {
        class: 'reply',
        onsubmit: async (e) => {
          e.preventDefault();
          if (!input.value.trim()) return;
          const author = ownerName();
          if (!author) return;
          await db.addComment({ projectId: current.project.id, targetType: g.type, targetId: g.id, author, body: input.value });
          renderMain();
        },
      },
      input,
      el('button', { class: 'btn', type: 'submit' }, 'Post')
    );
  };

  const orphanCount = current.comments.filter((c) => !targets.some((t) => t.id === c.targetId)).length;

  document.body.append(
    el(
      'aside',
      { class: 'drawer', 'aria-label': 'Comments' },
      el(
        'div',
        { class: 'drawer-head' },
        el('h2', {}, 'Comments'),
        drawer.targetId ? el('button', { class: 'icon-btn', onclick: () => openDrawer(null) }, 'Show all') : null,
        el('div', { class: 'spacer' }),
        el('button', { class: 'icon-btn', 'aria-label': 'Close comments', onclick: close }, '✕')
      ),
      el(
        'div',
        { class: 'drawer-body' },
        groups.length
          ? groups.map(thread)
          : el('p', { class: 'muted' }, 'No comments yet. Share the project and clients can comment on scenes, beats and shots.'),
        orphanCount && !drawer.targetId
          ? el('p', { class: 'muted small' }, `${plural(orphanCount, 'comment')} on deleted items not shown.`)
          : null
      )
    )
  );
}

/* ---------- Share dialog ---------- */

async function openShareDialog(project) {
  $('.share-dialog')?.remove();
  const dialog = el('dialog', { class: 'share-dialog' });
  document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove());

  const linkFor = (token) => `${location.origin}/share/${token}`;

  async function render(newLink) {
    const shares = await db.getShares(project.id);
    const live = shares.filter((s) => !s.revoked && !(s.expiresAt && s.expiresAt < Date.now()));

    const label = el('input', { class: 'field', placeholder: 'Who is it for? e.g. "Client – Acme"', maxlength: 100 });
    const password = el('input', { class: 'field', type: 'text', placeholder: 'Password (min. 4 characters)', required: '', minlength: 4, autocomplete: 'off' });
    const expiry = el(
      'select',
      { class: 'field' },
      [['0', 'Never expires'], ['1', 'Expires in 1 day'], ['7', 'Expires in 7 days'], ['30', 'Expires in 30 days']].map(([v, t]) =>
        el('option', { value: v }, t)
      )
    );
    const error = el('p', { class: 'form-error' });

    dialog.replaceChildren(
      el(
        'div',
        { class: 'dialog-head' },
        el('h2', {}, `Share “${project.name}”`),
        el('div', { class: 'spacer' }),
        el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => dialog.close() }, '✕')
      ),
      el('p', { class: 'muted' }, 'Clients can view scenes, beats and shots, and leave comments. They can’t edit anything.'),
      newLink
        ? el(
            'div',
            { class: 'new-link' },
            el('strong', {}, 'Link created. Send the client the link and the password:'),
            el('code', {}, linkFor(newLink.token)),
            el('div', {}, 'Password: ', el('code', {}, newLink.password)),
            el('button', { class: 'btn', onclick: (e) => copy(e.target, `${linkFor(newLink.token)}\nPassword: ${newLink.password}`) }, 'Copy link + password')
          )
        : null,
      el(
        'form',
        {
          class: 'share-form',
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              const share = await db.createShare({
                projectId: project.id,
                label: label.value,
                password: password.value,
                expiresInDays: Number(expiry.value),
              });
              render({ token: share.token, password: password.value });
            } catch (err) {
              error.textContent = err.message;
            }
          },
        },
        el('h3', {}, 'New share link'),
        label,
        password,
        expiry,
        error,
        el('button', { class: 'btn primary', type: 'submit' }, 'Create link')
      ),
      el('h3', {}, `Active links (${live.length})`),
      live.length
        ? el(
            'ul',
            { class: 'share-list' },
            live.map((s) =>
              el(
                'li',
                {},
                el(
                  'div',
                  { class: 'share-info' },
                  el('strong', {}, s.label || 'Untitled link'),
                  el(
                    'span',
                    { class: 'muted small' },
                    `Created ${timeAgo(s.createdAt)}` + (s.expiresAt ? ` · expires ${new Date(s.expiresAt).toLocaleDateString()}` : '')
                  )
                ),
                el('button', { class: 'btn', onclick: (e) => copy(e.target, linkFor(s.token)) }, 'Copy link'),
                el(
                  'button',
                  {
                    class: 'btn danger',
                    onclick: async () => {
                      if (!confirm('Turn off this link? Anyone using it will lose access.')) return;
                      await db.revokeShare(s.token);
                      render();
                    },
                  },
                  'Turn off'
                )
              )
            )
          )
        : el('p', { class: 'muted small' }, 'No active links.')
    );
    if (!dialog.open) dialog.showModal();
  }

  render();
}

async function copy(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = 'Copied!';
    setTimeout(() => (button.textContent = old), 1500);
  } catch {
    prompt('Copy this:', text);
  }
}

/* ---------- Backup & account ---------- */

$('#export').addEventListener('click', async () => {
  await flushPending();
  showStatus('Preparing backup…', 'busy');
  const data = await db.exportAll();
  showStatus('Backup ready');
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = el('a', {
    href: URL.createObjectURL(blob),
    download: `shot-list-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

async function runImport(data) {
  try {
    await db.importAll(data, (done, total) => showStatus(`Importing ${done}/${total}…`, 'busy'));
    showStatus('Import finished');
    await loadProjects();
    return true;
  } catch (err) {
    showStatus('Import failed', 'error');
    alert('Import failed: ' + err.message);
    return false;
  }
}

$('#import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return alert('That file isn’t a Shot List backup.');
  }
  if (await runImport(data)) alert('Backup imported.');
});

// Projects made with the old offline version live in this browser only. Offer to upload them.
async function offerLegacyImport() {
  if (localStorage.getItem('legacyImported')) return;
  const legacy = await db.readLegacyLocal();
  if (!legacy) return;
  const btn = el(
    'button',
    {
      class: 'btn legacy',
      onclick: async () => {
        const n = legacy.projects.length;
        if (!confirm(`Upload ${plural(n, 'project')} saved in this browser by the old offline version?`)) return;
        if (await runImport(legacy)) {
          localStorage.setItem('legacyImported', '1');
          btn.remove();
          alert('Done — your old projects are now saved online.');
        }
      },
    },
    'Upload old local projects'
  );
  $('.sidebar-foot').prepend(btn);
}

function addLogout() {
  if ($('#logout')) return;
  $('.sidebar-foot').append(
    el(
      'button',
      {
        id: 'logout',
        class: 'btn',
        onclick: async () => {
          await flushPending();
          await db.logout();
          location.reload();
        },
      },
      'Log out'
    )
  );
}

/* ---------- Start ---------- */

async function start() {
  addLogout();
  offerLegacyImport();
  currentId = localStorage.getItem('lastProject');
  await loadProjects();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawer && !document.querySelector('.sketch-overlay, dialog[open]')) {
    drawer = null;
    renderDrawer();
  }
});

db.me()
  .then(({ owner }) => (owner ? start() : showLogin()))
  .catch(() => showLogin('Can’t reach the server.'));
