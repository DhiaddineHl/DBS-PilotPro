/* ════════════════════════════════════════════════════════════════
   PilotPro — Serveur v3.0 (zéro dépendance, Node.js natif)
   • Sert l'application PilotPro (INCHANGÉE — login géré par l'app elle-même)
   • Enregistre l'état partagé (base centrale) avec HORODATAGE
   • Sauvegardes horaires + quotidiennes automatiques (data/backups)
   • Journal d'audit non-bloquant · Compression gzip automatique
   ✨ NOUVEAU v3.0 — Stockage PostgreSQL STRUCTURÉ PAR MODULE :
   • Si la variable DATABASE_URL est définie → les données sont rangées
     dans de vraies tables (pp_orders, pp_clients, pp_grandlivre…),
     ce qui permet le PARTAGE avec l'application « DBS ».
   • Sinon → repli automatique sur data/state.json (fichier, comme avant).
   • Le contrat /api/state (GET/POST) est INCHANGÉ : l'application n'est
     pas modifiée, la fusion et le mode hors-ligne fonctionnent à l'identique.
   • Endpoints lecture pour l'app DBS : /api/db  et  /api/db/<table>
   ════════════════════════════════════════════════════════════════ */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const zlib = require('zlib');

const PORT    = process.env.PORT || process.argv[2] || 3000;
const BASE    = process.pkg ? path.dirname(process.execPath) : __dirname;
const PUBLIC  = path.join(BASE, 'public');
const DATADIR = process.env.DATA_DIR || path.join(BASE, 'data');
const STATE   = path.join(DATADIR, 'state.json');
const BKDIR   = path.join(DATADIR, 'backups');
const AUDIT   = path.join(DATADIR, 'audit.jsonl');
const BK_MAX  = 240; // ≈ 10 jours de sauvegardes horaires
const DBURL   = process.env.DATABASE_URL || '';

if (!fs.existsSync(DATADIR)) fs.mkdirSync(DATADIR, { recursive: true });
if (!fs.existsSync(BKDIR))   fs.mkdirSync(BKDIR,   { recursive: true });
if (!fs.existsSync(AUDIT))   fs.writeFileSync(AUDIT, '');

/* ═══ AUDIT (non-bloquant : une erreur ici ne doit JAMAIS gêner l'app) ═══ */
function logAudit(action, details) {
  try {
    const entry = { timestamp: new Date().toISOString(), action, ...details };
    fs.appendFileSync(AUDIT, JSON.stringify(entry) + '\n');
  } catch (e) { /* silencieux : l'audit ne doit jamais bloquer le service */ }
}

/* ═══ Sauvegardes disque (JSON) — conservées dans les DEUX modes ═══ */
function hourStamp(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + 'h';
}
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
    prune(/^state-\d{4}-.*\.json$/, BK_MAX);
    prune(/^state-daily-.*\.json$/, 60);
  } catch (e) { console.warn('backup:', e.message); }
}

/* ════════════════════════════════════════════════════════════════
   COUCHE STOCKAGE — deux implémentations, même interface :
     await storage.loadState()  → { keys, rev, ts, updatedAt }
     await storage.saveState(keys, ts) → { rev, ts, updatedAt }
     await storage.getRev()     → number
   ════════════════════════════════════════════════════════════════ */

/* ── Backend FICHIER (state.json) — comportement historique ── */
const FileStorage = {
  loadState() {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
    catch (e) { return { keys: {}, rev: 0, ts: 0, updatedAt: null }; }
  },
  _save(s) { const tmp = STATE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(s)); fs.renameSync(tmp, STATE); },
  async getRev() { return this.loadState().rev || 0; },
  async saveState(keys, ts) {
    const cur = this.loadState();
    hourlyBackup(cur);
    const next = { keys: keys || {}, rev: (cur.rev || 0) + 1, ts: +ts || Date.now(), updatedAt: new Date().toISOString() };
    this._save(next);
    return { rev: next.rev, ts: next.ts, updatedAt: next.updatedAt };
  },
  restore(bk, name) {
    const cur = this.loadState(); hourlyBackup(cur);
    const next = { keys: bk.keys || {}, rev: (cur.rev || 0) + 1, ts: Date.now(), updatedAt: new Date().toISOString(), restoredFrom: name };
    this._save(next); return { rev: next.rev };
  }
};

/* ── Backend POSTGRESQL (structuré par module) ── */
function makePgStorage(dburl) {
  const { Client } = require('./pgwire');
  const { PgStore } = require('./pgstore');
  const db = new Client(dburl);
  const store = new PgStore(db);
  let ready = store.init().then(() => { console.log('  PostgreSQL : schéma prêt.'); })
    .catch(e => { console.error('  PostgreSQL init:', e.message); throw e; });
  let lastBackupHour = '';
  return {
    _db: db, _store: store,
    async loadState() { await ready; return store.loadState(); },
    async getRev() { await ready; return store.getRev(); },
    async saveState(keys, ts) {
      await ready;
      // Sauvegarde disque best-effort : au plus une fois par heure (évite de relire l'état à chaque POST)
      const hk = hourStamp(new Date());
      if (hk !== lastBackupHour) {
        lastBackupHour = hk;
        try { const prev = await store.loadState(); hourlyBackup(prev); } catch (e) { /* best-effort */ }
      }
      const r = await store.saveState(keys || {}, ts);
      return { rev: r.rev, ts: +ts || Date.now(), updatedAt: new Date().toISOString() };
    },
    async restore(bk, name) {
      await ready;
      const r = await store.saveState(bk.keys || {}, Date.now());
      logAudit('backup_restored', { name, newRev: r.rev });
      return { rev: r.rev };
    },
    async listTables() { await ready; return store.listTables(); },
    async readTable(n) { await ready; return store.readTable(n); }
  };
}

const usePg = !!DBURL;
const storage = usePg ? makePgStorage(DBURL) : FileStorage;

/* ════════════════════════════════════════════════════════════════
   ✨ JOURNAL DES PRIX (modèle bancaire)
   Chaque changement de prix est une TRANSACTION horodatée, ordonnée
   par le serveur et jamais effacée : qui, quand, ancien → nouveau.
   • Mode PostgreSQL : table pp_prix_journal (protégée, jamais purgée)
   • Mode fichier    : data/prices.jsonl (ajout en fin, jamais réécrit)
   ════════════════════════════════════════════════════════════════ */
const PRICES = path.join(DATADIR, 'prices.jsonl');
const priceStore = {
  async add(user, txs, ip) {
    if (usePg) { await storage._store.addPriceTxs(user, txs, ip); return { count: txs.length }; }
    let seq = Date.now();
    for (const t of txs) {
      const entry = { seq: seq++, ts: new Date().toISOString(), user: user || '', orderId: String(t.orderId), of: t.of || '', field: t.field, old: t.old == null ? null : +t.old, nw: t.nw == null ? null : +t.nw, ip: ip || '' };
      fs.appendFileSync(PRICES, JSON.stringify(entry) + '\n');
    }
    return { count: txs.length };
  },
  async query(orderId, limit) {
    if (usePg) return storage._store.queryPrices(orderId, limit);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    let lines = [];
    try { lines = fs.readFileSync(PRICES, 'utf8').split('\n').filter(l => l.trim()); } catch (e) {}
    let entries = lines.map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    if (orderId != null) entries = entries.filter(e => e.orderId === String(orderId));
    return entries.slice(-lim).reverse();
  }
};

/* ════════════════════════════════════════════════════════════════
   ✨ TEMPS RÉEL (Server-Sent Events, natif, zéro dépendance)
   Chaque poste garde une connexion ouverte sur /api/events.
   À chaque enregistrement, le serveur diffuse la nouvelle révision :
   les autres postes se mettent à jour en ~1 seconde au lieu de 60.
   Un battement de cœur toutes les 25 s empêche les proxys (Railway…)
   de couper les connexions inactives.
   ════════════════════════════════════════════════════════════════ */
const sseClients = new Set();
function sseBroadcast(rev, restore) {
  /* ✨ restore:1 → il ne s'agit pas d'un enregistrement ordinaire mais de la
     RESTAURATION d'une sauvegarde : les autres postes doivent adopter cet état
     tel quel, sans fusionner leurs modifications locales par-dessus (sinon les
     fiches supprimées par la sauvegarde réapparaissent aussitôt). */
  const payload = 'data: ' + JSON.stringify(restore ? { rev, restore: 1 } : { rev }) + '\n\n';
  for (const c of sseClients) { try { c.write(payload); } catch (e) { sseClients.delete(c); } }
}
setInterval(() => {
  for (const c of sseClients) { try { c.write(': ping\n\n'); } catch (e) { sseClients.delete(c); } }
}, 25000);

/* ════════════════════════════════════════════════════════════════
   AUTORITÉ SERVEUR FICHE PAR FICHE (v3.3)
   ────────────────────────────────────────────────────────────────
   Principe (celui des vrais ERP) : la base du serveur est l'autorité.
   Une photo d'état reçue d'un poste est FUSIONNÉE fiche par fiche :
     · fiche présente des deux côtés  → la plus récente gagne (_ts),
       à égalité le poste qui écrit gagne (il travaille activement) ;
     · fiche seulement chez le poste  → ajoutée (création) — sauf si
       une pierre tombale plus récente indique qu'elle a été supprimée
       ailleurs (elle ne ressuscite pas) ;
     · fiche seulement sur le serveur → SAUVÉE, sauf pierre tombale
       du poste (vraie suppression). Un poste resté éteint des jours
       ne peut donc plus effacer les commandes ajoutées entre-temps.
   Les compteurs (nextOfNum…) prennent le MAXIMUM des deux côtés :
   plus de numéros d'OF réutilisés après une divergence.
   ════════════════════════════════════════════════════════════════ */
function _estTableauFiches(v) {
  return Array.isArray(v) && v.every(x => x && typeof x === 'object' && !Array.isArray(x) && x.id != null);
}
function _tombIndex(keysA, keysB) {
  /* pierres tombales des deux côtés, la plus récente par (champ,id) */
  const idx = {};
  [keysA, keysB].forEach(keys => {
    try {
      const arr = JSON.parse((keys && keys['dbs_tombstones']) || '[]');
      if (Array.isArray(arr)) arr.forEach(t => {
        if (!t || t.id == null || !t.k) return;
        const kk = t.k + ' ' + t.id;
        if (!idx[kk] || (t.ts || 0) > idx[kk]) idx[kk] = t.ts || 0;
      });
    } catch (e) {}
  });
  return idx;
}
function _fusionTableau(champ, srvArr, inArr, tombs, detail, horizon) {
  const parId = {};
  const ordre = [];
  let retirees = 0;
  inArr.forEach(r => {
    const tomb = tombs[champ + ' ' + r.id] || 0;
    if (tomb > (r._ts || 0)) { retirees++; return; } /* supprimée ailleurs, plus récemment : ne ressuscite pas */
    parId[r.id] = r; ordre.push(r.id);
  });
  let sauvees = 0; const exemples = [];
  /* fiches du poste retirées car supprimées plus récemment ailleurs */
  const idsServeur = {}; srvArr.forEach(s => { idsServeur[s.id] = 1; });
  if (horizon > 0) {
    /* fiches connues SEULEMENT du poste et antérieures à la dernière restauration :
       la restauration a déjà tranché — elles ne reviennent pas toutes seules */
    ordre.slice().forEach(id => {
      const r = parId[id];
      if (r && !idsServeur[id] && (r._ts || 0) < horizon) { delete parId[id]; }
    });
  }
  srvArr.forEach(s => {
    const kk = champ + ' ' + s.id;
    if (parId[s.id] != null) {
      /* présente des deux côtés : la plus récente gagne ; égalité → le poste (actif) */
      if ((s._ts || 0) > (parId[s.id]._ts || 0)) parId[s.id] = s;
      return;
    }
    if ((tombs[kk] || 0) >= (s._ts || 0) && tombs[kk]) return;   /* vraie suppression du poste */
    parId[s.id] = s; ordre.push(s.id); sauvees++;
    if (exemples.length < 5) exemples.push(s.of_number || s.ref || s.nom || s.id);
  });
  if (sauvees || retirees) detail.push({ champ, sauvees, retirees, exemples });
  return ordre.filter(id => parId[id] != null).map(id => parId[id]);
}
function mergeAutorite(serverKeys, inKeys) {
  const out = {};
  Object.keys(inKeys).forEach(k => { out[k] = inKeys[k]; });
  /* les clés présentes seulement côté serveur sont conservées telles quelles */
  Object.keys(serverKeys).forEach(k => { if (out[k] == null) out[k] = serverKeys[k]; });
  const tombs = _tombIndex(serverKeys, inKeys);
  const detail = [];
  let rescued = 0;
  let horizon = 0;
  try { horizon = parseInt(serverKeys['pp_restore_horizon'] || '0', 10) || 0; } catch (e) {}
  if (out['pp_restore_horizon'] == null && serverKeys['pp_restore_horizon'] != null) out['pp_restore_horizon'] = serverKeys['pp_restore_horizon'];

  /* 1 · pilotpro_v2 : fusion de chaque tableau de fiches + compteurs au max */
  try {
    const S = JSON.parse(serverKeys['pilotpro_v2'] || 'null');
    const I = JSON.parse(inKeys['pilotpro_v2'] || 'null');
    if (S && I && typeof S === 'object' && typeof I === 'object') {
      const R = I;                                    /* base = photo du poste (scalaires, préférences) */
      const champs = new Set(Object.keys(S).concat(Object.keys(I)));
      champs.forEach(ch => {
        const sv = S[ch], iv = I[ch];
        if (_estTableauFiches(sv) && _estTableauFiches(iv)) {
          R[ch] = _fusionTableau(ch, sv, iv, tombs, detail, horizon);
        } else if (_estTableauFiches(sv) && iv == null) {
          R[ch] = sv;                                  /* tableau absent de la photo : conservé */
        } else if (/^next/i.test(ch) && typeof sv === 'number' && typeof iv === 'number') {
          R[ch] = Math.max(sv, iv);                    /* compteurs : jamais en arrière */
        }
      });
      out['pilotpro_v2'] = JSON.stringify(R);
    }
  } catch (e) { /* photo illisible : on garde la photo telle quelle */ }

  /* 2 · tableaux de fiches de premier niveau (journal d'activité, paiements, comptes) */
  ['dbs_activity_log', 'dbs_paiements_2026', 'dbs_comptes_bancaires'].forEach(k => {
    try {
      const sv = JSON.parse(serverKeys[k] || 'null');
      const iv = JSON.parse(inKeys[k] || 'null');
      if (_estTableauFiches(sv) && _estTableauFiches(iv)) {
        let merged = _fusionTableau(k, sv, iv, tombs, detail, horizon);
        if (k === 'dbs_activity_log' && merged.length > 4000) merged = merged.slice(-4000);
        out[k] = JSON.stringify(merged);
      }
    } catch (e) {}
  });

  /* 3 · dictionnaires liés aux commandes (photos, pièces jointes, coûts, facturation) :
         les entrées connues seulement du serveur sont conservées ; celles dont la
         commande a une pierre tombale sont retirées. Même clé → le poste gagne. */
  ['dbs_cmd_photos', 'dbs_prepa_pj', 'dbs_overrides_2026', 'dbs_couts_articles_2026'].forEach(k => {
    try {
      const sv = JSON.parse(serverKeys[k] || 'null');
      const iv = JSON.parse(inKeys[k] || 'null');
      if (sv && iv && typeof sv === 'object' && typeof iv === 'object' && !Array.isArray(sv) && !Array.isArray(iv)) {
        const R = {};
        Object.keys(sv).forEach(id => { if (!tombs['orders ' + id]) R[id] = sv[id]; });
        Object.keys(iv).forEach(id => { R[id] = iv[id]; });
        out[k] = JSON.stringify(R);
      }
    } catch (e) {}
  });

  /* 4 · fusion des pierres tombales elles-mêmes (union, bornée) */
  try {
    const seen = {}; const all = [];
    [serverKeys, inKeys].forEach(keys => {
      try { (JSON.parse((keys && keys['dbs_tombstones']) || '[]') || []).forEach(t => {
        if (!t || t.id == null || !t.k) return;
        const kk = t.k + ' ' + t.id;
        if (seen[kk] == null || (t.ts || 0) > all[seen[kk]].ts) { if (seen[kk] == null) { seen[kk] = all.length; all.push(t); } else all[seen[kk]] = t; }
      }); } catch (e) {}
    });
    all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    out['dbs_tombstones'] = JSON.stringify(all.slice(-4000));
  } catch (e) {}

  detail.forEach(d => { rescued += (d.sauvees || 0); });
  const changed = detail.length > 0;
  return { keys: out, rescued, changed, detail };
}

/* ═══ HTTP helpers ═══ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(file);
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    h['Cache-Control'] = (ext === '.html') ? 'no-store, must-revalidate' : 'public, max-age=300';
    if (buf.length > 1024) {
      zlib.gzip(buf, (gzErr, compressed) => {
        if (!gzErr && compressed.length < buf.length) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); res.end(compressed); }
        else { res.writeHead(200, h); res.end(buf); }
      });
    } else { res.writeHead(200, h); res.end(buf); }
  });
}
function readBody(req, cb) {
  let data = '';
  req.on('data', c => { data += c; if (data.length > 60 * 1024 * 1024) req.destroy(); });
  req.on('end', () => cb(data));
}
function json(res, code, obj) {
  const jsonStr = JSON.stringify(obj);
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (jsonStr.length > 1024) {
    zlib.gzip(Buffer.from(jsonStr), (err, compressed) => {
      if (!err) { h['Content-Encoding'] = 'gzip'; res.writeHead(code, h); res.end(compressed); }
      else { res.writeHead(code, h); res.end(jsonStr); }
    });
  } else { res.writeHead(code, h); res.end(jsonStr); }
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  /* ───── ✨ Temps réel : flux d'événements (SSE) ───── */
  if (url === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');            /* reconnexion auto en 3 s si coupure */
    Promise.resolve(storage.getRev())
      .then(rev => { try { res.write('data: ' + JSON.stringify({ rev }) + '\n\n'); } catch (e) {} })
      .catch(() => {});
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  /* ───── État partagé (GET) — INCHANGÉ ───── */
  if (url === '/api/state' && req.method === 'GET') {
    Promise.resolve(storage.loadState())
      .then(s => json(res, 200, s))
      .catch(e => json(res, 500, { keys: {}, rev: 0, ts: 0, error: String(e) }));
    return;
  }

  /* ───── État partagé (POST) — contrat INCHANGÉ + décomposition par module ───── */
  if (url === '/api/state' && req.method === 'POST') {
    readBody(req, async body => {
      try {
        const incoming = JSON.parse(body || '{}');
        /* Garde anti-écrasement (identique à avant) : si le client annonce sa
           révision de base et qu'elle ne correspond plus, on refuse (409). */
        const curRev = await storage.getRev();
        if (typeof incoming.baseRev === 'number' && curRev > 0 && incoming.baseRev !== curRev) {
          const cur = await storage.loadState();
          json(res, 409, { ok: false, conflict: true, rev: curRev, updatedAt: cur.updatedAt });
          return;
        }
        const itemsBefore = curRev; // info indicative
        const itemsAfter  = incoming.keys ? Object.keys(incoming.keys).length : 0;
        /* ═══ AUTORITÉ SERVEUR FICHE PAR FICHE (v3.3) ═══
           Le serveur ne remplace plus aveuglément sa base par la photo reçue :
           il fusionne fiche par fiche. Une commande présente sur le serveur et
           absente de la photo d'un poste N'EST SUPPRIMÉE que si ce poste l'a
           réellement supprimée (pierre tombale) — sinon elle est SAUVÉE.
           Un poste resté éteint ne peut donc plus jamais effacer le travail
           des autres. Seules exceptions : restauration d'une sauvegarde et
           « Envoyer CE POSTE » de l'administrateur (remplacement assumé). */
        let toSave = incoming.keys || {};
        let rescueInfo = null;
        if (incoming.restore) {
          /* HORIZON DE RESTAURATION : une sauvegarde vient d'être imposée. Les photos
             de postes restés en retard (fiches antérieures à cet instant) ne pourront
             plus réinjecter ce que la restauration a volontairement retiré. */
          toSave = Object.assign({}, toSave, { pp_restore_horizon: String(Date.now()) });
        }
        if (!incoming.restore && !incoming.force && Object.keys(toSave).length) {
          try {
            const cur = await storage.loadState();
            if (cur && cur.keys && Object.keys(cur.keys).length) {
              const mg = mergeAutorite(cur.keys, toSave);
              toSave = mg.keys;
              if (mg.changed) {
                rescueInfo = mg;
                logAudit('rescue', { total: mg.rescued, detail: mg.detail, ip: (req.socket && req.socket.remoteAddress) || '' });
              }
            }
          } catch (e) { logAudit('merge_error', { error: String(e && e.message || e) }); }
        }
        const saved = await storage.saveState(toSave, incoming.ts);
        logAudit('state_update', { newRev: saved.rev, itemsBefore, itemsAfter, rescued: rescueInfo ? rescueInfo.rescued : 0, stateSizeBytes: body.length, backend: usePg ? 'postgres' : 'file', ip: (req.socket && req.socket.remoteAddress) || '' });
        /* Des fiches ont été sauvées → l'état serveur diffère de la photo envoyée :
           on renvoie l'état FUSIONNÉ pour que le poste s'aligne immédiatement. */
        if (rescueInfo) json(res, 200, { ok: true, rev: saved.rev, ts: saved.ts, rescued: rescueInfo.rescued, keys: toSave });
        else json(res, 200, { ok: true, rev: saved.rev, ts: saved.ts });
        sseBroadcast(saved.rev, !!incoming.restore); /* ✨ prévient tous les postes en ~1 s */
      } catch (e) { json(res, 400, { ok: false, error: String(e && e.message || e) }); }
    });
    return;
  }

  /* ───── ✨ Journal des prix (modèle bancaire) ───── */
  if (url === '/api/prices' && req.method === 'POST') {
    readBody(req, async body => {
      try {
        const p = JSON.parse(body || '{}');
        const txs = Array.isArray(p.txs) ? p.txs.slice(0, 100) : [];
        const valid = txs.filter(t => t && t.orderId != null && (t.field === 'prix_vente' || t.field === 'prix_facon'));
        if (!valid.length) { json(res, 400, { ok: false, error: 'aucune transaction valide' }); return; }
        const r = await priceStore.add(String(p.user || '').slice(0, 60), valid, (req.socket && req.socket.remoteAddress) || '');
        logAudit('price_tx', { count: r.count, user: String(p.user || '').slice(0, 60), orders: valid.map(t => t.of || t.orderId).slice(0, 10) });
        json(res, 200, { ok: true, count: r.count });
      } catch (e) { json(res, 400, { ok: false, error: String(e && e.message || e) }); }
    });
    return;
  }
  if (url === '/api/prices' && req.method === 'GET') {
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    priceStore.query(q.get('orderId'), q.get('limit'))
      .then(entries => json(res, 200, { ok: true, count: entries.length, entries }))
      .catch(e => json(res, 500, { ok: false, error: String(e && e.message || e) }));
    return;
  }

  /* ───── Lecture des modules pour l'application DBS ───── */
  if (url === '/api/db' && req.method === 'GET') {
    if (!usePg) { json(res, 200, { ok: true, backend: 'file', tables: [], note: 'PostgreSQL non configuré (mode fichier).' }); return; }
    storage.listTables().then(t => json(res, 200, { ok: true, backend: 'postgres', tables: t }))
      .catch(e => json(res, 500, { ok: false, error: String(e.message || e) }));
    return;
  }
  if (url.startsWith('/api/db/') && req.method === 'GET') {
    if (!usePg) { json(res, 400, { ok: false, error: 'PostgreSQL non configuré.' }); return; }
    const name = url.slice('/api/db/'.length);
    storage.readTable(name).then(rows => json(res, 200, { ok: true, table: name, count: rows.length, rows }))
      .catch(e => json(res, 400, { ok: false, error: String(e.message || e) }));
    return;
  }

  /* ───── Sauvegardes (liste / téléchargement / restauration) ───── */
  if (url === '/api/backups' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(BKDIR).filter(x => /^state-.*\.json$/.test(x)).sort().reverse()
        .map(n => { const st = fs.statSync(path.join(BKDIR, n)); return { name: n, size: st.size, mtime: st.mtime.toISOString() }; });
      json(res, 200, { ok: true, backups: files });
    } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
    return;
  }
  if (url.startsWith('/api/backups/') && req.method === 'GET') {
    const name = url.slice('/api/backups/'.length);
    if (!/^state-[\w\-\.]+\.json$/.test(name)) { json(res, 400, { ok: false, error: 'nom invalide' }); return; }
    const f = path.join(BKDIR, name);
    if (!fs.existsSync(f)) { json(res, 404, { ok: false, error: 'introuvable' }); return; }
    logAudit('backup_downloaded', { name });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="' + name + '"' });
    fs.createReadStream(f).pipe(res);
    return;
  }
  if (url === '/api/restore' && req.method === 'POST') {
    readBody(req, async body => {
      try {
        const { name } = JSON.parse(body || '{}');
        if (!/^state-[\w\-\.]+\.json$/.test(String(name))) { json(res, 400, { ok: false, error: 'nom invalide' }); return; }
        const f = path.join(BKDIR, name);
        const bk = JSON.parse(fs.readFileSync(f, 'utf8'));
        const r = await storage.restore(bk, name);
        logAudit('backup_restored', { name, newRev: r.rev });
        json(res, 200, { ok: true, rev: r.rev });
        sseBroadcast(r.rev);                 /* ✨ les postes rechargent la restauration */
      } catch (e) { json(res, 400, { ok: false, error: String(e && e.message || e) }); }
    });
    return;
  }

  if (url === '/api/audit' && req.method === 'GET') {
    try {
      const lines = fs.readFileSync(AUDIT, 'utf8').split('\n').filter(l => l.trim());
      const entries = lines.slice(-200).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      json(res, 200, { ok: true, count: entries.length, entries });
    } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
    return;
  }

  if (url === '/api/health') {
    Promise.resolve(storage.getRev())
      .then(rev => json(res, 200, { ok: true, rev, backend: usePg ? 'postgres' : 'file', dataDir: DATADIR }))
      .catch(e => json(res, 500, { ok: false, error: String(e.message || e) }));
    return;
  }

  let file = url === '/' ? path.join(PUBLIC, 'PilotPro.html') : path.join(PUBLIC, url);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end('Forbidden'); return; }
  serveFile(res, file);
});

function lanIPs() {
  const out = []; const ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(n => ifs[n].forEach(a => { if (a.family === 'IPv4' && !a.internal) out.push(a.address); }));
  return out;
}

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║   PilotPro — Serveur v3.2 DBS Fashion démarré ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  Sur ce PC :        http://localhost:' + PORT);
  lanIPs().forEach(ip => console.log('  Sur le réseau :    http://' + ip + ':' + PORT));
  console.log('');
  console.log('  Stockage :         ' + (usePg ? 'PostgreSQL (structuré par module) ✨' : 'Fichier ' + STATE));
  if (usePg) console.log('  Lecture modules :  /api/db  et  /api/db/<table>  (pour l\'app DBS)');
  console.log('  Sauvegardes :      ' + BKDIR + '  (horaires + quotidiennes)');
  console.log('  Audit :            ' + AUDIT + '  (lecture: /api/audit)');
  console.log('  Compression :      gzip activée sur toutes les réponses');
  console.log('  Temps réel :       /api/events (les postes sont prévenus en ~1 s)');
  console.log('  Journal des prix : /api/prices  (' + (usePg ? 'table pp_prix_journal' : PRICES) + ')');
  console.log('');
});
