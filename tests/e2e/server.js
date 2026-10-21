/**
 * Servidor estático mínimo para las pruebas de interfaz: sirve la raíz del repositorio.
 * Las peticiones a otros dominios (CDN) se bloquean en las pruebas, así que no se usa red.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

/** @returns {Promise<{ url: string, close: () => Promise<void> }>} */
const startServer = (root = path.join(__dirname, '..', '..')) => new Promise((resolve) => {
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
        const file = path.join(root, rel);
        if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
        fs.readFile(file, (err, data) => {
            if (err) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
            res.end(data);
        });
    });
    server.listen(0, '127.0.0.1', () => {
        const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
        resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
});

module.exports = { startServer };
