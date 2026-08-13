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
    /* ✨ v6.3 — même garde qu'en PostgreSQL : un état vide ne remplace jamais
       une base pleine (protection anti-écrasement, mode fichier compris). */
    if ((!keys || !Object.keys(keys).length) && cur.keys && Object.keys(cur.keys).length) {
      console.warn('[GARDE] état vide reçu → aucune écriture (révision inchangée : ' + (cur.rev || 0) + ')');
      const e = new Error('état vide refusé (protection anti-écrasement)');
      e.etatVide = true; e.rev = cur.rev || 0; throw e;
    }
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
  /* ✨ v6.5 — DÉMARRAGE RÉSILIENT : si PostgreSQL n'est pas encore joignable
     (déploiement Railway, base qui redémarre), le serveur NE MEURT PLUS. Il
     démarre, sert l'application, répond 503 explicite sur les données, et
     réessaie en boucle jusqu'à ce que la base réponde. */
  let pret = false;
  let ready = null;
  function preparer() {
    if (pret) return Promise.resolve();
    if (ready) return ready;
    ready = store.init()
      .then(() => { pret = true; ready = null; console.log('  PostgreSQL : schéma prêt.'); })
      .catch(e => {
        ready = null;
        console.error('  PostgreSQL indisponible (' + String(e && e.message || e).slice(0, 90) + ') — nouvelle tentative dans 3 s');
        const err = new Error('PostgreSQL indisponible : ' + String(e && e.message || e).slice(0, 120));
        err.indisponible = true;
        throw err;
      });
    return ready;
  }
  /* tentatives de connexion en tâche de fond, sans jamais bloquer le démarrage */
  (function boucle() {
    preparer().catch(() => { setTimeout(boucle, 3000); });
  })();
  let lastBackupHour = '';
  return {
    _db: db, _store: store,
    async loadState() { await preparer(); return store.loadState(); },
    async getRev() { await preparer(); return store.getRev(); },
    async saveState(keys, ts) {
      await preparer();
      // Sauvegarde best-effort : au plus une fois par heure (évite de relire l'état à chaque POST)
      const hk = hourStamp(new Date());
      if (hk !== lastBackupHour) {
        lastBackupHour = hk;
        try {
          const prev = await store.loadState();
          hourlyBackup(prev);                                   /* fichier local (si le disque persiste) */
          /* ✨ instantané DANS PostgreSQL — survit aux redéploiements Railway */
          const brut = JSON.stringify(prev);
          const gz = zlib.gzipSync(Buffer.from(brut, 'utf8')).toString('base64');
          const now = new Date(); const p2 = n => String(n).padStart(2, '0');
          await store.snapSave('state-' + hourStamp(now) + '.json', gz, brut.length);
          await store.snapSave('state-daily-' + now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate()) + '.json', gz, brut.length);
          await store.snapPrune();
        } catch (e) { /* best-effort */ }
      }
      const r = await store.saveState(keys || {}, ts);
      return { rev: r.rev, ts: +ts || Date.now(), updatedAt: new Date().toISOString() };
    },
    async restore(bk, name) {
      await preparer();
      const r = await store.saveState(bk.keys || {}, Date.now());
      logAudit('backup_restored', { name, newRev: r.rev });
      return { rev: r.rev };
    },
    async listTables() { await preparer(); return store.listTables(); },
    async readTable(n) { await preparer(); return store.readTable(n); }
  };
}

const usePg = !!DBURL;
const storage = usePg ? makePgStorage(DBURL) : FileStorage;

/* ════════════════════════════════════════════════════════════════
   ✨ MAGASIN DE FICHIERS (photos, pièces jointes) — v3.4
   Les images vivent sur le SERVEUR (PostgreSQL ou data/blobs) et non
   plus dans le stockage limité du navigateur (5-10 Mo). Le poste ne
   garde qu'un cache : l'ERP peut grandir sans jamais « être plein ».
   ════════════════════════════════════════════════════════════════ */
const BLOBDIR = path.join(DATADIR, 'blobs');
const BLOBIDX = path.join(BLOBDIR, 'index.json');
if (!fs.existsSync(BLOBDIR)) fs.mkdirSync(BLOBDIR, { recursive: true });
function h32s(x) { x = String(x == null ? '' : x); let h = 2166136261 >>> 0; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(36) + ':' + x.length; }
function blobFile(cle) { return path.join(BLOBDIR, h32s(cle).replace(':', '_') + '.txt'); }
const fileBlobs = {
  _lire() { try { const j = JSON.parse(fs.readFileSync(BLOBIDX, 'utf8')); return (j && j.idx) ? j : { idx: j || {}, dels: {} }; } catch (e) { return { idx: {}, dels: {} }; } },
  _ecrire(j) { try { const lim = Date.now() - 7 * 86400000; Object.keys(j.dels).forEach(k => { if (j.dels[k] < lim) delete j.dels[k]; }); fs.writeFileSync(BLOBIDX, JSON.stringify(j)); } catch (e) {} },
  async blobSet(cle, donnee, h, ts) {
    const j = this._lire();
    if (donnee == null) {
      try { fs.unlinkSync(blobFile(cle)); } catch (e) {}
      delete j.idx[cle]; j.dels[cle] = Date.now();          /* mémoire de suppression */
    } else {
      /* un ré-envoi PLUS ANCIEN que la suppression est refusé : un poste en retard
         ne peut pas faire ressusciter un fichier supprimé */
      if (j.dels[cle] && (+ts || 0) < j.dels[cle]) return { ok: true, ignore: 1 };
      fs.writeFileSync(blobFile(cle), donnee); j.idx[cle] = h; delete j.dels[cle];
    }
    this._ecrire(j); return { ok: true };
  },
  async blobGet(cle) { const j = this._lire(); if (j.idx[cle] == null) return null; try { return fs.readFileSync(blobFile(cle), 'utf8'); } catch (e) { return null; } },
  async blobIndex() { return this._lire().idx; }
};
const blobs = usePg ? {
  blobSet: (c, d, h, ts) => storage._store.blobSet(c, d, h, ts),
  blobGet: (c) => storage._store.blobGet(c),
  blobIndex: () => storage._store.blobIndex()
} : fileBlobs;

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
/* ✨ PRÉSENCE EN DIRECT : qui est connecté, sur quel module, sur quelle fiche.
   En mémoire seulement (éphémère par nature) ; purgé après 35 s sans battement. */
const presence = {};
function presencePropre() {
  const lim = Date.now() - 35000;
  Object.keys(presence).forEach(k => { if (presence[k].ts < lim) delete presence[k]; });
  return Object.values(presence);
}
function presenceBroadcast() {
  const payload = 'data: ' + JSON.stringify({ presence: presencePropre() }) + '\n\n';
  for (const c of sseClients) { try { c.write(payload); } catch (e) { sseClients.delete(c); } }
}
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
/* fusion fine d'une fiche : la récente impose ses champs, les sous-tableaux
   de fiches sont unis par id (l'élément de la récente gagne à id égal) */
function _fusionFiche(ancienne, recente) {
  const out = Object.assign({}, ancienne, recente);
  Object.keys(ancienne).forEach(ch => {
    const a = ancienne[ch], r = recente[ch];
    if (_estTableauFiches(a) && _estTableauFiches(r)) {
      const par = {}; const ordre = [];
      a.forEach(x => { if (par[x.id] == null) ordre.push(x.id); par[x.id] = x; });
      r.forEach(x => { if (par[x.id] == null) ordre.push(x.id); par[x.id] = x; });
      out[ch] = ordre.map(id => par[id]);
    }
  });
  return out;
}
/* ═══ NORMALISATION D'ENTRÉE (v6.3) ═══
   Point de passage OBLIGÉ avant toute écriture, quel que soit le chemin
   (synchro, restauration, envoi forcé) et quel que soit le stockage
   (PostgreSQL ou fichier). Garantit que la vérité verbatim et les
   projections pp_* sont construites à partir des MÊMES données : aucune
   divergence possible entre les deux représentations. */
function normaliserEtat(keys) {
  const out = {}; const trace = [];
  Object.keys(keys || {}).forEach(k => {
    const brut = keys[k];
    let obj;
    try { obj = JSON.parse(brut); } catch (e) { out[k] = brut; return; }   /* non-JSON : intact */
    let touche = false;
    const nettoyer = (arr, chemin) => {
      const avant = arr.length; const net = _dedoublonner(arr);
      if (net.length !== avant) { touche = true; trace.push({ cle: k, champ: chemin, avant, apres: net.length }); }
      return net;
    };
    if (_estTableauFiches(obj)) obj = nettoyer(obj, '(racine)');
    else if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      Object.keys(obj).forEach(ch => { if (_estTableauFiches(obj[ch])) obj[ch] = nettoyer(obj[ch], ch); });
    }
    out[k] = touche ? JSON.stringify(obj) : brut;      /* inchangé → octets d'origine préservés */
  });
  return { keys: out, trace };
}
function _dedoublonner(arr) {
  const vu = {}; const out = [];
  arr.forEach(r => {
    if (vu[r.id] == null) { vu[r.id] = out.length; out.push(r); }
    else if ((r._ts || 0) >= (out[vu[r.id]]._ts || 0)) out[vu[r.id]] = r;
  });
  return out;
}
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
/* ═══ ✨ v7.0 · TRANSITIONS MÉTIER IRRÉVERSIBLES ═══
   Le cycle de vie d'une commande ne recule JAMAIS « tout seul » :
   active(0) → done(1) → archived(2), et les marques de facturation
   (facturee, facture_qte) ne s'effacent pas. Un recul n'est accepté que
   s'il est VOLONTAIRE : l'horodatage du changement de statut (_st_ts,
   posé par le poste au moment du clic) est strictement plus récent que
   celui de la copie qui détient l'état avancé. Cette règle est INDÉPENDANTE
   de la révision globale et de l'horodatage général _ts de la fiche. */
function _rangStatut(s) { return s === 'archived' ? 2 : s === 'done' ? 1 : 0; }
function _protegerFiche(gagnant, perdant, champ, gardes) {
  if (!gagnant || !perdant || gagnant === perdant) return gagnant;
  var out = null;
  var gSt = gagnant._st_ts || 0, pSt = perdant._st_ts || 0;
  /* Le champ STATUT a sa PROPRE version : il appartient au côté qui a fait le
     dernier changement de statut VOLONTAIRE (_st_ts le plus récent), quel que
     soit le vainqueur général de la fiche. À égalité (fiches d'époque : 0/0),
     l'état le plus AVANCÉ gagne — jamais de recul silencieux :
       ARCHIVÉE → désarchivage volontaire (bouton ↩, _st_ts frais) → ACTIVE   ✔ opération métier
       ARCHIVÉE → vieille photo locale (aucun _st_ts)              → ACTIVE   ✘ régression interdite */
  var stOwner = pSt > gSt ? perdant
              : gSt > pSt ? gagnant
              : (_rangStatut(gagnant.statut) >= _rangStatut(perdant.statut) ? gagnant : perdant);
  if (stOwner.statut !== gagnant.statut) {
    out = Object.assign({}, gagnant);
    out.statut = stOwner.statut;
    gardes.push({ champ: champ, id: gagnant.id, protege: 'statut', garde: stOwner.statut, refuse: gagnant.statut });
  }
  /* la mémoire du dernier changement volontaire survit à la fusion */
  if (Math.max(gSt, pSt) > ((out || gagnant)._st_ts || 0)) {
    out = out || Object.assign({}, gagnant);
    out._st_ts = Math.max(gSt, pSt);
  }
  /* marques de facturation : jamais effacées par une copie qui ne porte pas
     un changement volontaire plus récent */
  var volontaire = gSt > pSt;
  ['facturee', 'facture_qte'].forEach(function (f) {
    var vP = perdant[f], vG = (out || gagnant)[f];
    if (vP && !vG && !volontaire) {
      out = out || Object.assign({}, gagnant);
      out[f] = vP;
      gardes.push({ champ: champ, id: gagnant.id, protege: f, garde: vP, refuse: vG === undefined ? 'absent' : vG });
    }
  });
  return out || gagnant;
}
function _fusionTableau(champ, srvArr, inArr, tombs, detail, horizon) {
  const parId = {};
  const ordre = [];
  let retirees = 0; const dupIds = []; const gardes = []; const bloquees = [];
  inArr.forEach(r => {
    const tomb = tombs[champ + ' ' + r.id] || 0;
    if (tomb > (r._ts || 0)) { retirees++; return; } /* supprimée ailleurs, plus récemment : ne ressuscite pas */
    if (parId[r.id] != null) {
      /* ✨ v6.1 : DOUBLON dans l'envoi (même id deux fois) — on garde la plus
         récente, jamais deux lignes (l'erreur PostgreSQL 21000 venait de là).
         v6.3 : et on le TRACE (table, clé, ids, versions retenues). */
      dupIds.push(r.id);
      if ((r._ts || 0) >= (parId[r.id]._ts || 0)) parId[r.id] = r;
      return;
    }
    parId[r.id] = r; ordre.push(r.id);
  });
  if (dupIds.length) {
    console.warn('[SYNC DEDUP · étage 1 fusion] table=' + champ + ' cle_conflit=id doublons=' + dupIds.length
      + ' ids=' + dupIds.slice(0, 10).join(',') + ' lot=' + inArr.length + '→' + ordre.length);
    try { logAudit('dedup', { etage: 'fusion', table: champ, cle: 'id', doublons: dupIds.length, ids: dupIds.slice(0, 10), lot: inArr.length, retenu: ordre.length }); } catch (e) {}
  }
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
  /* ✨ v7.0 · ANTI-RÉSURRECTION : sur une base substantielle, une fiche connue
     SEULEMENT du poste et SANS AUCUN horodatage (_ts ni ts) est forcément une
     fiche d'époque (antérieure au marquage) que le serveur ne détient plus —
     donc SUPPRIMÉE côté serveur, avant l'existence des pierres tombales.
     Elle ne revient pas. Toute création réelle est horodatée à la seconde où
     elle naît : elle passe toujours. Bloqué = journalisé avec les identifiants. */
  if (srvArr.length >= 8) {
    ordre.slice().forEach(id => {
      const r = parId[id];
      if (r && !idsServeur[id] && !(r._ts || r.ts)) { delete parId[id]; bloquees.push(r.of_number || r.ref || r.id); }
    });
  }
  srvArr.forEach(s => {
    const kk = champ + ' ' + s.id;
    if (parId[s.id] != null) {
      /* présente des deux côtés : la plus récente gagne ; ✨ v7.0 : ÉGALITÉ → LE
         SERVEUR (les fiches d'époque sans _ts des deux côtés ne permettent plus
         à une vieille photo d'écraser la vérité commune ; toute saisie réelle
         d'un poste est horodatée et gagne donc strictement). Puis la GARDE
         MÉTIER s'applique au vainqueur, quel qu'il soit : le statut ne recule
         jamais sans _st_ts plus récent, les marques de facturation ne
         s'effacent pas. */
      const local = parId[s.id];
      let vainqueur = ((s._ts || 0) >= (local._ts || 0)) ? s : local;
      const perdant = (vainqueur === s) ? local : s;
      vainqueur = _protegerFiche(vainqueur, perdant, champ, gardes);
      parId[s.id] = vainqueur;
      return;
    }
    if ((tombs[kk] || 0) >= (s._ts || 0) && tombs[kk]) return;   /* vraie suppression du poste */
    parId[s.id] = s; ordre.push(s.id); sauvees++;
    if (exemples.length < 5) exemples.push(s.of_number || s.ref || s.nom || s.id);
  });
  if (bloquees.length) {
    console.warn('[GARDE RÉSURRECTION] table=' + champ + ' fiches_bloquees=' + bloquees.length + ' ids=' + bloquees.slice(0, 10).join(','));
    try { logAudit('resurrection_bloquee', { table: champ, nombre: bloquees.length, ids: bloquees.slice(0, 20) }); } catch (e) {}
    detail.push({ champ, sauvees: 0, retirees: bloquees.length, exemples: bloquees.slice(0, 5).map(x => 'résurrection bloquée: ' + x) });
  }
  if (gardes.length) {
    console.warn('[GARDE MÉTIER] table=' + champ + ' protections=' + gardes.length + ' ' + gardes.slice(0, 5).map(g => g.id + ':' + g.protege + '=' + g.garde + '≠' + g.refuse).join(' '));
    try { logAudit('transition_protegee', { table: champ, nombre: gardes.length, detail: gardes.slice(0, 20) }); } catch (e) {}
    detail.push({ champ, sauvees: gardes.length, retirees: 0, exemples: gardes.slice(0, 5).map(g => (g.id) + ' ' + g.protege + ' conservé: ' + g.garde) });
  }
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
        } else if (_estTableauFiches(iv) && sv == null) {
          R[ch] = _dedoublonner(iv);                   /* nouveau tableau : dédoublonné par sécurité */
        } else if (/^next/i.test(ch) && typeof sv === 'number' && typeof iv === 'number') {
          R[ch] = Math.max(sv, iv);                    /* compteurs : jamais en arrière */
        }
      });
      out['pilotpro_v2'] = JSON.stringify(R);
    }
  } catch (e) { /* photo illisible : on garde la photo telle quelle */ }

  /* 2 · ✨ v7.0 · PAIEMENTS : dictionnaire facture → { règlements[], _pts }.
     Cette clé n'est PAS un tableau de fiches : avant v7.0 elle tombait dans le
     « le poste gagne en bloc » — une vieille photo effaçait un encaissement et
     une facture PAYÉE redevenait EN ATTENTE. Désormais : fusion PAR FACTURE.
     · entrée d'un seul côté → conservée (sauf pierre tombale plus récente) ;
     · les deux côtés, _pts (horodatage de l'entrée) différent → la plus récente
       gagne — une photo d'époque sans _pts ne bat jamais le serveur ;
     · égalité (données historiques) → UNION des règlements par identifiant :
       un paiement encaissé ne disparaît JAMAIS tout seul. Les suppressions
       volontaires de règlements passent par des pierres tombales dédiées. */
  try {
    const svP = JSON.parse(serverKeys['dbs_paiements_2026'] || 'null');
    const ivP = JSON.parse(inKeys['dbs_paiements_2026'] || 'null');
    if (svP && ivP && typeof svP === 'object' && typeof ivP === 'object' && !Array.isArray(svP) && !Array.isArray(ivP)) {
      const R = {}; const gardesP = [];
      new Set(Object.keys(svP).concat(Object.keys(ivP))).forEach(fk => {
        const s = svP[fk], i = ivP[fk];
        const tb = tombs['dbs_paiements_2026 ' + fk] || 0;
        if (s && !i) { if (!(tb && tb > (s._pts || 0))) R[fk] = s; return; }
        if (i && !s) { if (!(tb && tb > (i._pts || 0))) R[fk] = i; return; }
        if (!s || !i) return;
        const sp = s._pts || 0, ip = i._pts || 0;
        if (ip > sp) { R[fk] = i; return; }
        if (sp > ip) { R[fk] = s; if (!ip) gardesP.push(fk); return; }
        const par = {}; const ordreR = [];
        (Array.isArray(s.reglements) ? s.reglements : []).forEach(r => { if (r && r.id != null && par[r.id] == null) { par[r.id] = r; ordreR.push(r.id); } });
        (Array.isArray(i.reglements) ? i.reglements : []).forEach(r => {
          if (!r || r.id == null) return;
          if (par[r.id] == null) { par[r.id] = r; ordreR.push(r.id); }
          else if ((r.ts || 0) > (par[r.id].ts || 0)) par[r.id] = r;
        });
        const regs = ordreR.filter(id => { const t2 = tombs['reglements ' + fk + '|' + id] || 0; return !(t2 && t2 > (par[id].ts || 0)); }).map(id => par[id]);
        if ((s.reglements || []).length > (i.reglements || []).length && regs.length > (i.reglements || []).length) gardesP.push(fk);
        R[fk] = Object.assign({}, s, i, { reglements: regs });
      });
      if (gardesP.length) {
        console.warn('[GARDE PAIEMENTS] entrées protégées=' + gardesP.length + ' ' + gardesP.slice(0, 5).join(','));
        try { logAudit('paiement_protege', { nombre: gardesP.length, factures: gardesP.slice(0, 20) }); } catch (e) {}
        detail.push({ champ: 'dbs_paiements_2026', sauvees: gardesP.length, retirees: 0, exemples: gardesP.slice(0, 5).map(x => 'règlement conservé: ' + x) });
      }
      out['dbs_paiements_2026'] = JSON.stringify(R);
    }
  } catch (e) {}

  /* 2b · tableaux de fiches de premier niveau (journal d'activité, comptes) */
  ['dbs_activity_log', 'dbs_comptes_bancaires'].forEach(k => {
    try {
      const sv = JSON.parse(serverKeys[k] || 'null');
      const iv = JSON.parse(inKeys[k] || 'null');
      if (_estTableauFiches(sv) && _estTableauFiches(iv)) {
        if (k === 'dbs_activity_log') {
          /* ✨ JOURNAL D'ACTIVITÉ : journal ROULANT — même plafond que les postes
             (3000) et FORME CANONIQUE (tri par date puis id, coupe identique).
             Sans cela, un serveur à 4000 et des postes à 3000 se « corrigeaient »
             mutuellement en boucle infinie (≈120 envois/minute constatés).
             Jamais compté comme « fiches sauvées » : un journal qui roule
             n'est pas une perte de données. */
          const poubelle = [];
          let mergedLog = _fusionTableau(k, sv, iv, tombs, poubelle, horizon);
          mergedLog.sort((a, b) => ((a.ts || 0) - (b.ts || 0)) || String(a.id).localeCompare(String(b.id)));
          if (mergedLog.length > 3000) mergedLog = mergedLog.slice(-3000);
          out[k] = JSON.stringify(mergedLog);
          return;
        }
        let merged = _fusionTableau(k, sv, iv, tombs, detail, horizon);
        out[k] = JSON.stringify(merged);
      }
    } catch (e) {}
  });

  /* 3 · dictionnaires liés aux commandes (photos, pièces jointes, coûts, facturation) :
         les entrées connues seulement du serveur sont conservées ; celles dont la
         commande a une pierre tombale sont retirées. Même clé → le poste gagne. */
  /* ✨ GPAO et Grand Livre (blocs entiers) : un module chargé À VIDE ne peut
     JAMAIS écraser une base pleine — l'état quasi vide reçu d'un poste est
     ignoré tant que le serveur détient des données substantielles. */
  ['dbs_gpao_prod_v2', 'dbs_grandlivre_2026_v2'].forEach(k => {
    try {
      const svL = (serverKeys[k] || '').length, ivL = (inKeys[k] || '').length;
      /* état reçu ≥10× plus petit qu'une base substantielle = squelette/vide : ignoré */
      if (svL > 20000 && ivL > 0 && ivL < svL / 10) {
        out[k] = serverKeys[k];
        detail.push({ champ: k, sauvees: 1, retirees: 0, exemples: ['module vide ignoré'] });
      }
    } catch (e) {}
  });

  /* index du magasin de fichiers : union par entrée, pierres tombales respectées,
     la plus récente gagne — une photo supprimée ne ressuscite pas, une photo
     ajoutée pendant une divergence n'est jamais perdue. */
  try {
    const sv = JSON.parse(serverKeys['dbs_blob_idx'] || 'null');
    const iv = JSON.parse(inKeys['dbs_blob_idx'] || 'null');
    if (sv && iv && typeof sv === 'object' && typeof iv === 'object') {
      const norm = v => (v && typeof v === 'object') ? v : { h: String(v || ''), ts: 0 };
      const R = {};
      Object.keys(sv).forEach(k => { R[k] = norm(sv[k]); });
      Object.keys(iv).forEach(k => {
        const e = norm(iv[k]);
        if (R[k] == null || (e.ts || 0) >= (R[k].ts || 0)) R[k] = e;
      });
      Object.keys(R).forEach(k => {
        const tb = tombs['blob ' + k] || 0;
        if (tb > (R[k].ts || 0)) delete R[k];          /* supprimée plus récemment */
        else if (iv[k] == null && sv[k] != null && tb) delete R[k];
      });
      out['dbs_blob_idx'] = JSON.stringify(R);
    }
  } catch (e) {}

  ['dbs_cmd_photos', 'dbs_prepa_pj', 'dbs_overrides_2026', 'dbs_couts_articles_2026'].forEach(k => {
    try {
      const sv = JSON.parse(serverKeys[k] || 'null');
      const iv = JSON.parse(inKeys[k] || 'null');
      if (sv && iv && typeof sv === 'object' && typeof iv === 'object' && !Array.isArray(sv) && !Array.isArray(iv)) {
        const R = {}; const gardesE = [];
        Object.keys(sv).forEach(id => { if (!tombs['orders ' + id] && !tombs[k + ' ' + id]) R[id] = sv[id]; });
        Object.keys(iv).forEach(id => {
          /* ✨ v7.0 : entrée présente des deux côtés et horodatée côté serveur —
             une photo PLUS VIEILLE (ou d'époque, sans _ts) ne l'écrase plus.
             Toute modification réelle d'un poste est horodatée et gagne. */
          const s = sv[id], i = iv[id];
          if (s && i && typeof s === 'object' && typeof i === 'object' && !Array.isArray(s) && !Array.isArray(i)) {
            if ((s._ts || 0) > (i._ts || 0)) { if (R[id] == null) R[id] = s; gardesE.push(id); return; }
          }
          const tb = tombs[k + ' ' + id] || 0;
          const its = (i && typeof i === 'object' && i._ts) || 0;
          if (tb && tb > its) return;                      /* supprimée plus récemment ailleurs */
          R[id] = i;
        });
        if (gardesE.length) {
          console.warn('[GARDE ' + k + '] entrées protégées=' + gardesE.length + ' ' + gardesE.slice(0, 5).join(','));
          try { logAudit('entree_protegee', { cle: k, nombre: gardesE.length, ids: gardesE.slice(0, 20) }); } catch (e) {}
          detail.push({ champ: k, sauvees: gardesE.length, retirees: 0, exemples: gardesE.slice(0, 3) });
        }
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
    /* ✨ v7.0 : mémoire de suppression DURABLE côté serveur (20 000 entrées ≈
       des années de suppressions) — les postes gardent leur propre taille. */
    out['dbs_tombstones'] = JSON.stringify(all.slice(-20000));
  } catch (e) {}

  detail.forEach(d => { rescued += (d.sauvees || 0); });
  const changed = detail.length > 0;
  return { keys: out, rescued, changed, detail };
}

/* ═══ Empreinte de contenu (auto-réparation des postes figés) ═══ */
const CLES_ETAT = ['pilotpro_v2','dbs_overrides_2026','dbs_couts_articles_2026','dbs_deleted_2026','dbs_paiements_2026','dbs_comptes_bancaires','dbs_activity_log','dbs_blob_idx','dbs_gpao_prod_v2','dbs_grandlivre_2026_v2','dbs_taux_eur','dbs_tombstones'];
let _empCache = { rev: -1, h: '' };
function empreinteEtat(s) {
  if (s && s.rev === _empCache.rev) return _empCache.h;
  const parts = CLES_ETAT.map(k => k + '=' + h32s((s.keys || {})[k] || ''));
  const h = h32s(parts.join('|'));
  _empCache = { rev: s.rev, h };
  return h;
}

/* ═══ Clé d'accès ═══ */
const TOKEN = process.env.PP_TOKEN || '';
function tokenOk(req) {
  if (!TOKEN) return true;                       /* non configurée : ouvert (comme avant) */
  try {
    const q = new URLSearchParams((req.url.split('?')[1] || ''));
    if (q.get('t') === TOKEN) return true;
    if (String(req.headers['x-pp-token'] || '') === TOKEN) return true;
    const c = String(req.headers.cookie || '');
    if (c.split(/;\s*/).some(x => x === 'pp_t=' + encodeURIComponent(TOKEN) || x === 'pp_t=' + TOKEN)) return true;
  } catch (e) {}
  return false;
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

  /* ═══ ✨ CLÉ D'ACCÈS (v3.5) : si PP_TOKEN est défini dans les variables Railway,
     TOUTES les données exigent la clé — en-tête, cookie ou paramètre d'URL.
     L'application elle-même reste servie (l'écran de connexion la protège) ;
     ce sont les DONNÉES qui sont verrouillées. ═══ */
  if (url.startsWith('/api/') && !tokenOk(req)) {
    json(res, 401, { ok: false, auth: 1, error: 'clé d\'accès requise' });
    return;
  }

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
      .then(s => { try { s.h = empreinteEtat(s); } catch (e) {} json(res, 200, s); })
      .catch(e => {
        /* ✨ v6.2 : une PANNE de lecture n'est jamais déguisée en « serveur vide »
           (rev 0 sans erreur poussait les postes à se croire pionniers).
           Le poste reçoit une erreur EXPLICITE et attend. */
        logAudit('read_error', { error: String(e && e.message || e).slice(0, 300) });
        json(res, 503, { ok: false, indisponible: 1, error: 'PostgreSQL: ' + String(e && e.message || e).slice(0, 200), keys: null, rev: -1 });
      });
    return;
  }

  /* ───── ✨ État du pool de connexions PostgreSQL ───── */
  if (url === '/api/pool' && req.method === 'GET') {
    if (!usePg) { json(res, 200, { ok: true, backend: 'file' }); return; }
    try { json(res, 200, { ok: true, pool: storage._db.etat() }); }
    catch (e) { json(res, 500, { ok: false, error: String(e && e.message || e) }); }
    return;
  }

  /* ───── ✨ Autocontrôle de cohérence (vérité verbatim ⇄ projections) ───── */
  if (url === '/api/coherence' && req.method === 'GET') {
    if (!usePg) { json(res, 200, { ok: true, backend: 'file', note: 'mode fichier : une seule représentation, cohérence par construction' }); return; }
    storage._store.verifierCoherence()
      .then(r => { if (!r.ok) logAudit('coherence_ecart', { rev: r.rev, sceau: r.sceau, ecarts: r.ecarts.slice(0, 10) }); json(res, 200, r); })
      .catch(e => json(res, 500, { ok: false, error: String(e && e.message || e) }));
    return;
  }

  /* ───── ✨ Présence en direct ───── */
  if (url === '/api/presence' && req.method === 'POST') {
    readBody(req, body => {
      try {
        const p = JSON.parse(body || '{}');
        const cle = String(p.poste || p.u || '?').slice(0, 60);
        const avant = JSON.stringify(presence[cle] ? [presence[cle].mod, presence[cle].fiche] : null);
        presence[cle] = { poste: cle, u: String(p.u || '').slice(0, 60), mod: String(p.mod || '').slice(0, 40),
                          fiche: p.fiche == null ? null : String(p.fiche).slice(0, 40), ts: Date.now() };
        json(res, 200, { ok: true, presence: presencePropre() });
        /* diffusion seulement quand quelque chose change (pas à chaque battement) */
        if (avant !== JSON.stringify([presence[cle].mod, presence[cle].fiche])) presenceBroadcast();
      } catch (e) { json(res, 400, { ok: false }); }
    });
    return;
  }
  if (url === '/api/presence' && req.method === 'GET') {
    json(res, 200, { ok: true, presence: presencePropre() });
    return;
  }

  /* ───── ✨ Magasin de fichiers (photos, pièces jointes) ───── */
  if (url === '/api/blobs' && req.method === 'GET') {
    blobs.blobIndex().then(idx => json(res, 200, { ok: true, idx }))
      .catch(e => json(res, 500, { ok: false, error: String(e && e.message || e) }));
    return;
  }
  if (url.startsWith('/api/blob') && !url.startsWith('/api/blobs') && req.method === 'GET') {
    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const cle = q.get('k') || '';
    if (!cle) { json(res, 400, { ok: false, error: 'k manquant' }); return; }
    blobs.blobGet(cle).then(v => json(res, 200, { ok: true, k: cle, v }))
      .catch(e => json(res, 500, { ok: false, error: String(e && e.message || e) }));
    return;
  }
  if (url === '/api/blob' && req.method === 'POST') {
    readBody(req, async body => {
      try {
        const p = JSON.parse(body || '{}');
        if (!p.k) { json(res, 400, { ok: false, error: 'k manquant' }); return; }
        const h = p.v == null ? null : h32s(p.v);
        const rs = await blobs.blobSet(String(p.k).slice(0, 200), p.v == null ? null : String(p.v), h, +p.ts || 0);
        json(res, 200, { ok: true, k: p.k, h, ignore: (rs && rs.ignore) || 0 });
      } catch (e) { json(res, 400, { ok: false, error: String(e && e.message || e) }); }
    });
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
        /* ✨ passage obligé : une seule source normalisée pour les deux représentations */
        const norm = normaliserEtat(toSave);
        toSave = norm.keys;
        if (norm.trace.length) {
          console.warn('[SYNC DEDUP · entrée] ' + norm.trace.map(t => t.cle + '.' + t.champ + ' ' + t.avant + '→' + t.apres).join(' | '));
          logAudit('dedup', { etage: 'entree', detail: norm.trace.slice(0, 10), restore: !!incoming.restore, force: !!incoming.force });
        }
        const saved = await storage.saveState(toSave, incoming.ts);
        logAudit('state_update', { newRev: saved.rev, itemsBefore, itemsAfter, rescued: rescueInfo ? rescueInfo.rescued : 0, stateSizeBytes: body.length, backend: usePg ? 'postgres' : 'file', ip: (req.socket && req.socket.remoteAddress) || '' });
        /* Des fiches ont été sauvées → l'état serveur diffère de la photo envoyée :
           on renvoie l'état FUSIONNÉ pour que le poste s'aligne immédiatement. */
        if (rescueInfo) json(res, 200, { ok: true, rev: saved.rev, ts: saved.ts, rescued: rescueInfo.rescued, keys: toSave });
        else json(res, 200, { ok: true, rev: saved.rev, ts: saved.ts });
        sseBroadcast(saved.rev, !!incoming.restore); /* ✨ prévient tous les postes en ~1 s */
      } catch (e) {
        if (e && e.etatVide) {
          logAudit('empty_rejected', { rev: e.rev, ip: (req.socket && req.socket.remoteAddress) || '' });
          json(res, 409, { ok: false, etatVide: 1, rev: e.rev, error: 'état vide refusé — les données du serveur sont intactes' });
          return;
        }
        logAudit('write_error', { error: String(e && e.message || e).slice(0, 300), table: e.syncTable || '', dups: e.syncDups || [] });
        json(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 300), table: e.syncTable || undefined });
      }
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
    (async () => {
      try {
        let files = [];
        try {
          files = fs.readdirSync(BKDIR).filter(x => /^state-.*\.json$/.test(x))
            .map(n => { const st = fs.statSync(path.join(BKDIR, n)); return { name: n, size: st.size, mtime: st.mtime.toISOString() }; });
        } catch (e) {}
        if (usePg) {
          try {
            const snaps = await storage._store.snapList();
            const vus = new Set(files.map(f => f.name));
            snaps.forEach(sn => { if (!vus.has(sn.name)) files.push(sn); });
          } catch (e) {}
        }
        files.sort((a, b) => (a.name < b.name ? 1 : -1));
        json(res, 200, { ok: true, backups: files });
      } catch (e) { json(res, 500, { ok: false, error: String(e) }); }
    })();
    return;
  }
  if (url.startsWith('/api/backups/') && req.method === 'GET') {
    const name = url.slice('/api/backups/'.length);
    if (!/^state-[\w\-\.]+\.json$/.test(name)) { json(res, 400, { ok: false, error: 'nom invalide' }); return; }
    const f = path.join(BKDIR, name);
    if (fs.existsSync(f)) {
      logAudit('backup_downloaded', { name });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="' + name + '"' });
      fs.createReadStream(f).pipe(res);
      return;
    }
    if (usePg) {
      storage._store.snapGet(name).then(gz => {
        if (!gz) { json(res, 404, { ok: false, error: 'introuvable' }); return; }
        logAudit('backup_downloaded', { name, source: 'postgres' });
        const brut = zlib.gunzipSync(Buffer.from(gz, 'base64'));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="' + name + '"' });
        res.end(brut);
      }).catch(e => json(res, 500, { ok: false, error: String(e && e.message || e) }));
      return;
    }
    json(res, 404, { ok: false, error: 'introuvable' });
    return;
  }
  if (url === '/api/restore' && req.method === 'POST') {
    readBody(req, async body => {
      try {
        const { name } = JSON.parse(body || '{}');
        if (!/^state-[\w\-\.]+\.json$/.test(String(name))) { json(res, 400, { ok: false, error: 'nom invalide' }); return; }
        let bk = null;
        const f = path.join(BKDIR, name);
        if (fs.existsSync(f)) bk = JSON.parse(fs.readFileSync(f, 'utf8'));
        else if (usePg) { const gz = await storage._store.snapGet(name);
          if (gz) bk = JSON.parse(zlib.gunzipSync(Buffer.from(gz, 'base64')).toString('utf8')); }
        if (!bk) { json(res, 404, { ok: false, error: 'instantané introuvable' }); return; }
        /* horizon : les postes en retard ne réinjecteront pas ce que cette
           restauration retire volontairement */
        bk.keys = normaliserEtat(Object.assign({}, bk.keys, { pp_restore_horizon: String(Date.now()) })).keys;
        const r = await storage.restore(bk, name);
        logAudit('backup_restored', { name, newRev: r.rev });
        json(res, 200, { ok: true, rev: r.rev });
        sseBroadcast(r.rev, 1);              /* ✨ les postes ADOPTENT la restauration telle quelle */
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
  if (usePg) { try { console.log('  Pool PostgreSQL :  ' + storage._db.etat().max + ' connexions max · une transaction = une connexion dédiée'); } catch (e) {} }
  console.log('  Sauvegardes :      ' + BKDIR + '  (horaires + quotidiennes)');
  console.log('  Audit :            ' + AUDIT + '  (lecture: /api/audit)');
  console.log('  Compression :      gzip activée sur toutes les réponses');
  console.log('  Temps réel :       /api/events (les postes sont prévenus en ~1 s)');
  console.log('  Journal des prix : /api/prices  (' + (usePg ? 'table pp_prix_journal' : PRICES) + ')');
  console.log('');
});
