"use strict";
// Servidor de Meliox: sin dependencias, solo Node.js.
// Uso:  node server.cjs   →  http://localhost:3001

const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const PORT = process.env.PORT || 3001;
const DB_FILE = path.join(__dirname, "data.json");
const PHONE_RE = /^3\d{9}$/;

// ---------- Iconos de la app (se generan al vuelo, sin archivos extra) ----------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const iconCache = {};
function makeIcon(S) {
  if (iconCache[S]) return iconCache[S];
  // Una "M" blanca sobre degradado verde
  const lx = 0.3 * S, rx = 0.7 * S, ty = 0.32 * S, by = 0.68 * S, mx = 0.5 * S, my = 0.56 * S;
  const half = 0.045 * S;
  const segs = [[lx, by, lx, ty], [lx, ty, mx, my], [mx, my, rx, ty], [rx, ty, rx, by]];
  const distSeg = (px, py, [x1, y1, x2, y2]) => {
    const dx = x2 - x1, dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };
  const stride = S * 4 + 1;
  const raw = Buffer.alloc(S * stride);
  for (let y = 0; y < S; y++) {
    const g = y / S;
    for (let x = 0; x < S; x++) {
      let r = 31 * g;
      let gr = 168 + 48 * g;
      let b = 132 + 32 * g;
      let cov = 0;
      for (const s of segs) {
        cov = Math.max(cov, Math.min(1, Math.max(0, half + 0.5 - distSeg(x + 0.5, y + 0.5, s))));
      }
      r += (255 - r) * cov; gr += (255 - gr) * cov; b += (255 - b) * cov;
      const o = y * stride + 1 + x * 4;
      raw[o] = r; raw[o + 1] = gr; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // 8 bits
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return (iconCache[S] = png);
}
const ICONS = { "/icon-192.png": 192, "/icon-512.png": 512, "/apple-touch-icon.png": 180 };

const MANIFEST = {
  name: "Meliox",
  short_name: "Meliox",
  description: "Chatea con tus amigos",
  start_url: "/",
  scope: "/",
  display: "standalone",
  lang: "es",
  background_color: "#0a1014",
  theme_color: "#111b21",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};

// ---------- Base de datos (archivo JSON) ----------
let db = { users: {}, requests: [], messages: [], sessions: {}, vapid: null };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
} catch {}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db), () => {}), 200);
}

// ---------- Notificaciones push (nativas: NO hay que instalar nada) ----------
// Implementa Web Push (RFC 8030 + 8291 + VAPID 8292) con el módulo crypto de Node.
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (str) => Buffer.from(str, "base64url");

let vapid = null; // { publicKey: base64url (65 bytes), privateKey: KeyObject }
function initVapid() {
  // Si defines VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY (en Render: Environment) las llaves no se pierden al reiniciar.
  let pubB64 = process.env.VAPID_PUBLIC_KEY;
  let privB64 = process.env.VAPID_PRIVATE_KEY;
  let fromEnv = !!(pubB64 && privB64);
  if (!fromEnv && db.vapid && db.vapid.publicKey && db.vapid.privateKey) {
    pubB64 = db.vapid.publicKey;
    privB64 = db.vapid.privateKey;
  }
  if (!pubB64 || !privB64) {
    const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = privateKey.export({ format: "jwk" });
    pubB64 = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
    privB64 = jwk.d;
    db.vapid = { publicKey: pubB64, privateKey: privB64 };
    save();
  }
  const pubRaw = unb64u(pubB64);
  const privateKey = crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: privB64, x: b64u(pubRaw.subarray(1, 33)), y: b64u(pubRaw.subarray(33, 65)) },
    format: "jwk",
  });
  vapid = { publicKey: pubB64, privateKey, fromEnv, privB64 };
}
initVapid();

function vapidHeader(endpoint) {
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: process.env.VAPID_SUBJECT || process.env.RENDER_EXTERNAL_URL || "mailto:meliox@example.com",
  }));
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key: vapid.privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// Cifrado del mensaje (aes128gcm). `fixed` solo se usa en pruebas.
function encryptPayload(sub, payload, fixed) {
  const uaPub = unb64u(sub.keys.p256dh);
  const auth = unb64u(sub.keys.auth);
  const ecdh = (fixed && fixed.ecdh) || crypto.createECDH("prime256v1");
  if (!fixed || !fixed.ecdh) ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPub);
  const salt = (fixed && fixed.salt) || crypto.randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const enc = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPub.length;
  return Buffer.concat([header, asPub, enc]);
}

function sendWebPush(sub, payload, { ttl = 86400, urgency = "high" } = {}) {
  return new Promise((resolve, reject) => {
    let body, u;
    try { body = encryptPayload(sub, payload); u = new URL(sub.endpoint); } catch (e) { return reject(e); }
    const req = https.request({
      method: "POST",
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      timeout: 15000,
      headers: {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
        TTL: String(ttl),
        Urgency: urgency,
        Authorization: vapidHeader(sub.endpoint),
      },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode });
        else reject(Object.assign(new Error(d.slice(0, 200) || "HTTP " + res.statusCode), { statusCode: res.statusCode }));
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("tiempo agotado")));
    req.end(body);
  });
}

// ---------- Utilidades ----------
const clients = new Map(); // teléfono -> Set de respuestas SSE

function push(phone, event, data = {}) {
  for (const res of clients.get(phone) || []) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// Avisa a los celulares/navegadores de `to` que `from` le escribió.
// Devuelve un resultado por dispositivo: [{ ok, status, error }]
async function sendPush(to, from, text, extra = {}, opts = {}) {
  const results = [];
  if (!to || !to.push || !to.push.length) return results;
  const payload = JSON.stringify({
    title: from.name,
    body: text.length > 140 ? text.slice(0, 137) + "…" : text,
    phone: from.phone,
    tag: "chat-" + from.phone,
    ...extra,
  });
  for (const sub of [...to.push]) {
    try {
      const r = await sendWebPush(sub, payload, opts);
      results.push({ ok: true, status: r.status });
    } catch (e) {
      results.push({ ok: false, status: e.statusCode, error: e.message });
      if (e.statusCode === 404 || e.statusCode === 410) {
        // Ese dispositivo ya no existe: lo quito de la lista
        to.push = to.push.filter((s) => s.endpoint !== sub.endpoint);
        save();
      } else {
        console.error("push falló:", e.statusCode || "", e.message);
      }
    }
  }
  return results;
}

// Señales de llamadas (WebRTC): se guardan unos segundos hasta que el destinatario las recoge
const signals = new Map(); // teléfono -> [{from, type, id, data, video, ts}]
const SIGNAL_TTL = 60000;
const SIGNAL_TYPES = new Set(["offer", "answer", "ice", "end", "reject", "busy"]);

const pub = (u) => ({ phone: u.phone, name: u.name, photo: u.photo });
const hashPass = (pass, salt) => crypto.scryptSync(pass, salt, 32).toString("hex");

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 2_000_000) {
        reject(Object.assign(new Error("Archivo demasiado grande"), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(Object.assign(new Error("Datos inválidos"), { status: 400 })); }
    });
  });
}

function authUser(req, url) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
  const phone = token && db.sessions[token];
  return phone ? db.users[phone] || null : null;
}

function newSession(phone) {
  const token = crypto.randomBytes(24).toString("hex");
  db.sessions[token] = phone;
  save();
  return token;
}

const between = (m, a, b) => (m.from === a && m.to === b) || (m.from === b && m.to === a);

function summary(user) {
  const friends = user.friends.flatMap((p) => {
    const f = db.users[p];
    if (!f) return [];
    const msgs = db.messages.filter((m) => between(m, user.phone, p));
    return [{
      ...pub(f),
      last: msgs[msgs.length - 1] || null,
      unread: msgs.filter((m) => m.from === p && !m.read).length,
    }];
  });
  const incoming = db.requests
    .filter((r) => r.to === user.phone)
    .flatMap((r) => (db.users[r.from] ? [pub(db.users[r.from])] : []));
  const outgoing = db.requests.filter((r) => r.from === user.phone).map((r) => r.to);
  return { friends, incoming, outgoing };
}

// ---------- API ----------
async function api(req, res, url, p) {
  const m = req.method;

  if (m === "POST" && p === "/api/register") {
    const { name, phone, password, photo } = await readBody(req);
    const n = String(name || "").trim();
    if (n.length < 2 || n.length > 30) fail(400, "El nombre debe tener entre 2 y 30 letras.");
    if (!PHONE_RE.test(String(phone || ""))) fail(400, "El número debe empezar con 3 y tener exactamente 10 dígitos.");
    if (String(password || "").length < 6) fail(400, "La contraseña debe tener mínimo 6 caracteres.");
    if (typeof photo !== "string" || !photo.startsWith("data:image/") || photo.length > 600_000) {
      fail(400, "Foto no válida.");
    }
    if (db.users[phone]) fail(409, "Ese número ya está registrado.");
    const salt = crypto.randomBytes(16).toString("hex");
    db.users[phone] = { phone, name: n, photo, salt, hash: hashPass(password, salt), friends: [] };
    const token = newSession(phone);
    save();
    return json(res, 200, { token, me: pub(db.users[phone]) });
  }

  if (m === "POST" && p === "/api/login") {
    const { phone, password } = await readBody(req);
    const user = db.users[String(phone || "")];
    if (!user) fail(400, "Número o contraseña incorrectos.");
    const a = Buffer.from(hashPass(String(password || ""), user.salt), "hex");
    const b = Buffer.from(user.hash, "hex");
    if (!crypto.timingSafeEqual(a, b)) fail(400, "Número o contraseña incorrectos.");
    return json(res, 200, { token: newSession(phone), me: pub(user) });
  }

  const user = authUser(req, url);
  if (!user) fail(401, "Sesión no válida.");

  if (m === "GET" && p === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 3000\n\nevent: ready\ndata: {}\n\n");
    if (!clients.has(user.phone)) clients.set(user.phone, new Set());
    clients.get(user.phone).add(res);
    req.on("close", () => clients.get(user.phone)?.delete(res));
    return;
  }

  if (m === "GET" && p === "/api/me") {
    return json(res, 200, { me: pub(user), ...summary(user) });
  }

  if (m === "GET" && p === "/api/push/key") {
    return json(res, 200, { key: vapid.publicKey });
  }

  if (m === "POST" && p === "/api/push/subscribe") {
    const { subscription: s } = await readBody(req);
    const ok =
      s && typeof s.endpoint === "string" && s.endpoint.startsWith("https://") && s.endpoint.length < 1000 &&
      s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string";
    if (!ok) fail(400, "Suscripción no válida.");
    // Un dispositivo pertenece a una sola persona: lo quito de cualquier otra cuenta
    for (const u of Object.values(db.users)) {
      if (u.push) u.push = u.push.filter((x) => x.endpoint !== s.endpoint);
    }
    user.push = [
      ...(user.push || []),
      { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
    ].slice(-5);
    save();
    return json(res, 200, { ok: true });
  }

  if (m === "POST" && p === "/api/push/unsubscribe") {
    const { endpoint } = await readBody(req);
    user.push = (user.push || []).filter((x) => x.endpoint !== endpoint);
    save();
    return json(res, 200, { ok: true });
  }

  if (m === "POST" && p === "/api/push/test") {
    if (!user.push || !user.push.length) fail(400, "Este dispositivo todavía no está suscrito.");
    // Espera 5 s para que alcances a minimizar la app y veas la notificación
    await new Promise((r) => setTimeout(r, 5000));
    const results = await sendPush(user, { name: "Meliox", phone: "" }, "¡Las notificaciones funcionan! 🎉", { tag: "test" });
    const good = results.filter((r) => r.ok).length;
    if (!good) {
      const bad = results[0] || {};
      fail(502, "El servicio de notificaciones del celular rechazó el envío (" + (bad.status || bad.error || "sin respuesta") + ").");
    }
    return json(res, 200, { ok: true, sent: good });
  }

  if (m === "GET" && p === "/api/signals") {
    const now = Date.now();
    const list = (signals.get(user.phone) || []).filter((x) => now - x.ts < SIGNAL_TTL);
    signals.delete(user.phone);
    return json(res, 200, list.map((x) => ({ ...x, age: now - x.ts })));
  }

  if (m === "POST" && p === "/api/call/signal") {
    const { to, type, id, data, video, missed } = await readBody(req);
    if (!user.friends.includes(to)) fail(403, "No son amigos todavía.");
    if (!SIGNAL_TYPES.has(type)) fail(400, "Señal no válida.");
    if (typeof id !== "string" || id.length > 64) fail(400, "Llamada no válida.");
    if (data !== undefined && JSON.stringify(data).length > 30000) fail(400, "Señal demasiado grande.");
    const q = (signals.get(to) || []).filter((x) => Date.now() - x.ts < SIGNAL_TTL);
    q.push({ from: user.phone, type, id, data, video: !!video, ts: Date.now() });
    signals.set(to, q.slice(-60));
    push(to, "signal");
    const target = db.users[to];
    if (type === "offer") {
      // Suena en el celular aunque la app esté cerrada
      sendPush(target, user, video ? "🎥 Videollamada entrante" : "📞 Llamada entrante",
        { type: "call", tag: "call-" + user.phone }, { ttl: 30 });
    } else if (type === "end" && missed) {
      sendPush(target, user, "📞 Llamada perdida", { type: "missed", tag: "call-" + user.phone });
    }
    return json(res, 200, { ok: true });
  }

  if (m === "POST" && p === "/api/profile") {
    const { name, photo } = await readBody(req);
    let newName = user.name;
    let newPhoto = user.photo;
    if (name !== undefined) {
      newName = String(name).trim();
      if (newName.length < 2 || newName.length > 30) fail(400, "El nombre debe tener entre 2 y 30 letras.");
    }
    if (photo !== undefined) {
      if (typeof photo !== "string" || !photo.startsWith("data:image/") || photo.length > 600_000) {
        fail(400, "Foto no válida.");
      }
      newPhoto = photo;
    }
    user.name = newName;
    user.photo = newPhoto;
    save();
    // Avisa a amigos, a quienes tienen una solicitud mía y a mis otras pestañas
    const notify = new Set([
      ...user.friends,
      ...db.requests.filter((r) => r.from === user.phone).map((r) => r.to),
      user.phone,
    ]);
    for (const phone of notify) push(phone, "friends");
    return json(res, 200, { me: pub(user) });
  }

  if (m === "POST" && p === "/api/friends/request") {
    const { phone } = await readBody(req);
    if (!PHONE_RE.test(String(phone || ""))) fail(400, "Número no válido: empieza con 3 y tiene 10 dígitos.");
    if (phone === user.phone) fail(400, "Ese es tu propio número.");
    const target = db.users[phone];
    if (!target) fail(404, "Ese número todavía no está en Meliox.");
    if (user.friends.includes(phone)) fail(409, "Ya son amigos.");
    if (db.requests.some((r) => r.from === user.phone && r.to === phone)) fail(409, "Ya enviaste una solicitud a esta persona.");

    // Si la otra persona ya te había enviado solicitud, se aceptan directo
    const reverse = db.requests.findIndex((r) => r.from === phone && r.to === user.phone);
    if (reverse >= 0) {
      db.requests.splice(reverse, 1);
      user.friends.push(phone);
      target.friends.push(user.phone);
      save();
      push(phone, "friends");
      return json(res, 200, { status: "accepted", name: target.name });
    }
    db.requests.push({ from: user.phone, to: phone });
    save();
    push(phone, "friends");
    return json(res, 200, { status: "sent", name: target.name });
  }

  if (m === "POST" && p === "/api/friends/respond") {
    const { phone, accept } = await readBody(req);
    const i = db.requests.findIndex((r) => r.from === phone && r.to === user.phone);
    if (i < 0) fail(404, "Solicitud no encontrada.");
    db.requests.splice(i, 1);
    if (accept && db.users[phone]) {
      if (!user.friends.includes(phone)) user.friends.push(phone);
      if (!db.users[phone].friends.includes(user.phone)) db.users[phone].friends.push(user.phone);
    }
    save();
    push(phone, "friends");
    return json(res, 200, { ok: true });
  }

  if (m === "POST" && p === "/api/friends/remove") {
    const { phone } = await readBody(req);
    if (!user.friends.includes(phone)) fail(404, "Esa persona no está en tus amigos.");
    user.friends = user.friends.filter((x) => x !== phone);
    const other = db.users[phone];
    if (other) other.friends = other.friends.filter((x) => x !== user.phone);
    db.requests = db.requests.filter(
      (r) => !((r.from === user.phone && r.to === phone) || (r.from === phone && r.to === user.phone))
    );
    save();
    push(phone, "friends");
    push(user.phone, "friends");
    return json(res, 200, { ok: true });
  }

  if (m === "GET" && p === "/api/messages") {
    const other = url.searchParams.get("with");
    if (!user.friends.includes(other)) fail(403, "No son amigos todavía.");
    let changed = false;
    const list = [];
    for (const msg of db.messages) {
      if (!between(msg, user.phone, other)) continue;
      if (msg.to === user.phone && !msg.read) { msg.read = true; changed = true; }
      list.push(msg);
    }
    if (changed) { save(); push(other, "read", { by: user.phone }); }
    return json(res, 200, list.slice(-300));
  }

  if (m === "POST" && p === "/api/messages") {
    const { to, text } = await readBody(req);
    if (!user.friends.includes(to)) fail(403, "No son amigos todavía.");
    const t = String(text || "").trim();
    if (!t || t.length > 2000) fail(400, "Mensaje vacío o demasiado largo.");
    const msg = { id: crypto.randomUUID(), from: user.phone, to, text: t, ts: Date.now(), read: false };
    db.messages.push(msg);
    save();
    push(to, "newmsg", { from: user.phone });
    sendPush(db.users[to], user, t); // notificación al celular (no espera respuesta)
    push(user.phone, "friends"); // sincroniza otras pestañas mías
    return json(res, 200, msg);
  }

  fail(404, "No encontrado.");
}

// ---------- Archivos estáticos ----------
const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
};

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p.startsWith("/api/")) {
    try { await api(req, res, url, p); }
    catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : "Error del servidor." });
      if (!e.status) console.error(e);
    }
    return;
  }

  if (p === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }

  if (p === "/manifest.webmanifest") {
    res.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8" });
    return res.end(JSON.stringify(MANIFEST));
  }
  if (ICONS[p]) {
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    return res.end(makeIcon(ICONS[p]));
  }

  const file = FILES[p];
  if (!file) { res.writeHead(404); return res.end("No encontrado"); }
  fs.readFile(path.join(__dirname, file[0]), (err, data) => {
    if (err) { res.writeHead(404); return res.end("No encontrado"); }
    const headers = { "Content-Type": file[1] };
    if (p === "/sw.js") headers["Cache-Control"] = "no-cache"; // el service worker siempre fresco
    res.writeHead(200, headers);
    res.end(data);
  });
});

// Mantiene vivas las conexiones en tiempo real
setInterval(() => {
  for (const set of clients.values()) for (const res of set) res.write(": ping\n\n");
}, 25000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\nMeliox listo en http://localhost:${PORT}`);
  console.log("Notificaciones push: activas (sin instalar nada)");
  if (!vapid.fromEnv) {
    console.log("Consejo (Render): para que las llaves de notificaciones no se pierdan al reiniciar, crea estas dos variables en Environment:");
    console.log("  VAPID_PUBLIC_KEY  = " + vapid.publicKey);
    console.log("  VAPID_PRIVATE_KEY = " + vapid.privB64);
  }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === "IPv4" && !i.internal) console.log(`Desde otro celular en tu Wi-Fi: http://${i.address}:${PORT}`);
    }
  }
  console.log("");
});

module.exports = { encryptPayload, vapidHeader, initVapid };
