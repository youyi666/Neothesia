const http = require('http');
const crypto = require('crypto');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { loadScoreLibrary, listMidiFiles } = require('./score-data.cjs');
const { readMidi } = require('./lib/midi-file.js');
const { analyzeSong } = require('./lib/analyze.js');
const store = require('./lib/course-store.js');
const { launchNeothesia } = require('./lib/neothesia-launcher.js');

const PORT   = Number(process.env.PRACTICE_APP_PORT) || 3721;
const PUBLIC = path.join(__dirname, 'public');
const MIDI_ROOT = path.join(__dirname, '..', 'practice_midis');
const IMPORTS_DIR = path.join(__dirname, 'data', 'imports');
const APP_ID = 'neothesia-practice-app';
const BACKEND_BUILD_FILES = [
  __filename,
  path.join(__dirname, 'score-data.cjs'),
  ...fs.readdirSync(path.join(__dirname, 'lib'))
    .filter(name => name.endsWith('.js'))
    .sort()
    .map(name => path.join(__dirname, 'lib', name)),
];
function getBackendBuildId(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(__dirname, file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}
const APP_BUILD_ID = getBackendBuildId(BACKEND_BUILD_FILES);
const APP_STARTED_AT = new Date().toISOString();
const scoreResult = loadScoreLibrary(MIDI_ROOT);
const SCORE_JSON = Buffer.from(JSON.stringify(scoreResult.library), 'utf8');
const DRILL_MANIFEST = store.loadDrillManifest(MIDI_ROOT);
const DRILL_FINGERING_BY_ID = new Map(
  DRILL_MANIFEST.map(drill => [drill.id, drill.fingering]),
);
const seedResults = store.seedDefaultCourses(MIDI_ROOT);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};
const STATIC_CACHE_CONTROL = 'no-store, max-age=0, must-revalidate';

function localIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readRequestBody(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

// Resolves a client-supplied MIDI reference to a safe absolute path.
// Accepts either a path relative to practice_midis/, or an absolute path
// that was itself returned by our own /api/midi/list or /api/midi/upload
// (e.g. a previously uploaded file under practice_app/data/imports).
function resolveMidiPath(input) {
  if (!input) throw new Error('Missing MIDI path');
  if (path.isAbsolute(input)) {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
    return resolved;
  }
  const resolved = path.resolve(MIDI_ROOT, input);
  if (!resolved.startsWith(path.resolve(MIDI_ROOT))) throw new Error('Invalid path');
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  return resolved;
}

function analyzeMidiFile(absolutePath) {
  const midi = readMidi(fs.readFileSync(absolutePath));
  const title = path.basename(absolutePath, path.extname(absolutePath));
  return analyzeSong(midi, { title });
}

async function handleApi(req, res, requestPath, url) {
  // ── existing sheet-music endpoints ──
  if (requestPath === '/api/scores' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(SCORE_JSON);
    return true;
  }
  if (requestPath === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      appId: APP_ID,
      buildId: APP_BUILD_ID,
      startedAt: APP_STARTED_AT,
      port: PORT,
      scores: Object.keys(scoreResult.library).length,
    });
    return true;
  }

  // ── MIDI import / analysis ──
  if (requestPath === '/api/midi/list' && req.method === 'GET') {
    const files = listMidiFiles(MIDI_ROOT).map(f => path.relative(MIDI_ROOT, f).split(path.sep).join('/'));
    sendJson(res, 200, { files });
    return true;
  }
  if (requestPath === '/api/midi/analyze' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const absolutePath = resolveMidiPath(body.path);
    const analysis = analyzeMidiFile(absolutePath);
    sendJson(res, 200, { absolutePath, analysis });
    return true;
  }
  if (requestPath === '/api/midi/upload' && req.method === 'POST') {
    const name = url.searchParams.get('name') || `import_${Date.now()}.mid`;
    const safeName = `${Date.now()}_${path.basename(name).replace(/[^a-zA-Z0-9._\-一-鿿]/g, '_')}`;
    fs.mkdirSync(IMPORTS_DIR, { recursive: true });
    const dest = path.join(IMPORTS_DIR, safeName);
    const bytes = await readRequestBody(req);
    if (bytes.toString('ascii', 0, 4) !== 'MThd') throw new Error('Uploaded file is not a valid MIDI file');
    fs.writeFileSync(dest, bytes);
    const analysis = analyzeMidiFile(dest);
    sendJson(res, 200, { absolutePath: dest, analysis });
    return true;
  }

  // ── courses ──
  if (requestPath === '/api/courses' && req.method === 'GET') {
    const user = url.searchParams.get('user') || null;
    sendJson(res, 200, { courses: store.listCourses(user) });
    return true;
  }
  if (requestPath === '/api/drills' && req.method === 'GET') {
    sendJson(res, 200, { drills: DRILL_MANIFEST });
    return true;
  }
  if (requestPath === '/api/courses' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const sourceMidiAbsPath = resolveMidiPath(body.sourceMidiPath);
    const courseId = body.courseId || slugify(body.title) || `course_${Date.now()}`;
    const course = store.createCourse({
      courseId,
      title: body.title,
      sourceMidiAbsPath,
      difficulty: body.difficulty || 1,
      leftTrackIndex: body.leftTrackIndex,
      rightTrackIndex: body.rightTrackIndex,
    });
    sendJson(res, 200, { course });
    return true;
  }

  const courseMatch = requestPath.match(/^\/api\/courses\/([^/]+)$/);
  if (courseMatch && req.method === 'GET') {
    const user = url.searchParams.get('user') || null;
    const course = store.loadCourse(decodeURIComponent(courseMatch[1]), user);
    // 首页/课程页反馈从"完成了多少关"改成"真会弹多少"（Issue #2），派生数据
    // 不落盘，每次都按当前进度现算。
    sendJson(res, 200, { course, mastery: store.computeMasterySummary(course) });
    return true;
  }

  const lessonsMatch = requestPath.match(/^\/api\/courses\/([^/]+)\/lessons$/);
  if (lessonsMatch && req.method === 'POST') {
    const body = await readJsonBody(req);
    const lesson = store.addManualLesson(decodeURIComponent(lessonsMatch[1]), body);
    sendJson(res, 200, { lesson });
    return true;
  }

  const completeMatch = requestPath.match(/^\/api\/courses\/([^/]+)\/lessons\/([^/]+)\/complete$/);
  if (completeMatch && req.method === 'POST') {
    const body = await readJsonBody(req);
    const lesson = store.setLessonCompleted(decodeURIComponent(completeMatch[1]), decodeURIComponent(completeMatch[2]), body.completed !== false, body.user || null);
    sendJson(res, 200, { lesson });
    return true;
  }

  const practiceMatch = requestPath.match(/^\/api\/courses\/([^/]+)\/lessons\/([^/]+)\/practice$/);
  if (practiceMatch && req.method === 'POST') {
    const exportedPath = store.exportLessonFile(decodeURIComponent(practiceMatch[1]), decodeURIComponent(practiceMatch[2]));
    const { pid } = launchNeothesia(exportedPath);
    sendJson(res, 200, { exportedPath, pid });
    return true;
  }

  const eventsMatch = requestPath.match(/^\/api\/courses\/([^/]+)\/lessons\/([^/]+)\/events$/);
  if (eventsMatch && req.method === 'GET') {
    const courseId = decodeURIComponent(eventsMatch[1]);
    const events = store.getLessonEvents(
      courseId,
      decodeURIComponent(eventsMatch[2]),
      { explicitFingering: DRILL_FINGERING_BY_ID.get(courseId) },
    );
    sendJson(res, 200, { events });
    return true;
  }

  const practiceDataMatch = requestPath.match(/^\/api\/courses\/([^/]+)\/lessons\/([^/]+)\/practice-data$/);
  if (practiceDataMatch && req.method === 'GET') {
    const courseId = decodeURIComponent(practiceDataMatch[1]);
    const data = store.getLessonPracticeData(
      courseId,
      decodeURIComponent(practiceDataMatch[2]),
      { explicitFingering: DRILL_FINGERING_BY_ID.get(courseId) },
    );
    sendJson(res, 200, data);
    return true;
  }

  const measurePracticeDataMatch = requestPath.match(/^\/api\/courses\/([^/]+)\/measures\/(\d+)\/practice-data$/);
  if (measurePracticeDataMatch && req.method === 'GET') {
    const courseId = decodeURIComponent(measurePracticeDataMatch[1]);
    const measureIndex = Number(measurePracticeDataMatch[2]);
    const handMode = url.searchParams.get('hand_mode') || 'both';
    const data = store.getMeasurePracticeData(courseId, measureIndex, handMode, {
      explicitFingering: DRILL_FINGERING_BY_ID.get(courseId),
    });
    sendJson(res, 200, data);
    return true;
  }

  const sessionsMatch = requestPath.match(/^\/api\/courses\/([^/]+)\/lessons\/([^/]+)\/sessions$/);
  if (sessionsMatch && req.method === 'POST') {
    const body = await readJsonBody(req);
    const result = store.recordPracticeResult(
      decodeURIComponent(sessionsMatch[1]),
      decodeURIComponent(sessionsMatch[2]),
      body,
      body.user || null,
    );
    sendJson(res, 200, result);
    return true;
  }

  // ── practice time ──
  if (requestPath === '/api/practice-time' && req.method === 'GET') {
    const user = url.searchParams.get('user');
    const data = readPracticeTime();
    if (user) {
      sendJson(res, 200, { user, totalSeconds: data[user] || 0 });
    } else {
      sendJson(res, 200, { users: data });
    }
    return true;
  }
  if (requestPath === '/api/practice-time' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const { user, seconds } = body;
    if (!user || typeof seconds !== 'number' || seconds <= 0) {
      sendJson(res, 200, { ok: true });
      return true;
    }
    const data = readPracticeTime();
    data[user] = (data[user] || 0) + Math.floor(seconds);
    writePracticeTime(data);
    sendJson(res, 200, { user, totalSeconds: data[user] });
    return true;
  }

  // ── settings ──
  if (requestPath === '/api/settings' && req.method === 'GET') {
    sendJson(res, 200, store.readSettings());
    return true;
  }
  if (requestPath === '/api/settings' && req.method === 'POST') {
    const body = await readJsonBody(req);
    sendJson(res, 200, store.updateSettings(body));
    return true;
  }

  return false;
}

const PRACTICE_TIME_FILE = path.join(__dirname, 'data', 'practice_time.json');
function readPracticeTime() {
  try {
    if (fs.existsSync(PRACTICE_TIME_FILE)) return JSON.parse(fs.readFileSync(PRACTICE_TIME_FILE, 'utf8'));
  } catch {}
  return {};
}
function writePracticeTime(data) {
  fs.mkdirSync(path.dirname(PRACTICE_TIME_FILE), { recursive: true });
  fs.writeFileSync(PRACTICE_TIME_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function slugify(title) {
  if (!title) return '';
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_一-鿿]/g, '')
    .slice(0, 40);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const requestPath = url.pathname;

  if (requestPath.startsWith('/api/')) {
    handleApi(req, res, requestPath, url)
      .then(handled => {
        if (!handled) sendJson(res, 404, { error: 'Not found' });
      })
      .catch(err => {
        sendJson(res, 400, { error: err.message });
      });
    return;
  }

  // Issue #4 后续阶段：夜曲左手手型练习原型（PR #5）从独立静态预览升级为接入
  // 真实课程数据。它需要和主 API 同源才能直接 fetch /api/...，所以从这里的
  // 主服务器直接托管，而不是它自己 package.json 里那个 python http.server
  // （那个仍然保留，纯 UI 预览用假数据时还能单独跑）。
  const NOCTURNE_LEFT_HAND_ROOT = path.join(__dirname, 'nocturne_left_hand', 'public');
  if (requestPath === '/nocturne-left-hand' || requestPath.startsWith('/nocturne-left-hand/')) {
    const rel = requestPath.slice('/nocturne-left-hand'.length).replace(/^\/+/, '') || 'index.html';
    const safeRel = rel.replace(/\.\./g, '');
    const filePath = path.join(NOCTURNE_LEFT_HAND_ROOT, safeRel);
    const ext = path.extname(filePath);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'text/plain',
        'Cache-Control': STATIC_CACHE_CONTROL,
      });
      res.end(data);
    });
    return;
  }

  if (requestPath === '/lib/scoring.js') {
    fs.readFile(path.join(__dirname, 'lib', 'scoring.js'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  const safePath = requestPath.replace(/\.\./g, '');
  const filePath = path.join(PUBLIC, safePath === '/' ? 'index.html' : safePath);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': STATIC_CACHE_CONTROL,
        });
        res.end(d2);
      });
    } else {
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'text/plain',
        'Cache-Control': STATIC_CACHE_CONTROL,
      });
      res.end(data);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = localIP();
  console.log('\n🎹  练琴 App 已启动\n');
  console.log(`  五线谱: 已读取 ${Object.keys(scoreResult.library).length} 个 MIDI 文件`);
  for (const error of scoreResult.errors) console.warn(`  MIDI 读取失败: ${error}`);
  const created = seedResults.filter(r => r.status === 'created').length;
  const existing = seedResults.filter(r => r.status === 'exists').length;
  console.log(`  课程: ${created} 个新生成，${existing} 个已存在`);
  for (const r of seedResults) {
    if (r.status === 'error') console.warn(`  课程生成失败 ${r.id}: ${r.error}`);
    if (r.status === 'missing_source') console.warn(`  课程源文件缺失 ${r.id}: ${r.path}`);
  }
  console.log(`  课程系统: http://localhost:${PORT}/#courses`);
  console.log(`  本机: http://localhost:${PORT}`);
  console.log(`  手机: http://${ip}:${PORT}  (需与电脑在同一 WiFi)\n`);
  console.log('  停止后台服务: 双击 停止练琴App.bat\n');
});
