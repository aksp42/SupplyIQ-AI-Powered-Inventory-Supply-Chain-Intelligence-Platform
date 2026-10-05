// SupplyIQ — minimal static file server (no npm install needed)
// Usage: node serve.js  →  serves frontend/ on http://localhost:3000
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 3000;
const ROOT = __dirname; // frontend/

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
};

http.createServer((req, res) => {
  // Decode URL, strip query string
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  // Default document
  if (urlPath === '/' || urlPath === '') urlPath = '/public/landing.html';

  let filePath = path.join(ROOT, urlPath);

  // Security: stay inside ROOT
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  // If directory requested, try index.html inside it
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('🌐 SupplyIQ Frontend  →  http://localhost:' + PORT);
  console.log('   Landing : http://localhost:' + PORT + '/public/landing.html');
  console.log('   Login   : http://localhost:' + PORT + '/public/login.html');
  console.log('   Dashboard: http://localhost:' + PORT + '/SupplyIQ-Grocery-Dashboard.html');
});
