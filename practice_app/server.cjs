const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT   = 3721;
const PUBLIC = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function localIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

const server = http.createServer((req, res) => {
  const safePath = req.url.split('?')[0].replace(/\.\./g, '');
  const filePath = path.join(PUBLIC, safePath === '/' ? 'index.html' : safePath);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
    } else {
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      res.end(data);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = localIP();
  console.log('\n🎹  练琴 App 已启动\n');
  console.log(`  本机: http://localhost:${PORT}`);
  console.log(`  手机: http://${ip}:${PORT}  (需与电脑在同一 WiFi)\n`);
  console.log('  关闭此窗口即停止服务\n');
});
