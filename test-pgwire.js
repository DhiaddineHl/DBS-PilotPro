'use strict';
const { Client } = require('./pgwire');
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log('  ✗ FAIL:', m); } }
function deepEq(a,b){return JSON.stringify(sortKeys(a))===JSON.stringify(sortKeys(b));}
function sortKeys(o){if(Array.isArray(o))return o.map(sortKeys);if(o&&typeof o==='object'){const r={};Object.keys(o).sort().forEach(k=>r[k]=sortKeys(o[k]));return r;}return o;}

async function run(label, url) {
  console.log('\n=== ' + label + ' ===');
  const db = new Client(url);
  try {
    const r1 = await db.query("SELECT 1 AS n, 'héllo' AS s");
    ok(r1.rows[0].n === '1' && r1.rows[0].s === 'héllo', 'select scalaire + utf8');

    await db.query('DROP TABLE IF EXISTS t_test');
    await db.query('CREATE TABLE t_test (id text primary key, data jsonb, updated_at timestamptz default now())');

    // insertion paramétrée (anti-injection) avec du JSON
    const payload = { nom: "O'Brien; DROP TABLE", qte: 42, tailles: { S: 1, M: 2 }, accent: 'éàçü' };
    await db.query('INSERT INTO t_test(id,data) VALUES($1,$2::jsonb)', ['rec1', JSON.stringify(payload)]);
    const r2 = await db.query('SELECT data FROM t_test WHERE id=$1', ['rec1']);
    const back = JSON.parse(r2.rows[0].data);
    ok(deepEq(back, payload), 'roundtrip jsonb (deep-equal, injection-safe)');

    // upsert
    await db.query('INSERT INTO t_test(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', ['rec1', JSON.stringify({ v: 2 })]);
    const r3 = await db.query('SELECT data FROM t_test WHERE id=$1', ['rec1']);
    ok(JSON.parse(r3.rows[0].data).v === 2, 'upsert ON CONFLICT');

    // NULL + rowCount
    await db.query('INSERT INTO t_test(id,data) VALUES($1,$2)', ['rec2', null]);
    const r4 = await db.query('SELECT id,data FROM t_test ORDER BY id');
    ok(r4.rowCount === 2, 'rowCount = 2');
    ok(r4.rows[1].data === null, 'valeur NULL préservée');

    // transaction + rollback
    try {
      await db.tx(async (c) => {
        await c.query("INSERT INTO t_test(id,data) VALUES('rec3','{}')");
        throw new Error('boom');
      });
    } catch (e) { /* attendu */ }
    const r5 = await db.query("SELECT count(*) AS c FROM t_test WHERE id='rec3'");
    ok(r5.rows[0].c === '0', 'rollback transaction (rec3 absent)');

    // transaction commit
    await db.tx(async (c) => { await c.query("INSERT INTO t_test(id,data) VALUES('rec4','{\"ok\":true}')"); });
    const r6 = await db.query("SELECT count(*) AS c FROM t_test WHERE id='rec4'");
    ok(r6.rows[0].c === '1', 'commit transaction (rec4 présent)');

    // erreur SQL correctement remontée
    let threw = false;
    try { await db.query('SELECT * FROM table_inexistante_xyz'); } catch (e) { threw = !!e.pgCode; }
    ok(threw, 'erreur SQL remontée avec pgCode');

    // grosse charge : 300 insertions (simulate orders)
    const big = [];
    for (let i = 0; i < 300; i++) big.push(db.query('INSERT INTO t_test(id,data) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data', ['big' + i, JSON.stringify({ i })]));
    await Promise.all(big);
    const r7 = await db.query("SELECT count(*) AS c FROM t_test WHERE id LIKE 'big%'");
    ok(r7.rows[0].c === '300', '300 insertions concurrentes (file d\'attente)');

    await db.query('DROP TABLE t_test');
  } catch (e) {
    fail++; console.log('  ✗ EXCEPTION:', e.message);
  } finally { db.end(); }
}

(async () => {
  await run('TRUST (postgres)', 'postgresql://postgres@127.0.0.1:5433/pilotpro');
  await run('SCRAM-SHA-256 (app)', 'postgresql://app:secret123@127.0.0.1:5433/pilotpro');
  await run('MD5 (appmd5)', 'postgresql://appmd5:secret123@127.0.0.1:5433/pilotpro');
  console.log('\n──────────────────────────────');
  console.log('  RÉSULTAT : ' + pass + ' OK, ' + fail + ' échec(s)');
  console.log('──────────────────────────────');
  process.exit(fail ? 1 : 0);
})();
