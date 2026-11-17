// Calls to the server API (api/index.js). GET when there's no body, POST otherwise.
let writes = 0;
const listeners = new Set();
const notify = (state) => listeners.forEach((fn) => fn(state));

/** Subscribe to save status: 'saving' | 'saved' | 'error'. */
export const onSaveStatus = (fn) => listeners.add(fn);

export async function api(op, { params, body } = {}) {
  const qs = new URLSearchParams({ op, ...params });
  const isWrite = body !== undefined;
  if (isWrite) notify(++writes && 'saving');
  try {
    const res = await fetch(`/api?${qs}`, isWrite
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    if (isWrite && --writes === 0) notify('saved');
    return data;
  } catch (err) {
    if (isWrite) {
      writes--;
      notify('error');
    }
    throw err;
  }
}

export const imageUrl = (shot, shareToken) =>
  shot.imageV
    ? `/api?${new URLSearchParams({ op: 'image', id: shot.id, v: shot.imageV, ...(shareToken ? { s: shareToken } : {}) })}`
    : null;
