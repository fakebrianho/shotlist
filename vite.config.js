import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';

// In `npm run dev`, serve the API (api/index.js) and the /share/:token page
// the same way Vercel does, so everything works locally.
function localApi() {
  return {
    name: 'local-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url.startsWith('/share/')) {
          req.url = '/share.html';
          return next();
        }
        if (!req.url.startsWith('/api')) return next();
        try {
          const { handle } = await server.ssrLoadModule('/server/handler.js');
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const request = new Request(`http://${req.headers.host}${req.url}`, {
            method: req.method,
            headers: req.headers,
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
          });
          const response = await handle(request);
          res.statusCode = response.status;
          response.headers.forEach((v, k) => k !== 'set-cookie' && res.setHeader(k, v));
          const cookies = response.headers.getSetCookie();
          if (cookies.length) res.setHeader('set-cookie', cookies);
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (err) {
          next(err);
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return {
    plugins: [localApi()],
    build: {
      rollupOptions: {
        input: { main: resolve('index.html'), share: resolve('share.html') },
      },
    },
  };
});
