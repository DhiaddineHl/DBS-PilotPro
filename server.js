/* ════════════════════════════════════════════════════════════════
   PilotPro — Serveur v2 (zéro dépendance, Node.js natif)
   • Sert l'application PilotPro
   • Enregistre l'état partagé (base centrale) avec HORODATAGE
   • Sauvegardes horaires automatiques dans data/backups (≈10 jours)
   • Volume persistant : définir la variable DATA_DIR (ex: /data)
   ════════════════════════════════════════════════════════════════ */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT    = process.env.PORT || process.argv[2] || 3000;
const BASE    = process.pkg ? path.dirname(process.execPath) : __dirname;
const PUBLIC  = path.join(BASE, 'public');
const DATADIR = process.env.DATA_DIR || path.join(BASE, 'data');
const STATE   = path.join(DATADIR, 'state.json');
const BKDIR   = path.join(DATADIR, 'backups');
const BK_MAX  = 240; // ≈ 10 jours de sauvegardes horaires

if (!fs.existsSync(DATADIR)) fs.mkdirSync(DATADIR, { recursive: true });
if (!fs.existsSync(BKDIR))   fs.mkdirSync(BKDIR,   { recursive: true });

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (e) { return { keys: {}, rev: 0, ts: 0, updatedAt: null }; }
}
function saveState(s) {
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STATE);
}
function hourStamp(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + 'h';
}
/* Sauvegardes automatiques : horaires (≈10 j) + QUOTIDIENNES (60 j) */
function prune(rx, max) {
  const files = fs.readdirSync(BKDIR).filter(x => rx.test(x)).sort();
  while (files.length > max) { fs.unlinkSync(path.join(BKDIR, files.shift())); }
}
function hourlyBackup(prevState) {
  try {
    if (!prevState || !prevState.keys || !Object.keys(prevState.keys).length) return;
    const now = new Date();
    const p = n => String(n).padStart(2, '0');
    const hf = path.join(BKDIR, 'state-' + hourStamp(now) + '.json');
    if (!fs.existsSync(hf)) fs.writeFileSync(hf, JSON.stringify(prevState));
    const df = path.join(BKDIR, 'state-daily-' + now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()) + '.json');
    if (!fs.existsSync(df)) fs.writeFileSync(df, JSON.stringify(prevState));
    prune(/^state-\d{4}-.*\.json$/, BK_MAX);     // horaires
    prune(/^state-daily-.*\.json$/, 60);          // quotidiennes
  } catch (e) { console.warn('backup:', e.message); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(file);
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    /* HTML jamais mis en cache : les téléphones reçoivent toujours la dernière version */
    h['Cache-Control'] = (ext === '.html') ? 'no-store, must-revalidate' : 'public, max-age=300';
    res.writeHead(200, h);
    res.end(buf);
  });
}
function readBody(req, cb) {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 60 * 1024 * 1024) req.destroy(); });
  req.on('end', () => cb(data));
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (url === '/api/state' && req.method === 'GET') { json(res, 200, loadState()); return; }

  if (url === '/api/state' && req.method === 'POST') {
    readBody(req, body => {
      try {
        const incoming = JSON.parse(body || '{}');
        const cur = loadState();
        /* Garde anti-écrasement : si le client annonce sa révision de base (baseRev)
           et qu'elle ne correspond plus à celle du serveur alors que le serveur a des
           données, un autre poste a enregistré entre-temps → refus (le client affichera
           le conflit). L'envoi forcé (sans baseRev) reste possible depuis le dialogue. */
        if (typeof incoming.baseRev === 'number' && cur.keys && Object.keys(cur.keys).length > 0 && incoming.baseRev !== (cur.rev || 0)) {
          json(res, 409, { ok: false, conflict: true, rev: cur.rev || 0, updatedAt: cur.updatedAt });
          return;
        }
        hourlyBackup(cur);
        const next = {
          keys: incoming.keys || {},
          rev: (cur.rev || 0) + 1,
          ts: +incoming.ts || Date.now(),
          updatedAt: new Date().toISOString()
        };
        saveState(next);
        json(res, 200, { ok: true, rev: next.rev, ts: next.ts });
      } catch (e) { json(res, 400, { ok: false, error: String(e) }); }
    });
    return;
  }

  /* Liste des sauvegardes horaires */
  if (url === '/api/backups' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(BKDIR).filter(x => /^state-.*\.json$/.test(x)).sort().reverse()
        .map(n => { const st = fs.statSync(path.join(BKDIR, n)); return { name: n, size: st.size, mtime: st.mtime.toISOString() }; });
      json(res, 200, { ok: true, backups: files });
    } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
    return;
  }

  /* Télécharger une sauvegarde */
  if (url.startsWith('/api/backups/') && req.method === 'GET') {
    const name = url.slice('/api/backups/'.length);
    if (!/^state-[\w\-\.]+\.json$/.test(name)) { json(res, 400, { ok: false, error: 'nom invalide' }); return; }
    const f = path.join(BKDIR, name);
    if (!fs.existsSync(f)) { json(res, 404, { ok: false, error: 'introuvable' }); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="' + name + '"' });
    fs.createReadStream(f).pipe(res);
    return;
  }

  /* Restaurer une sauvegarde comme état courant */
  if (url === '/api/restore' && req.method === 'POST') {
    readBody(req, body => {
      try {
        const { name } = JSON.parse(body || '{}');
        if (!/^state-[\w\-\.]+\.json$/.test(String(name))) { json(res, 400, { ok: false, error: 'nom invalide' }); return; }
        const f = path.join(BKDIR, name);
        const bk = JSON.parse(fs.readFileSync(f, 'utf8'));
        const cur = loadState();
        hourlyBackup(cur);
        const next = { keys: bk.keys || {}, rev: (cur.rev || 0) + 1, ts: Date.now(), updatedAt: new Date().toISOString(), restoredFrom: name };
        saveState(next);
        json(res, 200, { ok: true, rev: next.rev });
      } catch (e) { json(res, 400, { ok: false, error: String(e) }); }
    });
    return;
  }

  if (url === '/api/health') { const s = loadState(); json(res, 200, { ok: true, rev: s.rev, ts: s.ts, dataDir: DATADIR }); return; }

  let file = url === '/' ? path.join(PUBLIC, 'PilotPro.html') : path.join(PUBLIC, url);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(res, file);
});

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(n => ifs[n].forEach(a => { if (a.family === 'IPv4' && !a.internal) out.push(a.address); }));
  return out;
}

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   PilotPro — Serveur v2 DBS Fashion démarré   ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  Sur ce PC :        http://localhost:' + PORT);
  lanIPs().forEach(ip => console.log('  Sur le réseau :    http://' + ip + ':' + PORT));
  console.log('');
  console.log('  Données :          ' + STATE);
  console.log('  Sauvegardes :      ' + BKDIR + '  (horaires, ' + BK_MAX + ' max)');
  console.log('  Volume persistant: définissez DATA_DIR (ex: /data) + volume Railway');
  console.log('');
});
