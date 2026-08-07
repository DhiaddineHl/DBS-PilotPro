'use strict';
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const PORT = 3999;
let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', m); } }
function sortKeys(o){if(Array.isArray(o))return o.map(sortKeys);if(o&&typeof o==='object'){const r={};Object.keys(o).sort().forEach(k=>r[k]=sortKeys(o[k]));return r;}return o;}
function deepEq(a,b){return JSON.stringify(sortKeys(a))===JSON.stringify(sortKeys(b));}

function req(method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method,
      headers: Object.assign({ 'Accept-Encoding': 'gzip' }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
      resp => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => {
          let buf = Buffer.concat(chunks);
          if (resp.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
          let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch (e) {}
          resolve({ status: resp.statusCode, body: j });
        });
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const seed = JSON.parse(fs.readFileSync('/root/seed_keys.json', 'utf8'));

  console.log('=== health (avant) ===');
  let h = await req('GET', '/api/health');
  ok(h.status === 200 && h.body.backend === 'postgres', 'health = postgres');

  console.log('=== POST état initial ===');
  let p = await req('POST', '/api/state', { keys: seed, ts: Date.now() });
  ok(p.status === 200 && p.body.ok && p.body.rev === 1, 'POST rev=1');

  console.log('=== GET + aller-retour identique (via gzip HTTP) ===');
  let g = await req('GET', '/api/state');
  ok(g.status === 200 && g.body.keys, 'GET état');
  let allEq = true;
  for (const k of Object.keys(seed)) {
    if (!deepEq(JSON.parse(seed[k]), JSON.parse(g.body.keys[k] || 'null'))) { allEq = false; console.log('   divergence', k); }
  }
  ok(allEq, 'toutes les clés identiques après aller-retour HTTP');

  console.log('=== endpoints DBS ===');
  let d = await req('GET', '/api/db');
  ok(d.status === 200 && d.body.tables.includes('pp_orders') && d.body.tables.includes('pp_grandlivre'), '/api/db liste les modules');
  let dt = await req('GET', '/api/db/pp_orders');
  const pv2 = JSON.parse(seed.pilotpro_v2);
  ok(dt.status === 200 && dt.body.count === pv2.orders.length, '/api/db/pp_orders = ' + pv2.orders.length + ' fiches');
  ok(dt.body.rows[0].updated_at && dt.body.rows[0].id != null, 'fiche DBS a id + updated_at');
  let bad = await req('GET', '/api/db/pp_meta');
  ok(bad.status === 400, 'pp_meta protégé (400)');

  console.log('=== garde anti-écrasement (409) ===');
  let conf = await req('POST', '/api/state', { keys: seed, ts: Date.now(), baseRev: 999 });
  ok(conf.status === 409 && conf.body.conflict, 'baseRev périmé → 409 conflit');
  let good = await req('POST', '/api/state', { keys: seed, ts: Date.now(), baseRev: 1 });
  ok(good.status === 200 && good.body.rev === 2, 'baseRev correct → accepté, rev=2');

  console.log('\n──────────────────────────────');
  console.log('  RÉSULTAT E2E : ' + pass + ' OK, ' + fail + ' échec(s)');
  console.log('──────────────────────────────');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('EXCEPTION', e); process.exit(1); });
