/* ════════════════════════════════════════════════════════════════
   PilotPro — Serveur (zéro dépendance, Node.js natif)
   • Sert l'application PilotPro
   • Enregistre l'état partagé de tous les utilisateurs (base centrale)
   Lancement :  node server.js   (ou double-clic sur PilotPro-Serveur.exe)
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

if (!fs.existsSync(DATADIR)) fs.mkdirSync(DATADIR, { recursive: true });

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (e) { return { keys: {}, rev: 0, updatedAt: null }; }
}
function saveState(s) {
  // Écriture atomique : fichier temporaire puis renommage
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STATE);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function readBody(req, cb) {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 60 * 1024 * 1024) req.destroy(); });
  req.on('end', () => cb(data));
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  // ── API : charger l'état partagé ──
  if (url === '/api/state' && req.method === 'GET') {
    const s = loadState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(s));
    return;
  }

  // ── API : révision courante (léger, pour le polling) ──
  if (url === '/api/rev' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rev: loadState().rev || 0 }));
    return;
  }

  // ── API : enregistrer l'état partagé ──
  if (url === '/api/state' && req.method === 'POST') {
    readBody(req, body => {
      try {
        const incoming = JSON.parse(body || '{}');
        const cur = loadState();
        // Garde anti-écrasement : si le client part d'une révision périmée, on refuse
        // et on lui renvoie l'état à jour (évite d'écraser le travail d'un collègue).
        if (typeof incoming.baseRev === 'number' && incoming.baseRev !== (cur.rev || 0)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, conflict: true, keys: cur.keys || {}, rev: cur.rev || 0 }));
          return;
        }
        const next = {
          keys: incoming.keys || {},
          rev: (cur.rev || 0) + 1,
          updatedAt: new Date().toISOString()
        };
        saveState(next);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rev: next.rev }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;
  }

  // ── API : santé ──
  if (url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rev: loadState().rev }));
    return;
  }

  // ── Fichiers statiques / application ──
  let file = url === '/' ? path.join(PUBLIC, 'PilotPro.html') : path.join(PUBLIC, url);
  // Sécurité : empêcher de sortir du dossier public
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(res, file);
});

function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(n => ifs[n].forEach(a => {
    if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }));
  return out;
}

server.listen(PORT, () => {
  const ips = lanIPs();
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   PilotPro — Serveur DBS Fashion démarré      ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  Sur ce PC :        http://localhost:' + PORT);
  ips.forEach(ip => console.log('  Sur le réseau :    http://' + ip + ':' + PORT + '   ← donnez cette adresse aux utilisateurs'));
  console.log('');
  console.log('  Données enregistrées dans : ' + STATE);
  if(process.env.DATA_DIR) console.log('  (Volume persistant : ' + process.env.DATA_DIR + ')');
  console.log('  (Laissez cette fenêtre ouverte. Fermez-la pour arrêter le serveur.)');
  console.log('');
});
