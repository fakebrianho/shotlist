// Database access. On Vercel: Neon Postgres via DATABASE_URL.
// Locally (no DATABASE_URL): an embedded Postgres (PGlite) saved in .data/
let ready;

const SCHEMA = `
create table if not exists projects (
  id text primary key,
  data jsonb not null,
  created_at bigint not null
);
create table if not exists scenes (
  id text primary key,
  project_id text not null,
  data jsonb not null
);
create index if not exists scenes_project on scenes (project_id);
create table if not exists shots (
  id text primary key,
  project_id text not null,
  data jsonb not null
);
create index if not exists shots_project on shots (project_id);
create table if not exists images (
  shot_id text primary key,
  project_id text not null,
  png text not null
);
create table if not exists shares (
  token text primary key,
  project_id text not null,
  label text not null default '',
  password_hash text not null,
  created_at bigint not null,
  expires_at bigint,
  revoked boolean not null default false
);
create index if not exists shares_project on shares (project_id);
create table if not exists comments (
  id text primary key,
  project_id text not null,
  target_type text not null,
  target_id text not null,
  author text not null,
  body text not null,
  from_owner boolean not null default false,
  resolved boolean not null default false,
  created_at bigint not null
);
create index if not exists comments_project on comments (project_id);
create table if not exists login_attempts (
  key text primary key,
  failures int not null,
  window_start bigint not null
);
`;

export const isLocal = () => !process.env.DATABASE_URL;

async function connect() {
  if (!isLocal()) {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(process.env.DATABASE_URL);
    const q = (text, params = []) => sql.query(text, params);
    for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await q(stmt);
    return q;
  }
  // Module name in a variable so Vercel doesn't bundle the local-only database
  const mod = '@electric-sql/pglite';
  const { PGlite } = await import(mod);
  const { mkdirSync } = await import('node:fs');
  mkdirSync('./.data', { recursive: true });
  const pg = new PGlite('./.data/pglite');
  await pg.exec(SCHEMA);
  return async (text, params = []) => (await pg.query(text, params)).rows;
}

/** Run a parameterised query and get the rows back. */
export async function query(text, params) {
  ready ??= connect().catch((e) => {
    ready = null;
    throw e;
  });
  const q = await ready;
  // Send objects as JSON text so both drivers store jsonb the same way
  const values = (params || []).map((v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v
  );
  return q(text, values);
}
