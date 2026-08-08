/* ════════════════════════════════════════════════════════════════
   pgstore.js — Stockage PilotPro sur PostgreSQL, structuré PAR MODULE
   ----------------------------------------------------------------
   Le client PilotPro continue d'envoyer/recevoir EXACTEMENT le même
   objet `keys` qu'avant (aucune modification de l'application).
   Ici, côté serveur, on DÉCOMPOSE ce bloc en vraies tables :

     • pilotpro_v2.orders     → table  pp_orders     (1 ligne / commande)
     • pilotpro_v2.clients    → table  pp_clients
     • pilotpro_v2.faconniers → table  pp_faconniers
     • dbs_grandlivre_2026_v2 → table  pp_grandlivre (1 ligne / compte)
     • dbs_overrides_2026     → table  pp_factures   (1 ligne / facture)
     • ... etc.

   → L'application « DBS » de l'ingénieur peut lire/écrire ces tables
     directement (SELECT * FROM pp_orders), c'est une VRAIE base partagée.

   Garantie clé : recompose(decompose(x)) === x  (aller-retour identique).
   Tout ce qui n'est pas une collection de fiches (compteurs, réglages,
   journaux…) est conservé tel quel dans une table `pp_meta`, via un
   « squelette » qui préserve exactement la forme d'origine.
   ════════════════════════════════════════════════════════════════ */
'use strict';

/* Noms de tables « propres » pour les modules prioritaires.
   Toute collection non listée reçoit un nom dérivé automatiquement. */
const NICE = {
  'pilotpro_v2.orders': 'pp_orders',
  'pilotpro_v2.clients': 'pp_clients',
  'pilotpro_v2.faconniers': 'pp_faconniers',
  'pilotpro_v2.chaines': 'pp_chaines',
  'pilotpro_v2.operations': 'pp_operations',
  'pilotpro_v2.tissus': 'pp_tissus',
  'pilotpro_v2.brs': 'pp_brs',
  'pilotpro_v2.coupes': 'pp_coupes',
  'pilotpro_v2.factures': 'pp_factures_int',
  'pilotpro_v2.qrqcs': 'pp_qrqcs',
  'dbs_grandlivre_2026_v2': 'pp_grandlivre',
  'dbs_overrides_2026': 'pp_factures',
  'dbs_couts_articles_2026': 'pp_factures_couts',
  'dbs_paiements_2026': 'pp_factures_paiements'
};

function sanitize(s) { return 'pp_' + String(s).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, ''); }
function tableFor(source) { return NICE[source] || sanitize(source); }

/* Une valeur est-elle une COLLECTION de fiches décomposable ? */
function isRecordArray(v) {
  return Array.isArray(v) && v.length > 0 && v.every(e => e && typeof e === 'object' && !Array.isArray(e) && ('id' in e));
}
function isRecordDict(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const ks = Object.keys(v);
  return ks.length > 0 && ks.every(k => v[k] && typeof v[k] === 'object' && !Array.isArray(v[k]));
}

/* ─── DÉCOMPOSITION ───
   keys : { "pilotpro_v2": "<json string>", "dbs_...": "<json string>", ... }
   Retour : { toplevel:[...], meta:{k:v}, tables:{ name:{kind, rows:[{id,ord,data}]} } } */
function decompose(keys) {
  const toplevel = Object.keys(keys);
  const meta = {};
  const tables = {};

  function extractArray(source, arr) {
    const name = tableFor(source);
    tables[name] = { kind: 'array', rows: arr.map((el, i) => ({ id: String(el.id), ord: i, data: el })) };
    return { __ref: name, __kind: 'array' };
  }
  function extractDict(source, dict) {
    const name = tableFor(source);
    const ks = Object.keys(dict);
    tables[name] = { kind: 'dict', rows: ks.map((k, i) => ({ id: k, ord: i, data: dict[k] })) };
    return { __ref: name, __kind: 'dict' };
  }

  for (const key of toplevel) {
    let parsed;
    try { parsed = JSON.parse(keys[key]); }
    catch (e) { meta[key] = { __rawString: keys[key] }; continue; }

    if (key === 'pilotpro_v2' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const skel = {};
      for (const prop of Object.keys(parsed)) {
        const v = parsed[prop];
        if (isRecordArray(v)) skel[prop] = extractArray('pilotpro_v2.' + prop, v);
        else skel[prop] = v;                       // compteurs, réglages, tableaux sans id…
      }
      meta[key] = skel;
    } else if (isRecordArray(parsed)) {
      meta[key] = extractArray(key, parsed);
    } else if (isRecordDict(parsed)) {
      meta[key] = extractDict(key, parsed);
    } else {
      meta[key] = parsed;                          // scalaire / dict vide / tableau sans id
    }
  }
  return { toplevel, meta, tables };
}

/* ─── RECOMPOSITION ───
   À partir des tables Postgres + meta, reconstruit l'objet `keys` IDENTIQUE. */
function resolveRefs(node, loadTable) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    if (node.__rawString !== undefined) return { __raw: node.__rawString };
    if (node.__ref) {
      const rows = loadTable(node.__ref);            // [{id,ord,data}] triées par ord
      if (node.__kind === 'array') return rows.map(r => r.data);
      const o = {}; rows.forEach(r => { o[r.id] = r.data; }); return o;
    }
    const out = {};
    for (const k of Object.keys(node)) {
      const r = resolveRefs(node[k], loadTable);
      out[k] = (r && r.__raw !== undefined) ? r.__raw : r;
    }
    return out;
  }
  return node;
}

/* ════════════════════════════════════════════════════════════════
   Store : initialise le schéma, écrit (POST) et lit (GET) l'état.
   ════════════════════════════════════════════════════════════════ */
/* Tables système : jamais purgées par saveState, jamais exposées par readTable */
const RESERVED_TABLES = new Set(['pp_meta', 'pp_prix_journal']);

class PgStore {
  constructor(db) { this.db = db; this.knownTables = new Set(); }

  async init() {
    await this.db.query(`CREATE TABLE IF NOT EXISTS pp_meta (
      k text PRIMARY KEY, v jsonb, updated_at timestamptz DEFAULT now())`);
    await this.db.query(`INSERT INTO pp_meta(k,v) VALUES('__sys.rev','0')
      ON CONFLICT(k) DO NOTHING`);
    /* ✨ Journal des prix (modèle bancaire) : chaque changement de prix est une
       transaction horodatée, ordonnée par le serveur, jamais effacée. */
    await this.db.query(`CREATE TABLE IF NOT EXISTS pp_prix_journal (
      seq bigserial PRIMARY KEY,
      ts timestamptz DEFAULT now(),
      user_name text, order_id text, of_number text, field text,
      old_value double precision, new_value double precision, ip text)`);
  }

  /* ─── Journal des prix ─── */
  async addPriceTxs(user, txs, ip) {
    for (const t of txs) {
      await this.db.query(
        'INSERT INTO pp_prix_journal(user_name,order_id,of_number,field,old_value,new_value,ip) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [user || '', String(t.orderId), t.of || '', t.field, t.old == null ? null : +t.old, t.nw == null ? null : +t.nw, ip || '']);
    }
    return { count: txs.length };
  }
  async queryPrices(orderId, limit) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const r = orderId != null
      ? await this.db.query('SELECT seq,ts,user_name,order_id,of_number,field,old_value,new_value FROM pp_prix_journal WHERE order_id=$1 ORDER BY seq DESC LIMIT ' + lim, [String(orderId)])
      : await this.db.query('SELECT seq,ts,user_name,order_id,of_number,field,old_value,new_value FROM pp_prix_journal ORDER BY seq DESC LIMIT ' + lim);
    return r.rows.map(x => ({ seq: +x.seq, ts: x.ts, user: x.user_name, orderId: x.order_id, of: x.of_number, field: x.field, old: x.old_value == null ? null : +x.old_value, nw: x.new_value == null ? null : +x.new_value }));
  }

  async _ensureTable(name) {
    if (this.knownTables.has(name)) return;
    await this.db.query(`CREATE TABLE IF NOT EXISTS ${name} (
      id text PRIMARY KEY, ord int, data jsonb, updated_at timestamptz DEFAULT now())`);
    this.knownTables.add(name);
  }

  async getRev() {
    const r = await this.db.query("SELECT v FROM pp_meta WHERE k='__sys.rev'");
    return r.rows.length ? parseInt(JSON.parse(r.rows[0].v), 10) || 0 : 0;
  }

  /* Lit tout l'état et le renvoie au format attendu par le client. */
  async loadState() {
    const rev = await this.getRev();
    const metaRows = await this.db.query("SELECT k,v FROM pp_meta WHERE k NOT LIKE '__sys.%'");
    const metaMap = {}; metaRows.rows.forEach(r => { metaMap[r.k] = JSON.parse(r.v); });
    const tlRow = await this.db.query("SELECT v FROM pp_meta WHERE k='__sys.toplevel'");
    const toplevel = tlRow.rows.length ? JSON.parse(tlRow.rows[0].v) : Object.keys(metaMap);

    // cache de chargement des tables
    const cache = {};
    const loadTable = (name) => cache[name] || [];
    // pré-charge les tables référencées
    const refs = new Set();
    (function walk(n) {
      if (n && typeof n === 'object') {
        if (n.__ref) refs.add(n.__ref);
        else Object.keys(n).forEach(k => walk(n[k]));
      }
    })(metaMap);
    for (const name of refs) {
      const rows = await this.db.query(`SELECT id,ord,data FROM ${name} ORDER BY ord`);
      cache[name] = rows.rows.map(r => ({ id: r.id, ord: parseInt(r.ord, 10), data: JSON.parse(r.data) }));
    }

    const keys = {};
    for (const key of toplevel) {
      if (metaMap[key] === undefined) continue;
      const resolved = resolveRefs(metaMap[key], loadTable);
      keys[key] = (resolved && resolved.__raw !== undefined) ? resolved.__raw : JSON.stringify(resolved);
    }
    const up = await this.db.query("SELECT v FROM pp_meta WHERE k='__sys.updatedAt'");
    return { keys, rev, ts: rev, updatedAt: up.rows.length ? JSON.parse(up.rows[0].v) : null };
  }

  /* Écrit un nouvel état (POST). Transactionnel : tout ou rien.
     Retourne { rev }. */
  async saveState(keys, ts) {
    const { toplevel, meta, tables } = decompose(keys);
    // s'assure que toutes les tables existent AVANT la transaction
    for (const name of Object.keys(tables)) await this._ensureTable(name);

    const db = this.db;
    return await db.tx(async (c) => {
      // 1) compteur de révision
      const rr = await c.query("SELECT v FROM pp_meta WHERE k='__sys.rev' FOR UPDATE");
      const rev = (rr.rows.length ? parseInt(JSON.parse(rr.rows[0].v), 10) || 0 : 0) + 1;

      // 2) meta : squelettes + scalaires (on remplace tout l'ensemble meta applicatif)
      await c.query("DELETE FROM pp_meta WHERE k NOT LIKE '__sys.%'");
      for (const k of Object.keys(meta)) {
        await c.query('INSERT INTO pp_meta(k,v,updated_at) VALUES($1,$2::jsonb,now()) ' +
          'ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v, updated_at=now()', [k, JSON.stringify(meta[k])]);
      }
      await c.query("INSERT INTO pp_meta(k,v) VALUES('__sys.toplevel',$1::jsonb) " +
        "ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v", [JSON.stringify(toplevel)]);
      await c.query("UPDATE pp_meta SET v=$1::jsonb WHERE k='__sys.rev'", [JSON.stringify(rev)]);
      await c.query("INSERT INTO pp_meta(k,v) VALUES('__sys.updatedAt',$1::jsonb) " +
        "ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v", [JSON.stringify(new Date().toISOString())]);

      // 3) tables de fiches : upsert des lignes + suppression des disparues
      const seen = new Set(Object.keys(tables));
      for (const name of Object.keys(tables)) {
        const rows = tables[name].rows;
        const ids = rows.map(r => r.id);
        // supprime ce qui n'existe plus
        await c.query(`DELETE FROM ${name} WHERE NOT (id = ANY(SELECT jsonb_array_elements_text($1::jsonb)))`,
          [JSON.stringify(ids.length ? ids : [])]);
        // upsert par lots (multi-lignes) — ne touche updated_at que si la fiche change
        const CHUNK = 400;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const slice = rows.slice(i, i + CHUNK);
          const vals = []; const params = [];
          slice.forEach((r, j) => {
            const b = j * 3;
            vals.push(`($${b + 1},$${b + 2}::int,$${b + 3}::jsonb)`);
            params.push(r.id, r.ord, JSON.stringify(r.data));
          });
          await c.query(
            `INSERT INTO ${name}(id,ord,data) VALUES ${vals.join(',')} ` +
            `ON CONFLICT(id) DO UPDATE SET ord=EXCLUDED.ord, data=EXCLUDED.data, ` +
            `updated_at=CASE WHEN ${name}.data IS DISTINCT FROM EXCLUDED.data THEN now() ELSE ${name}.updated_at END`,
            params);
        }
      }
      // 4) purge des tables de fiches devenues vides (plus référencées)
      //    — les tables système (journal des prix, meta) ne sont JAMAIS purgées
      const existing = await c.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'pp_%' AND tablename<>'pp_meta'");
      for (const row of existing.rows) {
        if (!seen.has(row.tablename) && !RESERVED_TABLES.has(row.tablename)) await c.query(`DELETE FROM ${row.tablename}`);
      }
      return { rev };
    });
  }

  /* Liste des tables « module » disponibles pour l'app DBS. */
  async listTables() {
    const r = await this.db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'pp_%' AND tablename<>'pp_meta' AND tablename<>'pp_prix_journal' ORDER BY tablename");
    return r.rows.map(x => x.tablename);
  }
  async readTable(name) {
    if (!/^pp_[a-z0-9_]+$/.test(name) || RESERVED_TABLES.has(name)) throw new Error('table invalide');
    const r = await this.db.query(`SELECT id,data,updated_at FROM ${name} ORDER BY ord`);
    return r.rows.map(x => ({ id: x.id, updated_at: x.updated_at, ...JSON.parse(x.data) }));
  }
}

module.exports = { PgStore, decompose, resolveRefs, tableFor };
