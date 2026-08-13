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

  const proprietaire = {};                       // table → clé d'état qui la produit
  let _cle = null;
  function extractArray(source, arr) {
    const name = tableFor(source);
    tables[name] = { kind: 'array', rows: arr.map((el, i) => ({ id: String(el.id), ord: i, data: el })) };
    proprietaire[name] = _cle;
    return { __ref: name, __kind: 'array' };
  }
  function extractDict(source, dict) {
    const name = tableFor(source);
    const ks = Object.keys(dict);
    tables[name] = { kind: 'dict', rows: ks.map((k, i) => ({ id: k, ord: i, data: dict[k] })) };
    proprietaire[name] = _cle;
    return { __ref: name, __kind: 'dict' };
  }

  for (const key of toplevel) {
    _cle = key;
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
  return { toplevel, meta, tables, proprietaire };
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
/* comparaison de FOND : l'ordre des champs ne doit pas créer de faux écart */
function trierProfond(x) {
  if (Array.isArray(x)) return x.map(trierProfond);
  if (x && typeof x === 'object') {
    const o = {}; Object.keys(x).sort().forEach(k => { o[k] = trierProfond(x[k]); }); return o;
  }
  return x;
}
const RESERVED_TABLES = new Set(['pp_meta', 'pp_prix_journal', 'pp_state', 'pp_blobs', 'pp_snapshots', 'pp_rev_journal']);

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
    /* ✨ Magasin de fichiers (photos, pièces jointes) : les images vivent ICI,
       dans PostgreSQL — plus jamais dans le stockage limité du navigateur. */
    await this.db.query(`CREATE TABLE IF NOT EXISTS pp_blobs (
      cle text PRIMARY KEY, donnee text, h text, ts bigint)`);
    /* ✨ Instantanés de la base DANS PostgreSQL : survivent aux redéploiements
       Railway (le disque du conteneur, lui, est effacé à chaque déploiement). */
    await this.db.query(`CREATE TABLE IF NOT EXISTS pp_snapshots (
      name text PRIMARY KEY, ts bigint, taille int, donnees text)`);
    /* ✨ v6.2 — VÉRITÉ VERBATIM : l'état est stocké et servi TEL QUEL, octet
       pour octet (comme le mode fichier). Les tables pp_orders, pp_clients…
       restent alimentées comme PROJECTION de consultation, mais ne servent
       plus de source pour /api/state : la recomposition JSONB réordonnait
       les données et désynchronisait les fusions fines entre postes. */
    await this.db.query(`CREATE TABLE IF NOT EXISTS pp_state (
      k text PRIMARY KEY, val text, updated_at timestamptz DEFAULT now())`);
    /* ✨ v6.5 — JOURNAL DES RÉVISIONS avec CLÉ PRIMAIRE : chaque révision produite
       y est insérée dans la transaction qui la crée. Si deux transactions
       calculaient la même révision, la SECONDE serait REJETÉE PAR POSTGRESQL
       (violation de clé primaire) et annulée : une collision de révision est
       structurellement impossible, pas seulement improbable. */
    await this.db.query(`CREATE TABLE IF NOT EXISTS pp_rev_journal (
      rev bigint PRIMARY KEY, ts timestamptz DEFAULT now(), taille int)`);
  }

  /* ─── Autocontrôle de cohérence : la vérité verbatim et les projections
         racontent-elles la même histoire ? (exposé par /api/coherence) ─── */
  async verifierCoherence() {
    const rev = await this.getRev();
    const out = { rev, sceau: null, verbatim: {}, projection: {}, ecarts: [], ok: true };
    const vr = await this.db.query('SELECT k,val FROM pp_state');
    const verb = {};
    vr.rows.forEach(r => { if (r.k === '__rev') out.sceau = parseInt(r.val, 10); else verb[r.k] = r.val; });
    out.verbatim.cles = Object.keys(verb).length;
    out.sceauValide = (out.sceau === rev);
    if (!out.sceauValide) { out.ok = false; out.ecarts.push('sceau ' + out.sceau + ' ≠ révision ' + rev); }
    /* recomposition indépendante depuis les tables de fiches */
    const recompose = await this._loadRecompose(rev);
    out.projection.cles = Object.keys(recompose.keys).length;
    const canon = (t) => { try { return JSON.stringify(trierProfond(JSON.parse(t))); } catch (e) { return String(t); } };
    const toutes = new Set([...Object.keys(verb), ...Object.keys(recompose.keys)]);
    toutes.forEach(k => {
      const a = verb[k], b = recompose.keys[k];
      if (a === undefined) { out.ecarts.push(k + ' : absent de la vérité verbatim'); out.ok = false; return; }
      if (b === undefined) { out.ecarts.push(k + ' : absent des projections'); out.ok = false; return; }
      if (canon(a) !== canon(b)) { out.ecarts.push(k + ' : contenu différent (verbatim ' + a.length + ' o · projection ' + b.length + ' o)'); out.ok = false; }
    });
    return out;
  }

  /* ─── Instantanés ─── */
  async snapSave(name, donneesB64, taille) {
    await this.db.query(
      'INSERT INTO pp_snapshots(name,ts,taille,donnees) VALUES($1,$2,$3,$4) ON CONFLICT(name) DO NOTHING',
      [name, Date.now(), taille, donneesB64]);
  }
  async snapList() {
    const r = await this.db.query('SELECT name,ts,taille FROM pp_snapshots ORDER BY ts DESC LIMIT 400');
    return r.rows.map(x => ({ name: x.name, size: +x.taille || 0, mtime: new Date(+x.ts).toISOString() }));
  }
  async snapGet(name) {
    const r = await this.db.query('SELECT donnees FROM pp_snapshots WHERE name=$1', [name]);
    return r.rows.length ? r.rows[0].donnees : null;
  }
  async snapPrune() {
    await this.db.query(`DELETE FROM pp_snapshots WHERE name LIKE 'state-daily-%' AND name NOT IN
      (SELECT name FROM pp_snapshots WHERE name LIKE 'state-daily-%' ORDER BY ts DESC LIMIT 60)`);
    await this.db.query(`DELETE FROM pp_snapshots WHERE name NOT LIKE 'state-daily-%' AND name NOT IN
      (SELECT name FROM pp_snapshots WHERE name NOT LIKE 'state-daily-%' ORDER BY ts DESC LIMIT 240)`);
  }

  /* ─── Magasin de fichiers ─── */
  async blobSet(cle, donnee, h, ts) {
    if (donnee == null) {
      /* suppression = ligne-tombale (donnee NULL) : un ré-envoi plus ancien sera refusé */
      await this.db.query(
        'INSERT INTO pp_blobs(cle,donnee,h,ts) VALUES($1,NULL,NULL,$2) ON CONFLICT(cle) DO UPDATE SET donnee=NULL,h=NULL,ts=$2',
        [cle, Date.now()]);
      return { ok: true };
    }
    const r = await this.db.query(
      'INSERT INTO pp_blobs(cle,donnee,h,ts) VALUES($1,$2,$3,$4) ' +
      'ON CONFLICT(cle) DO UPDATE SET donnee=$2,h=$3,ts=$4 ' +
      'WHERE pp_blobs.donnee IS NOT NULL OR $4 >= pp_blobs.ts',
      [cle, donnee, h, +ts || Date.now()]);
    return { ok: true };
  }
  async blobGet(cle) {
    const r = await this.db.query('SELECT donnee FROM pp_blobs WHERE cle=$1 AND donnee IS NOT NULL', [cle]);
    return r.rows.length ? r.rows[0].donnee : null;
  }
  async blobIndex() {
    const r = await this.db.query('SELECT cle,h FROM pp_blobs WHERE donnee IS NOT NULL');
    const idx = {}; r.rows.forEach(x => { idx[x.cle] = x.h; });
    return idx;
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
    /* ✨ v6.3 : révision ET vérité verbatim lues dans la MÊME lecture atomique —
       un enregistrement concurrent ne peut plus se glisser entre les deux et
       faire croire à un sceau périmé. */
    const atomique = await this.db.lecture(async (c) => {
      const rr = await c.query("SELECT v FROM pp_meta WHERE k='__sys.rev'");
      const rev = rr.rows.length ? (parseInt(JSON.parse(rr.rows[0].v), 10) || 0) : 0;
      let rows = [];
      try { rows = (await c.query('SELECT k,val FROM pp_state')).rows; } catch (e) {}
      const maj = await c.query("SELECT v FROM pp_meta WHERE k='__sys.updatedAt'");
      return { rev, rows, updatedAt: maj.rows.length ? JSON.parse(maj.rows[0].v) : null };
    });
    const rev = atomique.rev;
    /* ✨ v6.2 : lecture VERBATIM (octet pour octet), SOUS CONDITION DE SCEAU.
       La recomposition depuis les tables reste le filet : migration depuis un
       ancien schéma, ou vérité verbatim périmée (déploiement mixte). */
    if (atomique.rows.length) {
      const keys = {}; let sceau = null;
      atomique.rows.forEach(r => { if (r.k === '__rev') sceau = parseInt(r.val, 10); else keys[r.k] = r.val; });
      if (sceau === rev && Object.keys(keys).length) {
        return { keys, rev, ts: rev, updatedAt: atomique.updatedAt };
      }
      console.warn('[COHERENCE] vérité verbatim périmée (sceau=' + sceau + ' révision=' + rev
        + ') → recomposition depuis les tables de fiches');
    }
    return await this._loadRecompose(rev);
  }

  /* Recomposition indépendante depuis les tables de fiches (filet + autocontrôle) */
  async _loadRecompose(rev) {
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
    /* ✨ v6.3 — GARDE ANTI-DESTRUCTION : un état VIDE n'est jamais destructeur.
       Il ne peut ni vider les tables de fiches, ni la vérité verbatim, ni les
       squelettes. On refuse l'opération plutôt que de détruire. */
    if (!keys || !Object.keys(keys).length) {
      const revActuelle = await this.getRev();
      console.warn('[GARDE] état vide reçu → aucune écriture (révision inchangée : ' + revActuelle + ')');
      const e = new Error('état vide refusé (protection anti-écrasement)');
      e.etatVide = true; e.rev = revActuelle; throw e;
    }
    const { toplevel, meta, tables, proprietaire } = decompose(keys);
    // s'assure que toutes les tables existent AVANT la transaction
    for (const name of Object.keys(tables)) await this._ensureTable(name);

    const db = this.db;
    return await db.tx(async (c) => {
      /* ═══ 1) COMPTEUR DE RÉVISION — ATOMICITÉ GARANTIE PAR POSTGRESQL ═══
         Le calcul n'est PLUS fait en JavaScript (lecture → +1 → écriture, qui
         permettait en théorie que deux transactions calculent la même valeur si
         la ligne compteur manquait). PostgreSQL fait lui-même lecture-incrément-
         écriture sous verrou de ligne dans UN SEUL ordre UPDATE … RETURNING :
         une transaction concurrente est mise en attente, puis relit la valeur
         RÉELLEMENT validée avant d'incrémenter. */
      await c.query("INSERT INTO pp_meta(k,v) VALUES('__sys.rev','0') ON CONFLICT(k) DO NOTHING");
      /* le compteur ne peut JAMAIS reculer : il repart au maximum déjà journalisé */
      await c.query("UPDATE pp_meta SET v = to_jsonb(GREATEST((v#>>'{}')::bigint, COALESCE((SELECT max(rev) FROM pp_rev_journal),0))) WHERE k='__sys.rev'");
      const rr = await c.query("UPDATE pp_meta SET v = to_jsonb(((v#>>'{}')::bigint + 1)) WHERE k='__sys.rev' RETURNING v");
      if (!rr.rows.length) throw new Error('compteur de révision introuvable');
      const rev = parseInt(JSON.parse(rr.rows[0].v), 10);
      /* filet dur : la clé primaire refuse tout doublon de révision. Une violation
         ici signifie que deux transactions ont produit le même numéro : la
         transaction est annulée par PostgreSQL, aucune donnée n'est écrite. */
      await c.query('INSERT INTO pp_rev_journal(rev, taille) VALUES($1,$2)', [rev, JSON.stringify(keys || {}).length]);

      // 2) meta : squelettes + scalaires (on remplace tout l'ensemble meta applicatif)
      await c.query("DELETE FROM pp_meta WHERE k NOT LIKE '__sys.%'");
      for (const k of Object.keys(meta)) {
        await c.query('INSERT INTO pp_meta(k,v,updated_at) VALUES($1,$2::jsonb,now()) ' +
          'ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v, updated_at=now()', [k, JSON.stringify(meta[k])]);
      }
      await c.query("INSERT INTO pp_meta(k,v) VALUES('__sys.toplevel',$1::jsonb) " +
        "ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v", [JSON.stringify(toplevel)]);
      await c.query("INSERT INTO pp_meta(k,v) VALUES('__sys.updatedAt',$1::jsonb) " +
        "ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v", [JSON.stringify(new Date().toISOString())]);
      if (rev % 500 === 0) { try { await c.query('DELETE FROM pp_rev_journal WHERE rev < $1', [rev - 5000]); } catch (e) {} }

      /* ✨ v6.5 — ÉCRITURE DIFFÉRENTIELLE DES PROJECTIONS.
         Une seule commande modifiée ne doit pas faire réécrire les 560 fiches
         des 26 tables (GPAO, Grand Livre, journal…). On compare la vérité
         verbatim déjà stockée : les clés INCHANGÉES gardent leurs tables
         telles quelles — la connexion est retenue bien moins longtemps. */
      /* on compare d'abord par EMPREINTE (12 petites lignes) au lieu de rapatrier
         1,5 Mo à chaque envoi ; le contenu n'est relu que pour les clés modifiées */
      const emp = {};
      try { (await c.query('SELECT k, md5(val) h FROM pp_state')).rows.forEach(r => { emp[r.k] = r.h; }); } catch (e) {}
      const md5 = (v) => require('crypto').createHash('md5').update(String(v)).digest('hex');
      const inchangees = new Set();
      Object.keys(keys || {}).forEach(k => { if (emp[k] !== undefined && emp[k] === md5(keys[k])) inchangees.add(k); });
      const ancien = {};
      const aRelire = Object.keys(keys || {}).filter(k => !inchangees.has(k) && emp[k] !== undefined);
      if (aRelire.length) {
        try { (await c.query('SELECT k,val FROM pp_state WHERE k = ANY(SELECT jsonb_array_elements_text($1::jsonb))', [JSON.stringify(aRelire)]))
          .rows.forEach(r => { ancien[r.k] = r.val; }); } catch (e) {}
      }
      /* Finesse supplémentaire : dans une clé modifiée (pilotpro_v2 contient 13
         collections), seules les COLLECTIONS réellement touchées sont réécrites.
         Modifier une commande ne fait plus réécrire clients, chaînes, factures… */
      const tablesIdentiques = new Set();
      try {
        const ancCles = {};
        Object.keys(keys || {}).forEach(k => { if (!inchangees.has(k) && ancien[k] !== undefined) ancCles[k] = ancien[k]; });
        if (Object.keys(ancCles).length) {
          const av = decompose(ancCles);
          Object.keys(av.tables).forEach(nom => {
            if (!tables[nom]) return;
            if (JSON.stringify(av.tables[nom].rows) === JSON.stringify(tables[nom].rows)) tablesIdentiques.add(nom);
          });
        }
      } catch (e) { /* au moindre doute : on réécrit tout (jamais de risque) */ }

      /* ═══ VÉRITÉ VERBATIM — source unique de /api/state ═══
         Écrite dans LA MÊME transaction que les projections pp_* : les deux
         représentations ne peuvent pas diverger (tout ou rien). */
      const clesEtat = Object.keys(keys || {});
      /* garde : un état vide n'efface jamais la vérité (protection anti-écrasement) */
      if (clesEtat.length) {
        await c.query('DELETE FROM pp_state WHERE k <> $1 AND NOT (k = ANY(SELECT jsonb_array_elements_text($2::jsonb)))',
          ['__rev', JSON.stringify(clesEtat)]);
        for (const k of clesEtat) {
          if (inchangees.has(k)) continue;          /* identique : rien à transmettre */
          await c.query('INSERT INTO pp_state(k,val) VALUES($1,$2) ' +
            'ON CONFLICT(k) DO UPDATE SET val=EXCLUDED.val, updated_at=now() WHERE pp_state.val IS DISTINCT FROM EXCLUDED.val',
            [k, String(keys[k])]);
        }
        /* ✨ SCEAU DE COHÉRENCE : la vérité verbatim porte le numéro de révision
           qui l'a produite. Si un serveur d'une AUTRE version écrivait l'état sans
           mettre à jour pp_state (déploiement mixte, retour arrière), le sceau ne
           correspondrait plus et la lecture basculerait automatiquement sur la
           recomposition depuis les tables — jamais de données périmées servies. */
        await c.query('INSERT INTO pp_state(k,val) VALUES($1,$2) ON CONFLICT(k) DO UPDATE SET val=EXCLUDED.val, updated_at=now()',
          ['__rev', String(rev)]);
      }

      // 3) tables de fiches : upsert des lignes + suppression des disparues
      const seen = new Set(Object.keys(tables));
      let tablesEcrites = 0, tablesIgnorees = 0;
      for (const name of Object.keys(tables)) {
        /* projection appartenant à une clé inchangée → rien à réécrire */
        if (inchangees.has(proprietaire[name]) || tablesIdentiques.has(name)) { tablesIgnorees++; continue; }
        tablesEcrites++;
        /* ✨ v6.1 : ceinture de sécurité — jamais deux lignes avec le même id dans
           un même envoi (PostgreSQL refuse : erreur 21000). On garde la dernière. */
        const _vu = new Map(); const _doublons = [];
        tables[name].rows.forEach(r => { if (_vu.has(String(r.id))) _doublons.push(String(r.id)); _vu.set(String(r.id), r); });
        const rows = [..._vu.values()];
        if (_doublons.length) {
          /* jamais bloquant, mais TOUJOURS journalisé : table, clé, ids, volumes */
          console.warn('[SYNC DEDUP] table=' + name + ' cle=id doublons=' + _doublons.length
            + ' ids=' + _doublons.slice(0, 10).join(',') + ' lignes=' + tables[name].rows.length + '→' + rows.length);
          try { this._journalDedup = (this._journalDedup || []); this._journalDedup.push({ ts: Date.now(), table: name, ids: _doublons.slice(0, 20), avant: tables[name].rows.length, apres: rows.length }); } catch (e) {}
        }
        const ids = rows.map(r => r.id);
        // supprime ce qui n'existe plus
        await c.query(`DELETE FROM ${name} WHERE NOT (id = ANY(SELECT jsonb_array_elements_text($1::jsonb)))`,
          [JSON.stringify(ids.length ? ids : [])]);
        // upsert par lots (multi-lignes) — ne touche updated_at que si la fiche change
        const CHUNK = 400;
        try {
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
        } catch (e) {
          /* ✨ v6.2 — DIAGNOSTIC FORENSIQUE : plus jamais d'« Erreur serveur » muette.
             On journalise la table, la clé de conflit, les doublons éventuels et
             les identifiants concernés, puis on relance l'erreur (la transaction
             sera annulée proprement — révision inchangée, aucune donnée perdue). */
          try {
            const compte = {}; rows.forEach(r => { compte[r.id] = (compte[r.id] || 0) + 1; });
            const dups = Object.keys(compte).filter(k => compte[k] > 1);
            console.error('[SYNC ERROR] table=' + name + ' cle_conflit=id code=' + (e.pgCode || '?')
              + ' doublons=' + dups.length + ' ids=' + dups.slice(0, 10).join(',')
              + ' lignes_lot=' + rows.length + ' message=' + String(e.message || e).slice(0, 160));
            e.syncTable = name; e.syncDups = dups.slice(0, 10);
          } catch (x) {}
          throw e;
        }
      }
      // 4) purge des tables de fiches devenues vides (plus référencées)
      //    — les tables système (journal des prix, meta) ne sont JAMAIS purgées
      this._derniereEcriture = { rev, tablesEcrites, tablesIgnorees, inchangees: inchangees.size };
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
