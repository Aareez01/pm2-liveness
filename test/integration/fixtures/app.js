// Fixture app: two instances on distinct ports, health breakable on demand.
const http = require('http');
const PORT = parseInt(process.env.PORT || '3100', 10);
let broken = false, hang = false;

http.createServer((req, res) => {
  if (req.url === '/break') { broken = true;  res.writeHead(200); return res.end('broken\n'); }
  if (req.url === '/fix')   { broken = false; res.writeHead(200); return res.end('fixed\n'); }
  if (req.url === '/hang')  { hang = true;    res.writeHead(200); return res.end('hanging\n'); }
  if (req.url === '/health') {
    if (hang) return;                       // exercises timeout-as-failure
    if (broken) { res.writeHead(503); return res.end(JSON.stringify({ ok: false, pid: process.pid })); }
    res.writeHead(200); return res.end(JSON.stringify({ ok: true, pid: process.pid, port: PORT }));
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[fixture] pm_id=${process.env.pm_id} port=${PORT} pid=${process.pid}`);
});
