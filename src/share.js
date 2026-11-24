// Client view of a shared project: read-only scenes → beats → shots, with comments.
import './style.css';
import { api, imageUrl } from './api.js';
import { el, plural, timeAgo, sceneRuntime } from './dom.js';
import { renderScript, printScript, lengthLabel, hasContent } from './script.js';

const root = document.getElementById('share');
const token = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '');
const sceneKey = `share:${token}:scene`;
let data = null; // { project, scenes, shots, comments }
const openThreads = new Set();

const getName = () => localStorage.getItem('clientName') || '';
const setName = (n) => localStorage.setItem('clientName', n);

function message(title, text) {
  root.replaceChildren(el('div', { class: 'login' }, el('div', { class: 'login-card' }, el('h1', {}, title), el('p', { class: 'muted' }, text))));
}

async function load() {
  if (!token) return message('Link not found', 'This share link looks incomplete.');
  try {
    data = await api('share-data', { params: { s: token } });
    document.title = `${data.project.name} — Shared`;
    render();
  } catch (err) {
    if (err.status === 401) showPassword();
    else if (err.status === 404) message('Link not available', err.message);
    else message('Something went wrong', 'Please try again in a moment.');
  }
}

function showPassword() {
  const input = el('input', { type: 'password', class: 'field', placeholder: 'Password', required: '', autocomplete: 'current-password' });
  const error = el('p', { class: 'form-error' });
  root.replaceChildren(
    el(
      'div',
      { class: 'login' },
      el(
        'form',
        {
          class: 'login-card',
          onsubmit: async (e) => {
            e.preventDefault();
            error.textContent = '';
            try {
              await api('share-login', { body: { token, password: input.value } });
              load();
            } catch (err) {
              error.textContent = err.message;
              input.select();
            }
          },
        },
        el('h1', {}, 'Shared project'),
        el('p', { class: 'muted' }, 'Enter the password you were given to view this project.'),
        input,
        error,
        el('button', { class: 'btn primary', type: 'submit' }, 'View project')
      )
    )
  );
  input.focus();
}

/* ---------- Comments ---------- */

function thread(targetType, targetId, label) {
  const comments = data.comments.filter((c) => c.targetId === targetId);
  const open = openThreads.has(targetId);
  const wrap = el('div', { class: 'client-thread' + (open ? ' open' : '') });

  const rerender = () => wrap.replaceWith(thread(targetType, targetId, label));
  const toggle = el(
    'button',
    {
      class: 'comment-chip' + (comments.length ? ' has' : ''),
      'aria-expanded': String(open),
      onclick: () => {
        open ? openThreads.delete(targetId) : openThreads.add(targetId);
        rerender();
      },
    },
    comments.length ? `💬 ${plural(comments.length, 'comment')}` : `💬 Comment on ${label}`
  );
  wrap.append(toggle);
  if (!open) return wrap;

  for (const c of comments) {
    wrap.append(
      el(
        'div',
        { class: 'comment' + (c.fromOwner ? ' mine' : '') + (c.resolved ? ' resolved' : '') },
        el(
          'div',
          { class: 'comment-meta' },
          el('strong', {}, c.author),
          c.fromOwner ? el('span', { class: 'tag' }, 'Filmmaker') : null,
          el('span', { class: 'muted' }, timeAgo(c.createdAt)),
          c.resolved ? el('span', { class: 'tag ok' }, 'Resolved') : null
        ),
        el('p', { class: 'comment-body' }, c.body)
      )
    );
  }

  const name = el('input', { class: 'field', placeholder: 'Your name', value: getName(), required: '', maxlength: 80 });
  const body = el('textarea', { class: 'field', rows: 2, placeholder: `Your comment on ${label}…`, required: '' });
  const error = el('p', { class: 'form-error' });
  wrap.append(
    el(
      'form',
      {
        class: 'reply',
        onsubmit: async (e) => {
          e.preventDefault();
          error.textContent = '';
          try {
            setName(name.value.trim());
            const c = await api('comment', {
              params: { s: token },
              body: { targetType, targetId, author: name.value, body: body.value },
            });
            data.comments.push(c);
            rerender();
          } catch (err) {
            if (err.status === 401) return showPassword();
            error.textContent = err.message;
          }
        },
      },
      getName() ? null : name,
      body,
      error,
      el(
        'div',
        { class: 'reply-actions' },
        getName()
          ? el('span', { class: 'muted small' }, `Posting as ${getName()} · `,
              el('button', { type: 'button', class: 'link-btn', onclick: () => { localStorage.removeItem('clientName'); rerender(); } }, 'change'))
          : null,
        el('div', { class: 'spacer' }),
        el('button', { class: 'btn primary', type: 'submit' }, 'Post comment')
      )
    )
  );
  return wrap;
}

/* ---------- Page ---------- */

function lightbox(src, alt) {
  const d = el('dialog', { class: 'lightbox', onclick: () => d.close() }, el('img', { src, alt }));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
}

function shotCard(shot, label) {
  const src = imageUrl(shot, token);
  return el(
    'article',
    { class: 'card client-shot' },
    el(
      'div',
      { class: 'card-head' },
      el('span', { class: 'shot-num' }, label),
      el('span', { class: 'client-shot-title' }, shot.title || 'Untitled shot'),
      shot.type ? el('span', { class: 'tag' }, shot.type) : null
    ),
    src
      ? el('button', { class: 'canvas-thumb view', title: 'View larger', onclick: () => lightbox(src, `Shot ${label}`) }, el('img', { src, alt: `Sketch for shot ${label}`, loading: 'lazy' }))
      : el('div', { class: 'canvas-thumb view empty-thumb' }, el('span', { class: 'muted small' }, 'No sketch')),
    shot.notes ? el('p', { class: 'client-notes' }, shot.notes) : null,
    thread('shot', shot.id, `shot ${label}`)
  );
}

function field(label, value) {
  return value?.trim() ? el('div', { class: 'client-field' }, el('h4', {}, label), el('p', {}, value)) : null;
}

function beatCard(beat) {
  const shots = data.shots.filter((s) => s.beatId === beat.id);
  const prefix = beat.number?.trim() || '';
  return el(
    'section',
    { class: 'client-beat' },
    el(
      'header',
      { class: 'client-beat-head' },
      el('span', { class: 'beat-badge' }, prefix || '•'),
      el('h3', {}, beat.title || 'Untitled beat'),
      el('div', { class: 'spacer' }),
      beat.time ? el('span', { class: 'muted runtime' }, beat.time) : null
    ),
    el(
      'div',
      { class: 'client-fields' },
      field('Description', beat.description),
      field('What it’s about', beat.about),
      field('Must-see', beat.mustSee)
    ),
    shots.length
      ? el(
          'div',
          { class: 'grid shot-grid' },
          shots.map((s, j) => shotCard(s, prefix ? `${prefix}.${j + 1}` : String(j + 1)))
        )
      : null,
    thread('beat', beat.id, `beat ${prefix || beat.title || ''}`.trim())
  );
}

function render() {
  const { project, scenes } = data;
  const head = el(
    'header',
    { class: 'client-head' },
    el('div', {}, el('p', { class: 'eyebrow' }, 'Shared for review'), el('h1', {}, project.name)),
    el('span', { class: 'muted' }, plural(scenes.length, 'scene'))
  );
  if (!scenes.length) {
    root.replaceChildren(head, el('p', { class: 'muted client-empty' }, 'Nothing has been added to this project yet.'));
    return;
  }

  const scene = scenes.find((s) => s.id === localStorage.getItem(sceneKey)) ?? scenes[0];
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
          onclick: () => {
            localStorage.setItem(sceneKey, s.id);
            render();
            window.scrollTo({ top: 0 });
          },
        },
        s.name || 'Untitled scene'
      )
    )
  );

  const runtime = sceneRuntime(scene);
  const anyScript = scenes.some((s) => hasContent(s.script));
  const mode = anyScript && localStorage.getItem(`share:${token}:mode`) === 'script' ? 'script' : 'beats';
  const subtabs = anyScript
    ? el(
        'div',
        { class: 'subtabs', role: 'tablist' },
        [
          ['beats', 'Beats & shots', String(scene.beats.length)],
          ['script', 'Script', lengthLabel(scene.script || [])],
        ].map(([m, label, meta]) =>
          el(
            'button',
            {
              class: 'subtab' + (mode === m ? ' active' : ''),
              role: 'tab',
              'aria-selected': String(mode === m),
              onclick: () => {
                localStorage.setItem(`share:${token}:mode`, m);
                render();
              },
            },
            label,
            meta ? el('span', { class: 'subtab-meta' }, meta) : null
          )
        )
      )
    : null;

  const scriptView = () =>
    hasContent(scene.script)
      ? el(
          'div',
          { class: 'script-editor' },
          el(
            'div',
            { class: 'sp-toolbar' },
            el('div', { class: 'spacer' }),
            el(
              'button',
              { class: 'btn small-btn', onclick: () => printScript(project.name, scenes.flatMap((s) => s.script || [])) },
              'Print / PDF (all scenes)'
            )
          ),
          el('div', { class: 'script-wrap' }, el('div', { class: 'script-sheet' }, renderScript(scene.script)))
        )
      : el('p', { class: 'muted client-empty' }, 'No script for this scene yet.');

  const panel = el(
    'div',
    { class: 'scene-panel client-panel' },
    el(
      'div',
      { class: 'scene-bar' },
      el('h2', { class: 'client-scene-name' }, scene.name),
      el('span', { class: 'muted' }, plural(scene.beats.length, 'beat')),
      runtime ? el('span', { class: 'muted runtime' }, `Runtime ${runtime}`) : null
    ),
    subtabs,
    mode === 'script'
      ? scriptView()
      : scene.beats.length
        ? scene.beats.map(beatCard)
        : el('p', { class: 'muted' }, 'No beats in this scene yet.'),
    el('div', { class: 'scene-comments' }, thread('scene', scene.id, 'this scene'))
  );

  root.replaceChildren(head, el('section', { class: 'scenes' }, tabs, panel));
}

load();
