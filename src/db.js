// Data access for the owner app. Everything is stored on the server (see server/handler.js).
import { api, imageUrl } from './api.js';

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- Session ---------- */

export const me = () => api('me');
export const login = (password) => api('login', { body: { password } });
export const logout = () => api('logout', { body: {} });

/* ---------- Projects, scenes, shots ---------- */

export const getProjects = () => api('projects');
export const putProject = (p) => api('put-project', { body: p });
export const deleteProject = (id) => api('delete-project', { body: { id } });

/** { scenes, shots, comments } for one project */
export const getProjectData = (projectId) => api('project-data', { params: { project: projectId } });

export const putScene = (scene) => api('put-scene', { body: scene });
export const deleteScene = (id) => api('delete-scene', { body: { id } });

/** Pass `image` (a PNG data URL) only when the drawing changed. Returns the saved shot. */
export const putShot = (shot) => api('put-shot', { body: shot });
export const deleteShots = (ids) => api('delete-shots', { body: { ids } });

/* ---------- Share links & comments ---------- */

export const getShares = (projectId) => api('shares', { params: { project: projectId } });
export const createShare = (opts) => api('create-share', { body: opts });
export const revokeShare = (token) => api('revoke-share', { body: { token } });

export const addComment = (c) => api('comment', { body: c });
export const resolveComment = (id, resolved) => api('resolve-comment', { body: { id, resolved } });
export const deleteComment = (id) => api('delete-comment', { body: { id } });

/* ---------- Backup ---------- */

async function toDataUrl(url) {
  const blob = await (await fetch(url)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function exportAll() {
  const projects = await getProjects();
  const scenes = [];
  const shots = [];
  for (const p of projects) {
    const data = await getProjectData(p.id);
    scenes.push(...data.scenes);
    for (const s of data.shots) {
      const { imageV, ...rest } = s;
      shots.push({ ...rest, image: imageV ? await toDataUrl(imageUrl(s)) : null });
    }
  }
  return { app: 'shot-list', version: 3, exportedAt: new Date().toISOString(), projects, scenes, shots };
}

/** Upload a backup (any version). Shots carry their drawing as a data URL. */
export async function importAll(data, onProgress = () => {}) {
  if (!data || !Array.isArray(data.projects) || !Array.isArray(data.shots)) {
    throw new Error('Not a valid Shot List backup file.');
  }
  const scenes = Array.isArray(data.scenes) ? data.scenes : [];
  const total = data.projects.length + scenes.length + data.shots.length;
  let done = 0;
  const step = () => onProgress(++done, total);
  for (const p of data.projects) await putProject(p).then(step);
  for (const s of scenes) await putScene(s).then(step);
  for (const s of data.shots) {
    const { image, imageV, ...shot } = s;
    await putShot(typeof image === 'string' && image.startsWith('data:image/png') ? { ...shot, image } : shot).then(step);
  }
}

/**
 * Data saved by the old offline version of this app, in this browser's IndexedDB.
 * Only visible at the same address it was used at (e.g. localhost:5173).
 */
export function readLegacyLocal() {
  return new Promise((resolve) => {
    if (!window.indexedDB) return resolve(null);
    let created = false;
    const req = indexedDB.open('shot-list');
    req.onupgradeneeded = () => (created = true);
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const idb = req.result;
      if (created || !idb.objectStoreNames.contains('projects')) {
        idb.close();
        if (created) indexedDB.deleteDatabase('shot-list');
        return resolve(null);
      }
      const names = ['projects', 'shots', 'scenes'].filter((n) => idb.objectStoreNames.contains(n));
      const tx = idb.transaction(names, 'readonly');
      const out = { projects: [], shots: [], scenes: [] };
      for (const n of names) tx.objectStore(n).getAll().onsuccess = (e) => (out[n] = e.target.result);
      tx.oncomplete = () => {
        idb.close();
        resolve(out.projects.length ? out : null);
      };
      tx.onerror = () => resolve(null);
    };
  });
}
