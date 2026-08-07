/* ════════════════════════════════════════════════════════════════
   pgwire.js — Client PostgreSQL minimal en Node.js PUR (zéro dépendance)
   ----------------------------------------------------------------
   • Parle directement le protocole "frontend/backend" de PostgreSQL v3
   • Authentification : trust, mot de passe clair, MD5, SCRAM-SHA-256
     (SCRAM = ce qu'utilise Railway / PostgreSQL 14+ par défaut)
   • Requêtes paramétrées via le protocole étendu (Parse/Bind/Execute)
     → aucune injection SQL possible, les valeurs ne sont jamais
       concaténées dans le texte SQL.
   • Une connexion = une file d'attente de requêtes (simple et sûr pour
     la charge de PilotPro). Un petit pool est fourni au-dessus.

   Volontairement minimal : renvoie toutes les colonnes en TEXTE ;
   l'appelant fait JSON.parse() sur les colonnes jsonb. Suffisant et
   robuste pour notre usage (stockage de fiches JSON).
   ════════════════════════════════════════════════════════════════ */
'use strict';
const net    = require('net');
const tls    = require('tls');
const crypto = require('crypto');

/* ─── Petit lecteur de messages backend (buffer accumulé) ─── */
class Parser {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) { this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk; }
  /* Renvoie {type, body} ou null s'il manque des octets */
  next() {
    if (this.buf.length < 5) return null;
    const type = String.fromCharCode(this.buf[0]);
    const len  = this.buf.readUInt32BE(1);          // longueur SANS le type
    if (this.buf.length < 1 + len) return null;      // message incomplet
    const body = this.buf.slice(5, 1 + len);
    this.buf = this.buf.slice(1 + len);
    return { type, body };
  }
}

/* ─── Constructeur de messages frontend ─── */
function msg(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length + 4, 0);
  return type
    ? Buffer.concat([Buffer.from(type), len, body])
    : Buffer.concat([len, body]);                    // startup (pas de type)
}
function cstr(s) { return Buffer.concat([Buffer.from(String(s), 'utf8'), Buffer.from([0])]); }

/* ─── SCRAM-SHA-256 ─── */
function xor(a, b) { const o = Buffer.alloc(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i]; return o; }
function hmac(key, str) { return crypto.createHmac('sha256', key).update(str).digest(); }
function sha256(b) { return crypto.createHash('sha256').update(b).digest(); }

class Connection {
  constructor(cfg) {
    this.cfg = cfg;                 // {host, port, user, password, database, ssl}
    this.sock = null;
    this.parser = new Parser();
    this.queue = [];                // requêtes en attente
    this.current = null;            // requête en cours
    this.ready = false;
    this.connecting = null;
    this.serverParams = {};
    this.scram = null;
    this.onErr = null;
  }

  connect() {
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      this._resolveConn = resolve; this._rejectConn = reject;
      const { host, port, ssl } = this.cfg;
      const rawStart = () => {
        const plain = net.connect({ host, port: port || 5432 });
        plain.once('error', reject);
        if (ssl) {
          /* Demande SSL : envoyer SSLRequest (80877103) puis attendre 'S' */
          plain.once('connect', () => {
            const req = Buffer.alloc(8);
            req.writeUInt32BE(8, 0); req.writeUInt32BE(80877103, 4);
            plain.write(req);
          });
          plain.once('data', (d) => {
            if (d[0] === 0x53 /* 'S' */) {
              const secure = tls.connect({ socket: plain, servername: host,
                rejectUnauthorized: ssl.rejectUnauthorized !== false ? false : false });
              /* Railway/hébergeurs : certificats gérés côté plateforme → on
                 chiffre le transport sans exiger la chaîne CA (rejectUnauthorized:false). */
              secure.once('secureConnect', () => this._afterSocket(secure, resolve, reject));
              secure.once('error', reject);
            } else {
              reject(new Error('Le serveur PostgreSQL refuse SSL'));
            }
          });
        } else {
          plain.once('connect', () => this._afterSocket(plain, resolve, reject));
        }
      };
      rawStart();
    });
    return this.connecting;
  }

  _afterSocket(sock, resolve, reject) {
    this.sock = sock;
    sock.on('data', (d) => this._onData(d));
    sock.on('error', (e) => { if (this.current) { this.current.reject(e); this.current = null; } if (this.onErr) this.onErr(e); });
    sock.on('close', () => { this.ready = false; });
    /* StartupMessage : protocole 3.0 (196608) + user/database */
    const params = [];
    params.push(cstr('user'), cstr(this.cfg.user));
    if (this.cfg.database) params.push(cstr('database'), cstr(this.cfg.database));
    params.push(cstr('application_name'), cstr('pilotpro'));
    params.push(Buffer.from([0]));
    const proto = Buffer.alloc(4); proto.writeUInt32BE(196608, 0);
    sock.write(msg(null, Buffer.concat([proto, ...params])));
  }

  _send(buf) { this.sock.write(buf); }

  _onData(chunk) {
    this.parser.push(chunk);
    let m;
    while ((m = this.parser.next())) this._handle(m);
  }

  _handle(m) {
    const { type, body } = m;
    switch (type) {
      case 'R': return this._auth(body);
      case 'S': { /* ParameterStatus */
        let i = 0; const k = readCStr(body, i); i = k.end; const v = readCStr(body, k.end);
        this.serverParams[k.str] = v.str; return;
      }
      case 'K': return; /* BackendKeyData */
      case 'Z': /* ReadyForQuery : clôture la requête courante puis enchaîne */
        if (this.current) {
          const q = this.current; this.current = null;
          if (q.error) q.reject(q.error);
          else q.resolve({ rows: q.rows, rowCount: q.rows.length, tag: q.tag });
        }
        this.ready = true;
        if (this._resolveConn) { this._resolveConn(this); this._resolveConn = null; this._rejectConn = null; }
        this._drain();
        return;
      case 'T': return this._rowDesc(body);
      case 'D': return this._dataRow(body);
      case 'C': /* CommandComplete */
        if (this.current) this.current.tag = body.slice(0, body.length - 1).toString('utf8');
        return;
      case 'E': return this._error(body);
      case 'N': return; /* NoticeResponse : ignoré */
      case 'A': return; /* NotificationResponse : ignoré */
      case '1': case '2': case '3': case 'n': case 's': return; /* Parse/Bind/Close/NoData/PortalSuspended */
      case 't': return; /* ParameterDescription */
      case 'G': case 'H': case 'W': return; /* Copy* : non utilisé */
      default: return;
    }
  }

  /* ─── Authentification ─── */
  _auth(body) {
    const code = body.readUInt32BE(0);
    if (code === 0) return;                       // AuthenticationOk
    if (code === 3) {                             // Cleartext
      this._send(msg('p', cstr(this.cfg.password || '')));
      return;
    }
    if (code === 5) {                             // MD5
      const salt = body.slice(4, 8);
      const inner = crypto.createHash('md5').update((this.cfg.password || '') + this.cfg.user).digest('hex');
      const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
      this._send(msg('p', cstr('md5' + outer)));
      return;
    }
    if (code === 10) {                            // SASL : liste des mécanismes
      const mechs = body.slice(4).toString('utf8').split('\0').filter(Boolean);
      if (mechs.indexOf('SCRAM-SHA-256') < 0) { this._fatal('Mécanisme SASL non supporté: ' + mechs.join(',')); return; }
      const nonce = crypto.randomBytes(18).toString('base64');
      this.scram = { clientNonce: nonce, clientFirstBare: 'n=*,r=' + nonce };
      const clientFirst = 'n,,' + this.scram.clientFirstBare;
      const b = Buffer.concat([cstr('SCRAM-SHA-256'), int32(Buffer.byteLength(clientFirst)), Buffer.from(clientFirst)]);
      this._send(msg('p', b));
      return;
    }
    if (code === 11) {                            // SASLContinue (server-first)
      const serverFirst = body.slice(4).toString('utf8');
      const attrs = parseScram(serverFirst);
      const salt = Buffer.from(attrs.s, 'base64');
      const iter = parseInt(attrs.i, 10);
      const serverNonce = attrs.r;
      if (serverNonce.indexOf(this.scram.clientNonce) !== 0) { this._fatal('Nonce SCRAM invalide'); return; }
      const saltedPassword = crypto.pbkdf2Sync(this.cfg.password || '', salt, iter, 32, 'sha256');
      const clientKey = hmac(saltedPassword, 'Client Key');
      const storedKey = sha256(clientKey);
      const clientFinalNoProof = 'c=biws,r=' + serverNonce;
      const authMessage = this.scram.clientFirstBare + ',' + serverFirst + ',' + clientFinalNoProof;
      const clientSig = hmac(storedKey, authMessage);
      const clientProof = xor(clientKey, clientSig).toString('base64');
      const serverKey = hmac(saltedPassword, 'Server Key');
      this.scram.serverSignature = hmac(serverKey, authMessage).toString('base64');
      const clientFinal = clientFinalNoProof + ',p=' + clientProof;
      this._send(msg('p', Buffer.from(clientFinal)));
      return;
    }
    if (code === 12) {                            // SASLFinal (server-final)
      const attrs = parseScram(body.slice(4).toString('utf8'));
      if (attrs.v !== this.scram.serverSignature) { this._fatal('Signature serveur SCRAM invalide'); }
      return;
    }
    this._fatal('Méthode auth non supportée: ' + code);
  }

  _fatal(text) {
    const e = new Error(text);
    if (this._rejectConn) { this._rejectConn(e); this._rejectConn = null; }
    if (this.current) { this.current.reject(e); this.current = null; }
    try { this.sock.destroy(); } catch (x) {}
  }

  _error(body) {
    const fields = {}; let i = 0;
    while (i < body.length && body[i] !== 0) {
      const f = String.fromCharCode(body[i]); const r = readCStr(body, i + 1); fields[f] = r.str; i = r.end;
    }
    const e = new Error('PostgreSQL: ' + (fields.M || 'erreur') + (fields.C ? ' [' + fields.C + ']' : ''));
    e.pgCode = fields.C; e.pgFields = fields;
    if (this._rejectConn) { this._rejectConn(e); this._rejectConn = null; try { this.sock.destroy(); } catch (x) {} return; }
    if (this.current) this.current.error = e;      // sera rejeté au ReadyForQuery
  }

  _rowDesc(body) {
    const n = body.readUInt16BE(0); let i = 2; const cols = [];
    for (let c = 0; c < n; c++) {
      const r = readCStr(body, i); i = r.end;
      i += 18; // tableOID(4)+colAttr(2)+typeOID(4)+typeSize(2)+typeMod(4)+format(2)
      cols.push(r.str);
    }
    if (this.current) { this.current.cols = cols; this.current.rows = this.current.rows || []; }
  }

  _dataRow(body) {
    if (!this.current) return;
    const n = body.readUInt16BE(0); let i = 2; const row = {};
    const cols = this.current.cols || [];
    for (let c = 0; c < n; c++) {
      const len = body.readInt32BE(i); i += 4;
      if (len === -1) { row[cols[c]] = null; }
      else { row[cols[c]] = body.slice(i, i + len).toString('utf8'); i += len; }
    }
    this.current.rows.push(row);
  }

  /* ─── API publique ─── */
  query(text, params) {
    return new Promise((resolve, reject) => {
      this.queue.push({ text, params: params || [], resolve, reject, rows: [], cols: [], error: null });
      this._drain();
    });
  }

  _drain() {
    if (!this.ready || this.current || !this.queue.length) return;
    const q = this.queue.shift();
    this.current = q;
    /* Protocole étendu : Parse → Bind → Describe → Execute → Sync */
    const name = '';
    const parse = Buffer.concat([cstr(name), cstr(q.text), int16(0)]);
    const paramBufs = q.params.map(p => {
      if (p === null || p === undefined) return int32neg1();
      const s = Buffer.from(String(p), 'utf8');
      return Buffer.concat([int32(s.length), s]);
    });
    const bind = Buffer.concat([
      cstr(''),            // portal
      cstr(name),          // statement
      int16(0),            // 0 codes de format param → tous en texte
      int16(q.params.length),
      ...paramBufs,
      int16(0)             // 0 codes de format résultat → tous en texte
    ]);
    const describe = Buffer.concat([Buffer.from('P'), cstr('')]);
    const execute  = Buffer.concat([cstr(''), int32(0)]);   // 0 = illimité
    const out = Buffer.concat([
      msg('P', parse), msg('B', bind), msg('D', describe), msg('E', execute), msg('S', Buffer.alloc(0))
    ]);
    this._send(out);
  }

  end() { try { this._send(msg('X', Buffer.alloc(0))); } catch (e) {} try { this.sock.end(); } catch (e) {} }
}

/* ─── Helpers ─── */
function int16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n >>> 0, 0); return b; }
function int32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n | 0, 0); return b; }
function int32neg1() { const b = Buffer.alloc(4); b.writeInt32BE(-1, 0); return b; }
function readCStr(buf, i) { let j = i; while (j < buf.length && buf[j] !== 0) j++; return { str: buf.slice(i, j).toString('utf8'), end: j + 1 }; }
function parseScram(s) { const o = {}; s.split(',').forEach(kv => { const idx = kv.indexOf('='); o[kv.slice(0, idx)] = kv.slice(idx + 1); }); return o; }

/* ─── Parse d'une URL de connexion (DATABASE_URL Railway/Heroku) ─── */
function parseUrl(url) {
  const u = new URL(url);
  const ssl = /sslmode=require|sslmode=verify/.test(u.search) || u.searchParams.get('ssl') === 'true';
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 5432,
    user: decodeURIComponent(u.username || 'postgres'),
    password: decodeURIComponent(u.password || ''),
    database: (u.pathname || '/').slice(1) || 'postgres',
    ssl: ssl ? { rejectUnauthorized: false } : (u.hostname && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1' ? { rejectUnauthorized: false } : false)
  };
}

/* ─── Petit pool : reconnexion automatique, une connexion réutilisée ─── */
class Client {
  constructor(cfg) {
    this.cfg = typeof cfg === 'string' ? parseUrl(cfg) : cfg;
    this.conn = null;
    this.connectingP = null;
  }
  async _get() {
    if (this.conn && this.conn.ready) return this.conn;
    if (this.connectingP) return this.connectingP;
    this.connectingP = (async () => {
      const c = new Connection(this.cfg);
      c.onErr = () => { if (this.conn === c) { this.conn = null; } };
      await c.connect();
      this.conn = c; this.connectingP = null; return c;
    })();
    return this.connectingP;
  }
  async query(text, params) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {       // 1 reconnexion auto
      try { const c = await this._get(); return await c.query(text, params); }
      catch (e) {
        lastErr = e; this.conn = null; this.connectingP = null;
        if (e.pgCode) throw e;                              // erreur SQL réelle : ne pas retenter
      }
    }
    throw lastErr;
  }
  async tx(fn) {
    await this.query('BEGIN');
    try { const r = await fn(this); await this.query('COMMIT'); return r; }
    catch (e) { try { await this.query('ROLLBACK'); } catch (x) {} throw e; }
  }
  end() { if (this.conn) this.conn.end(); }
}

module.exports = { Client, Connection, parseUrl };
