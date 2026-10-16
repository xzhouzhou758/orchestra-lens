// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dev-only static server for the standalone preview (mock data, no Luker).
//   node preview/serve.mjs [--port 4174]
// Binds to 127.0.0.1 only; serves files from the extension directory.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(arg('--port', process.env.PORT || 4174));

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        const rel = decodeURIComponent(url.pathname === '/' ? '/preview/index.html' : url.pathname);
        const file = path.resolve(root, `.${rel}`);
        if (!file.startsWith(root + path.sep)) {
            res.writeHead(403).end('forbidden');
            return;
        }
        const body = await fs.readFile(file);
        res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(body);
    } catch {
        res.writeHead(404).end('not found');
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Orchestra Lens preview: http://127.0.0.1:${port}/preview/index.html`);
});
