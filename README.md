# Shot List

Plan a shoot as **scenes → beats → shots**, sketch each shot, and share projects with clients
through a password-protected link where they can view everything and leave comments.

Runs on Vercel (free Hobby plan) with a free Neon Postgres database.

## Deploy to Vercel

1. **Put the code on GitHub.** Make this folder its own repo and push it:
   ```bash
   git init && git add . && git commit -m "Shot List" 
   ```
   Then create an empty GitHub repo and push to it.
2. **Import it in Vercel:** vercel.com → Add New → Project → pick the repo. Vercel detects Vite; keep the defaults.
3. **Add a database:** in the project, open **Storage → Create Database → Neon (Postgres)** and connect it.
   This adds `DATABASE_URL` for you. Tables are created automatically on first use.
4. **Set two environment variables** (Settings → Environment Variables):
   - `OWNER_PASSWORD` — the password you'll log in with. Make it strong.
   - `SESSION_SECRET` — a long random string. Generate one with:
     `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the variables take effect, then open your URL and log in.

### Bring over your old projects

Projects made with the old offline version live only in the browser you used, at `localhost:5173`.

- Run the new version locally (`npm run dev`, at the **same** `localhost:5173` address), log in, and click
  **Upload old local projects** in the sidebar. That copies them into the local dev database —
  then **Export backup** there, and **Import backup** on your Vercel site.
- Or, if you still have a backup `.json` from the old version, just **Import backup** on the Vercel site.

## Run it locally

```bash
npm install
npm run dev
```

Open the URL it prints (usually http://localhost:5173) and log in with `admin`.
Locally, data is kept in `.data/` (an embedded Postgres) — nothing is sent anywhere.
To use a different password locally, copy `.env.example` to `.env.local` and set `OWNER_PASSWORD`.

## Using it

- **+ New project** creates a project. Click its name at the top to rename it.
- Each **scene** is a tab with a beat sheet: beat #, title, description, what it's about, must-see, time.
  Times like `45`, `1:30` or `1:02:30` add up to the scene runtime.
- Open a beat's **Shot list** to add shots. Click a canvas to sketch
  (`P` pen, `E` eraser, `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+S` save, `Esc` close). Shots are numbered after their beat (3.1, 3.2…).
- Everything saves automatically as you type ("Saved" appears bottom-right).

### Sharing with clients

- **Share** → give the link a name and a password, optionally an expiry → **Create link**.
  Send the client the link and password.
- Clients see a read-only view of the project (scenes, beats, shot sketches, notes) and can comment on any scene,
  beat or shot. They can't edit anything or see your other projects.
- **Comments** (top bar) shows everything clients have said. Reply, resolve or delete there.
  💬 chips on scenes, beats and shots jump to their comments.
- **Turn off** a link in the Share dialog to cut access immediately. 10 wrong passwords lock a link for 15 minutes.

## Your data

Data lives in your Neon database. **Export backup** downloads everything (including sketches) as `.json`;
**Import backup** restores one (backups from the old offline version work too).

## How it's built

- `src/` — the app (`main.js`) and the client page (`share.js`), plain JS + Vite.
- `api/index.js` — one Vercel Function; all logic is in `server/handler.js`.
- `server/auth.js` — owner login, share-link passwords (scrypt), signed HttpOnly cookies.
- `server/db.js` — Neon on Vercel, embedded PGlite locally.
