'use strict';
const fs = require('fs');
const { Client } = require('./pgwire');
const { PgStore, decompose } = require('./pgstore');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', m); } }
function sortKeys(o) { if (Array.isArray(o)) return o.map(sortKeys); if (o && typeof o === 'object') { const r = {}; Object.keys(o).sort().forEach(k => r[k] = sortKeys(o[k])); return r; } return o; }
function deepEq(a, b) { return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b)); }

(async () => {
  const seed = JSON.parse(fs.readFileSync('/root/seed_keys.json', 'utf8'));
  const db = new Client('postgresql://postgres@127.0.0.1:5433/pilotpro');

  // DB propre
  const drop = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'pp_%'");
  for (const r of drop.rows) await db.query('DROP TABLE IF EXISTS ' + r.tablename + ' CASCADE');

  const store = new PgStore(db);
  await store.init();

  console.log('=== 1. Écriture initiale (vraies données) ===');
  const t0 = Date.now();
  const res1 = await store.saveState(seed, Date.now());
  console.log('   saveState en', Date.now() - t0, 'ms, rev =', res1.rev);
  ok(res1.rev === 1, 'rev = 1 après première écriture');

  console.log('=== 2. Aller-retour IDENTIQUE ===');
  const st = await store.loadState();
  const keys2 = st.keys;
  ok(Object.keys(keys2).length === Object.keys(seed).length, 'même nombre de clés top-level (' + Object.keys(seed).length + ')');
  let allEq = true;
  for (const k of Object.keys(seed)) {
    const a = JSON.parse(seed[k]); const b = JSON.parse(keys2[k] || 'null');
    const eq = deepEq(a, b);
    if (!eq) { allEq = false; console.log('   ✗ divergence sur', k); }
  }
  ok(allEq, 'toutes les clés recomposées à l\'identique (deep-equal)');

  console.log('=== 3. Tables par module présentes ===');
  const pv2 = JSON.parse(seed.pilotpro_v2);
  const tblOrders = await db.query('SELECT count(*) c FROM pp_orders');
  ok(parseInt(tblOrders.rows[0].c, 10) === pv2.orders.length, 'pp_orders = ' + pv2.orders.length + ' commandes');
  const tblClients = await db.query('SELECT count(*) c FROM pp_clients');
  ok(parseInt(tblClients.rows[0].c, 10) === pv2.clients.length, 'pp_clients = ' + pv2.clients.length + ' clients');
  const gl = JSON.parse(seed.dbs_grandlivre_2026_v2);
  const tblGl = await db.query('SELECT count(*) c FROM pp_grandlivre');
  ok(parseInt(tblGl.rows[0].c, 10) === gl.length, 'pp_grandlivre = ' + gl.length + ' comptes');
  const fac = JSON.parse(seed.dbs_overrides_2026);
  const tblFac = await db.query('SELECT count(*) c FROM pp_factures');
  ok(parseInt(tblFac.rows[0].c, 10) === Object.keys(fac).length, 'pp_factures = ' + Object.keys(fac).length + ' factures');

  console.log('=== 4. Fiche lisible directement (app DBS) ===');
  const one = await db.query("SELECT data FROM pp_orders WHERE id=$1", [String(pv2.orders[0].id)]);
  ok(one.rows.length === 1 && deepEq(JSON.parse(one.rows[0].data), pv2.orders[0]), 'commande #' + pv2.orders[0].id + ' lisible par id');
  const tables = await store.listTables();
  ok(tables.includes('pp_orders') && tables.includes('pp_grandlivre'), 'listTables expose les modules');
  const dbsView = await store.readTable('pp_orders');
  ok(dbsView.length === pv2.orders.length && dbsView[0].id != null, 'readTable(pp_orders) renvoie des fiches aplaties');

  console.log('=== 5. Mise à jour incrémentale (1 commande) ===');
  const upBefore = await db.query("SELECT updated_at FROM pp_orders ORDER BY ord");
  await new Promise(r => setTimeout(r, 1100));
  const pv2b = JSON.parse(seed.pilotpro_v2);
  pv2b.orders[5].note = 'MODIFIÉ PAR TEST ' + Date.now();
  const seedB = Object.assign({}, seed, { pilotpro_v2: JSON.stringify(pv2b) });
  const res2 = await store.saveState(seedB, Date.now());
  ok(res2.rev === 2, 'rev = 2 après 2e écriture');
  const upAfter = await db.query("SELECT id,updated_at FROM pp_orders ORDER BY ord");
  let changed = 0;
  for (let i = 0; i < upAfter.rows.length; i++) if (upAfter.rows[i].updated_at !== upBefore.rows[i].updated_at) changed++;
  ok(changed === 1, 'une seule fiche a un updated_at modifié (isolation par fiche), vu=' + changed);
  const st2 = await store.loadState();
  ok(deepEq(JSON.parse(st2.keys.pilotpro_v2).orders[5], pv2b.orders[5]), 'la modification est bien relue');

  console.log('=== 6. Suppression d\'une fiche ===');
  const pv2c = JSON.parse(seedB.pilotpro_v2);
  const removedId = String(pv2c.orders[0].id);
  pv2c.orders.splice(0, 1);
  await store.saveState(Object.assign({}, seed, { pilotpro_v2: JSON.stringify(pv2c) }), Date.now());
  const gone = await db.query("SELECT count(*) c FROM pp_orders WHERE id=$1", [removedId]);
  ok(gone.rows[0].c === '0', 'commande supprimée absente de pp_orders');
  const cnt = await db.query('SELECT count(*) c FROM pp_orders');
  ok(parseInt(cnt.rows[0].c, 10) === pv2c.orders.length, 'compte pp_orders = ' + pv2c.orders.length + ' après suppression');

  db.end();
  console.log('\n──────────────────────────────');
  console.log('  RÉSULTAT : ' + pass + ' OK, ' + fail + ' échec(s)');
  console.log('──────────────────────────────');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('EXCEPTION', e); process.exit(1); });
