// The whole API: one function, routed by ?op=…
import { query } from './db.js';
import * as auth from './auth.js';

const MAX_IMAGE_CHARS = 4_000_000; // Vercel caps request bodies at 4.5 MB
const PNG_PREFIX = 'data:image/png;base64,';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

const id = (v, what = 'id') => {
  if (typeof v !== 'string' || !v || v.length > 64) throw new HttpError(400, `Bad ${what}`);
  return v;
};

const text = (v, max, what) => {
  if (typeof v !== 'string') throw new HttpError(400, `Missing ${what}`);
  const t = v.trim();
  if (!t) throw new HttpError(400, `Missing ${what}`);
  if (t.length > max) throw new HttpError(400, `${what} is too long`);
  return t;
};

const requireOwner = (request) => {
  if (!auth.isOwner(request)) throw new HttpError(401, 'Please log in');
};

const toComment = (c) => ({
  id: c.id,
  targetType: c.target_type,
  targetId: c.target_id,
  author: c.author,
  body: c.body,
  fromOwner: c.from_owner,
  resolved: c.resolved,
  createdAt: Number(c.created_at),
});

async function projectContent(projectId) {
  const [scenes, shots, comments] = await Promise.all([
    query('select data from scenes where project_id = $1', [projectId]),
    query('select data from shots where project_id = $1', [projectId]),
    query('select * from comments where project_id = $1 order by created_at', [projectId]),
  ]);
  return {
    scenes: scenes.map((r) => r.data).sort((a, b) => a.order - b.order),
    shots: shots.map((r) => r.data).sort((a, b) => a.order - b.order),
    comments: comments.map(toComment),
  };
}

async function targetExists(projectId, type, targetId) {
  if (type === 'shot') {
    return (await query('select 1 from shots where id = $1 and project_id = $2', [targetId, projectId])).length > 0;
  }
  const scenes = await query('select data from scenes where project_id = $1', [projectId]);
  if (type === 'scene') return scenes.some((r) => r.data.id === targetId);
  if (type === 'beat') return scenes.some((r) => (r.data.beats || []).some((b) => b.id === targetId));
  return false;
}

const ops = {
  /* ---------- Owner session ---------- */

  async me({ request }) {
    return json({ owner: auth.isOwner(request) });
  },

  async login({ request, body }) {
    await auth.checkLockout('owner');
    if (!auth.sameString(body.password ?? '', auth.ownerPassword())) {
      await auth.recordFailure('owner');
      throw new HttpError(401, 'Wrong password');
    }
    await auth.clearFailures('owner');
    return json({ ok: true }, 200, { 'set-cookie': auth.ownerCookie(request) });
  },

  async logout({ request }) {
    return json({ ok: true }, 200, { 'set-cookie': auth.clearOwnerCookie(request) });
  },

  /* ---------- Owner data ---------- */

  async projects({ request }) {
    requireOwner(request);
    const rows = await query('select data from projects order by created_at');
    return json(rows.map((r) => r.data));
  },

  async 'project-data'({ request, params }) {
    requireOwner(request);
    return json(await projectContent(id(params.get('project'), 'project')));
  },

  async 'put-project'({ request, body }) {
    requireOwner(request);
    const p = { id: id(body.id), name: String(body.name ?? 'Untitled').slice(0, 200), createdAt: Number(body.createdAt) || Date.now() };
    await query(
      'insert into projects (id, data, created_at) values ($1, $2, $3) on conflict (id) do update set data = $2',
      [p.id, p, p.createdAt]
    );
    return json(p);
  },

  async 'delete-project'({ request, body }) {
    requireOwner(request);
    const pid = id(body.id);
    for (const table of ['scenes', 'shots', 'images', 'shares', 'comments']) {
      await query(`delete from ${table} where project_id = $1`, [pid]);
    }
    await query('delete from projects where id = $1', [pid]);
    return json({ ok: true });
  },

  async 'put-scene'({ request, body }) {
    requireOwner(request);
    const scene = { ...body, id: id(body.id), projectId: id(body.projectId, 'project') };
    if (!Array.isArray(scene.beats)) scene.beats = [];
    await query(
      'insert into scenes (id, project_id, data) values ($1, $2, $3) on conflict (id) do update set data = $3, project_id = $2',
      [scene.id, scene.projectId, scene]
    );
    return json(scene);
  },

  async 'delete-scene'({ request, body }) {
    requireOwner(request);
    const sid = id(body.id);
    const [row] = await query('select data from scenes where id = $1', [sid]);
    const targets = [sid, ...((row?.data.beats || []).map((b) => b.id))];
    await query('delete from comments where target_id = any($1)', [targets]);
    await query('delete from scenes where id = $1', [sid]);
    return json({ ok: true });
  },

  async 'put-shot'({ request, body }) {
    requireOwner(request);
    const { image, ...shot } = body;
    id(shot.id);
    id(shot.projectId, 'project');
    if (typeof image === 'string') {
      if (!image.startsWith(PNG_PREFIX) || image.length > MAX_IMAGE_CHARS) throw new HttpError(400, 'Bad image');
      await query(
        'insert into images (shot_id, project_id, png) values ($1, $2, $3) on conflict (shot_id) do update set png = $3',
        [shot.id, shot.projectId, image.slice(PNG_PREFIX.length)]
      );
      shot.imageV = Date.now();
    }
    await query(
      'insert into shots (id, project_id, data) values ($1, $2, $3) on conflict (id) do update set data = $3, project_id = $2',
      [shot.id, shot.projectId, shot]
    );
    return json(shot);
  },

  async 'delete-shots'({ request, body }) {
    requireOwner(request);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => id(x));
    if (ids.length) {
      await query('delete from shots where id = any($1)', [ids]);
      await query('delete from images where shot_id = any($1)', [ids]);
      await query('delete from comments where target_id = any($1)', [ids]);
    }
    return json({ ok: true });
  },

  /* ---------- Images (owner, or a client with a live share session) ---------- */

  async image({ request, params }) {
    const shotId = id(params.get('id'));
    const [img] = await query('select project_id, png from images where shot_id = $1', [shotId]);
    if (!img) throw new HttpError(404, 'No image');
    if (!auth.isOwner(request)) {
      const share = await auth.shareSession(request, params.get('s'));
      if (!share || share.project_id !== img.project_id) throw new HttpError(401, 'Not allowed');
    }
    return new Response(Buffer.from(img.png, 'base64'), {
      headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=31536000, immutable' },
    });
  },

  /* ---------- Share links (owner) ---------- */

  async shares({ request, params }) {
    requireOwner(request);
    const rows = await query(
      'select token, label, created_at, expires_at, revoked from shares where project_id = $1 order by created_at desc',
      [id(params.get('project'), 'project')]
    );
    return json(
      rows.map((r) => ({
        token: r.token,
        label: r.label,
        createdAt: Number(r.created_at),
        expiresAt: r.expires_at ? Number(r.expires_at) : null,
        revoked: r.revoked,
      }))
    );
  },

  async 'create-share'({ request, body }) {
    requireOwner(request);
    const projectId = id(body.projectId, 'project');
    const password = String(body.password ?? '');
    if (password.length < 4) throw new HttpError(400, 'Password must be at least 4 characters');
    const days = Number(body.expiresInDays) || 0;
    const share = {
      token: auth.newToken(),
      label: String(body.label ?? '').slice(0, 100),
      createdAt: Date.now(),
      expiresAt: days > 0 ? Date.now() + days * 86400000 : null,
    };
    await query(
      'insert into shares (token, project_id, label, password_hash, created_at, expires_at) values ($1, $2, $3, $4, $5, $6)',
      [share.token, projectId, share.label, auth.hashPassword(password), share.createdAt, share.expiresAt]
    );
    return json(share);
  },

  async 'revoke-share'({ request, body }) {
    requireOwner(request);
    await query('update shares set revoked = true where token = $1', [id(body.token, 'token')]);
    return json({ ok: true });
  },

  /* ---------- Client share page ---------- */

  async 'share-login'({ request, body }) {
    const token = id(body.token, 'link');
    await auth.checkLockout(`share:${token}`);
    const share = await auth.getLiveShare(token);
    if (!share) throw new HttpError(404, 'This link is no longer active');
    if (!auth.checkPassword(body.password ?? '', share.password_hash)) {
      await auth.recordFailure(`share:${token}`);
      throw new HttpError(401, 'Wrong password');
    }
    await auth.clearFailures(`share:${token}`);
    return json({ ok: true }, 200, { 'set-cookie': auth.shareSessionCookie(request, share) });
  },

  async 'share-data'({ request, params }) {
    const token = id(params.get('s'), 'link');
    if (!(await auth.getLiveShare(token))) throw new HttpError(404, 'This link is no longer active');
    const share = await auth.shareSession(request, token);
    if (!share) throw new HttpError(401, 'Password required');
    const [project] = await query('select data from projects where id = $1', [share.project_id]);
    if (!project) throw new HttpError(404, 'This project no longer exists');
    return json({ project: { name: project.data.name }, ...(await projectContent(share.project_id)) });
  },

  /* ---------- Comments ---------- */

  async comment({ request, params, body }) {
    let projectId;
    const fromOwner = auth.isOwner(request) && !params.get('s');
    if (fromOwner) {
      projectId = id(body.projectId, 'project');
    } else {
      const share = await auth.shareSession(request, params.get('s'));
      if (!share) throw new HttpError(401, 'Password required');
      projectId = share.project_id;
    }
    const targetType = body.targetType;
    if (!['scene', 'beat', 'shot'].includes(targetType)) throw new HttpError(400, 'Bad comment target');
    const targetId = id(body.targetId, 'target');
    if (!(await targetExists(projectId, targetType, targetId))) throw new HttpError(404, 'That item no longer exists');
    const c = {
      id: auth.newToken(),
      project_id: projectId,
      target_type: targetType,
      target_id: targetId,
      author: text(body.author ?? (fromOwner ? 'Owner' : ''), 80, 'name'),
      body: text(body.body, 4000, 'comment'),
      from_owner: fromOwner,
      resolved: false,
      created_at: Date.now(),
    };
    await query(
      `insert into comments (id, project_id, target_type, target_id, author, body, from_owner, resolved, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [c.id, c.project_id, c.target_type, c.target_id, c.author, c.body, c.from_owner, c.resolved, c.created_at]
    );
    return json(toComment(c));
  },

  async 'resolve-comment'({ request, body }) {
    requireOwner(request);
    await query('update comments set resolved = $2 where id = $1', [id(body.id), !!body.resolved]);
    return json({ ok: true });
  },

  async 'delete-comment'({ request, body }) {
    requireOwner(request);
    await query('delete from comments where id = $1', [id(body.id)]);
    return json({ ok: true });
  },
};

const READS = new Set(['me', 'projects', 'project-data', 'image', 'shares', 'share-data']);

export async function handle(request) {
  try {
    const url = new URL(request.url);
    const op = url.searchParams.get('op');
    const fn = Object.hasOwn(ops, op) ? ops[op] : null;
    if (!fn) throw new HttpError(404, 'Unknown API call');
    const isRead = READS.has(op);
    if (isRead !== (request.method === 'GET')) throw new HttpError(405, 'Wrong method');
    let body = {};
    if (!isRead) {
      // Block cross-site form posts: our own pages always send JSON.
      if (!(request.headers.get('content-type') || '').includes('application/json')) {
        throw new HttpError(415, 'Expected JSON');
      }
      body = (await request.json()) ?? {};
    }
    return await fn({ request, params: url.searchParams, body });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    return json({ error: status === 500 ? 'Server error' : err.message }, status);
  }
}
