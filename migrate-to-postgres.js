/* ════════════════════════════════════════════════════════════════
   migrate-to-postgres.js — Importe l'état PilotPro existant dans PostgreSQL
   ----------------------------------------------------------------
   Utilisation :
     DATABASE_URL="postgresql://..."  node migrate-to-postgres.js <fichier.json>

   <fichier.json> peut être :
     • le state.json actuel du serveur            ( { "keys": {...}, "rev": .. } )
     • une sauvegarde téléchargée depuis l'app     ( { "_app":"PilotPro", "keys": {...} } )
     • un export /api/state                        ( { "keys": {...} } )

   Le script :
     1. lit le fichier et en extrait le bloc `keys`
     2. l'écrit dans PostgreSQL (décomposé en tables par module)
     3. RELIT depuis PostgreSQL et vérifie que TOUT est identique (zéro perte)
        → si une seule fiche diffère, il le signale et sort en erreur.

   Ajoutez --dry-run pour seulement analyser le fichier sans rien écrire.
   ════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const { Client } = require('./pgwire');
const { PgStore } = require('./pgstore');

function sortKeys(o){if(Array.isArray(o))return o.map(sortKeys);if(o&&typeof o==='object'){const r={};Object.keys(o).sort().forEach(k=>r[k]=sortKeys(o[k]));return r;}return o;}
function deepEq(a,b){return JSON.stringify(sortKeys(a))===JSON.stringify(sortKeys(b));}

(async () => {
  const file = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'));
  const dry = process.argv.includes('--dry-run');
  if (!file) { console.error('Usage : DATABASE_URL=... node migrate-to-postgres.js <fichier.json> [--dry-run]'); process.exit(2); }
  if (!fs.existsSync(file)) { console.error('Fichier introuvable : ' + file); process.exit(2); }

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const keys = raw.keys || raw;                 // accepte {keys:{}} ou directement l'objet keys
  if (!keys || typeof keys !== 'object' || !keys.pilotpro_v2) {
    console.error('Ce fichier ne contient pas de bloc « keys » valide (clé pilotpro_v2 absente).'); process.exit(2);
  }

  // Résumé de ce qui va être importé
  console.log('\n── Contenu détecté ──');
  let totalFiches = 0;
  try {
    const pv2 = JSON.parse(keys.pilotpro_v2);
    const show = (n, arr) => { if (Array.isArray(arr)) { console.log('   ' + n.padEnd(14), arr.length); totalFiches += arr.length; } };
    show('commandes', pv2.orders); show('clients', pv2.clients); show('façonniers', pv2.faconniers);
    show('tissus', pv2.tissus); show('BR', pv2.brs); show('coupes', pv2.coupes);
    for (const k of Object.keys(keys)) if (k !== 'pilotpro_v2') {
      try { const v = JSON.parse(keys[k]); const n = Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 1); console.log('   ' + k.padEnd(24), n); } catch (e) {}
    }
  } catch (e) { console.warn('   (analyse partielle : ' + e.message + ')'); }

  if (dry) { console.log('\n--dry-run : rien n\'a été écrit.'); process.exit(0); }

  const dburl = process.env.DATABASE_URL;
  if (!dburl) { console.error('\nDATABASE_URL non définie. Exportez-la avant de lancer le script.'); process.exit(2); }

  console.log('\n── Écriture dans PostgreSQL ──');
  const db = new Client(dburl);
  const store = new PgStore(db);
  await store.init();
  const t0 = Date.now();
  const r = await store.saveState(keys, Date.now());
  console.log('   OK — rev = ' + r.rev + ' en ' + (Date.now() - t0) + ' ms');

  console.log('\n── Vérification zéro-perte (relecture) ──');
  const back = await store.loadState();
  let bad = 0;
  for (const k of Object.keys(keys)) {
    if (!deepEq(JSON.parse(keys[k]), JSON.parse(back.keys[k] || 'null'))) { bad++; console.error('   ✗ DIVERGENCE sur « ' + k + ' »'); }
  }
  for (const k of Object.keys(back.keys)) if (!(k in keys)) { bad++; console.error('   ✗ clé en trop : ' + k); }
  db.end();

  if (bad === 0) {
    console.log('   ✓ Vérifié : les ' + totalFiches + ' fiches et tous les blocs sont identiques après import.');
    console.log('\n✅ Migration réussie. PostgreSQL est prêt et partageable avec l\'app DBS.');
    process.exit(0);
  } else {
    console.error('\n❌ ' + bad + ' divergence(s) détectée(s) — NE PAS basculer en production, prévenez le développeur.');
    process.exit(1);
  }
})().catch(e => { console.error('ERREUR :', e.message); process.exit(1); });
