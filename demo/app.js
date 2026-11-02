// A perfectly ordinary app, except /break makes its health endpoint fail
// while the process stays alive - which is exactly what PM2 cannot see.
const http = require('http');
const PORT = parseInt(process.env.PORT || '3000', 10);
let healthy = true;

http.createServer((req, res) => {
  if (req.url === '/break') { healthy = false; res.writeHead(200); return res.end('broken\n'); }
  if (req.url === '/health') {
    res.writeHead(healthy ? 200 : 503);
    return res.end(JSON.stringify({ ok: healthy, pid: process.pid }));
  }
  res.writeHead(200); res.end('hello\n');
}).listen(PORT, '127.0.0.1');
