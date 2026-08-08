'use strict';
/* Test bout-en-bout du temps réel :
   - Poste A ouvre /api/events (flux SSE)
   - Poste B enregistre une modification (POST /api/state)
   - Poste A doit recevoir la nouvelle révision en < 1 seconde
   Plus : logique client (délai groupé, rev déjà vu ignoré). */
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const PORT = 3996;
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m); } }

function post(path, bodyObj) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(bodyObj));
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Accept-Encoding': 'gzip' } },
      resp => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => {
          let buf = Buffer.concat(chunks);
          if (resp.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
          resolve({ status: resp.statusCode, body: JSON.parse(buf.toString() || 'null') });
        });
      });
    r.on('error', reject); r.write(data); r.end();
  });
}

(async () => {
  console.log('═══ 1. Flux SSE : notification en < 1 s ═══');
  const events = [];
  let firstEventAt = 0, postAt = 0;
  await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/events', method: 'GET' }, resp => {
      ok(resp.statusCode === 200, 'flux ouvert (200)');
      ok(/text\/event-stream/.test(resp.headers['content-type'] || ''), 'Content-Type: text/event-stream');
      let buf = '';
      resp.on('data', ch => {
        buf += ch.toString();
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const m = block.match(/^data: (.*)$/m);
          if (m) { events.push({ at: Date.now(), data: JSON.parse(m[1]) }); if (!firstEventAt) firstEventAt = Date.now(); }
        }
      });
      resolve();
    });
    r.on('error', reject); r.end();
  });

  // attendre l'événement initial (rev courant envoyé à la connexion)
  await new Promise(r => setTimeout(r, 300));
  ok(events.length >= 1 && typeof events[0].data.rev === 'number', 'révision initiale reçue à la connexion (rev=' + (events[0] && events[0].data.rev) + ')');

  // Poste B enregistre
  const seed = { pilotpro_v2: JSON.stringify({ _v: 2, orders: [{ id: 1, prix_vente: 8.5 }] }) };
  const before = events.length;
  postAt = Date.now();
  const p = await post('/api/state', { keys: seed, ts: Date.now() });
  ok(p.status === 200 && p.body.ok, 'poste B : enregistrement accepté (rev=' + p.body.rev + ')');

  // Poste A doit recevoir la diffusion
  await new Promise(r => setTimeout(r, 600));
  const received = events.slice(before).find(e => e.data.rev === p.body.rev);
  ok(!!received, 'poste A : nouvelle révision reçue par le flux');
  if (received) {
    const delay = received.at - postAt;
    ok(delay < 1000, 'notification en ' + delay + ' ms (< 1 s)');
  }

  // Deuxième enregistrement → deuxième notification
  const before2 = events.length;
  const p2 = await post('/api/state', { keys: seed, ts: Date.now(), baseRev: p.body.rev });
  await new Promise(r => setTimeout(r, 500));
  ok(events.slice(before2).some(e => e.data.rev === p2.body.rev), 'deuxième enregistrement également diffusé (rev=' + p2.body.rev + ')');

  console.log('\n═══ 2. Logique client (délai groupé, rev déjà vu) ═══');
  {
    const html = fs.readFileSync('public/PilotPro.html', 'utf8');
    const m = html.match(/var esPullTimer=null;[\s\S]*?\n  \}\n\n  \/\* ── Démarrage/);
    ok(!!m, 'bloc startEvents extrait');
    const src = m[0].replace(/\n  \/\* ── Démarrage$/, '');
    const calls = { pull: 0, push: 0 };
    let handler = null;
    const ctx = {
      window: { EventSource: function (url) { ctx.__url = url; Object.defineProperty(this, 'onmessage', { set(f) { handler = f; } }); } },
      EventSource: null,
      S: { rev: 5, applying: false, dirty: false },
      push: () => { calls.push++; }, pull: () => { calls.pull++; },
      setTimeout: (fn) => { fn(); return 1; }, clearTimeout: () => {}
    };
    ctx.EventSource = ctx.window.EventSource;
    new Function(...Object.keys(ctx), src + '\nstartEvents();')(...Object.values(ctx));
    ok(ctx.__url === '/api/events', 'client se connecte à /api/events');
    ok(typeof handler === 'function', 'gestionnaire de messages installé');
    handler({ data: JSON.stringify({ rev: 5 }) });   // déjà vu
    ok(calls.pull === 0 && calls.push === 0, 'rev déjà vu (5≤5) → ignoré, aucun aller-retour');
    handler({ data: JSON.stringify({ rev: 6 }) });   // nouveau → pull
    ok(calls.pull === 1, 'rev nouveau + rien à envoyer → pull() déclenché');
    ctx.S.dirty = true;
    handler({ data: JSON.stringify({ rev: 7 }) });   // nouveau + modifs locales → push
    ok(calls.push === 1, 'rev nouveau + modifs locales → push() (le serveur fusionnera)');
    ctx.S.applying = true;
    handler({ data: JSON.stringify({ rev: 8 }) });
    ok(calls.pull === 1 && calls.push === 1, 'application en cours → événement ignoré (pas de collision)');
  }

  console.log('\n──────────────────────────────');
  console.log('  RÉSULTAT TEMPS RÉEL : ' + pass + ' OK, ' + fail + ' échec(s)');
  console.log('──────────────────────────────');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('EXCEPTION', e); process.exit(1); });
