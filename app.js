// ===================== Meliox =====================
const $ = (s) => document.querySelector(s);

const API = location.hostname.includes("onrender.com")
  ? ""
  : (location.port === "3001" ? "" : `http://${location.hostname}:3001`);

const PHONE_REGEX = /^3\d{9}$/;

function phoneError(value) {
  if (!value) return "Escribe tu número de celular.";
  if (value[0] !== "3") return "El número debe empezar con 3.";
  if (value.length < 10) return "Faltan dígitos: el número debe tener exactamente 10.";
  if (value.length > 10) return "Sobran dígitos: el número debe tener exactamente 10.";
  if (!PHONE_REGEX.test(value)) return "Número no válido.";
  return "";
}
const cleanPhoneInput = (input) => (input.value = input.value.replace(/\D/g, "").slice(0, 10));

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const kid of kids) el.append(kid instanceof Node ? kid : document.createTextNode(kid));
  return el;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

function dayLabel(ts) {
  const now = Date.now();
  if (sameDay(ts, now)) return "Hoy";
  if (sameDay(ts, now - 86400000)) return "Ayer";
  return new Date(ts).toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric" });
}

function listTime(ts) {
  const now = Date.now();
  if (sameDay(ts, now)) return fmtTime(ts);
  if (sameDay(ts, now - 86400000)) return "Ayer";
  return new Date(ts).toLocaleDateString("es-CO", { day: "2-digit", month: "2-digit" });
}

let token = localStorage.getItem("meliox_token");
let me = null;
let friends = [];
let incoming = [];
let current = null;
let msgs = [];
let es = null;
let longPressed = false;
let longTimer = null;
let swReg = null;
let pushActive = false;

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error("No se pudo conectar con el servidor.");
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401 && token) logout();
    throw new Error(data.error || "Error de conexión.");
  }
  return data;
}

const views = { login: $("#view-login"), register: $("#view-register"), home: $("#view-home") };
function show(name) {
  Object.values(views).forEach((v) => v.classList.add("hidden"));
  views[name].classList.remove("hidden");
}
$("#go-register").addEventListener("click", (e) => { e.preventDefault(); show("register"); });
$("#go-login").addEventListener("click", (e) => { e.preventDefault(); show("login"); });

const SIZE = 280;

function createCropper({ canvas, zoomInput, zoomWrap, empty }) {
  const c = canvas.getContext("2d");
  let img = null, minScale = 1, zoom = 1, ox = 0, oy = 0, dirty = false;
  const scale = () => minScale * zoom;

  function clamp() {
    if (!img) return;
    const maxX = Math.max(0, (img.width * scale() - SIZE) / 2);
    const maxY = Math.max(0, (img.height * scale() - SIZE) / 2);
    ox = Math.min(maxX, Math.max(-maxX, ox));
    oy = Math.min(maxY, Math.max(-maxY, oy));
  }

  function drawTo(ctx2, size) {
    const f = size / SIZE;
    const w = img.width * scale() * f;
    const hh = img.height * scale() * f;
    ctx2.drawImage(img, size / 2 + ox * f - w / 2, size / 2 + oy * f - hh / 2, w, hh);
  }

  function render() {
    c.clearRect(0, 0, SIZE, SIZE);
    if (!img) return;
    drawTo(c, SIZE);
    c.save();
    c.fillStyle = "rgba(0,0,0,0.55)";
    c.beginPath();
    c.rect(0, 0, SIZE, SIZE);
    c.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 6, 0, Math.PI * 2, true);
    c.fill("evenodd");
    c.strokeStyle = "#1fd8a4";
    c.lineWidth = 2;
    c.beginPath();
    c.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 6, 0, Math.PI * 2);
    c.stroke();
    c.restore();
  }

  function setImage(im, markDirty) {
    img = im;
    minScale = SIZE / Math.min(im.width, im.height);
    zoom = 1; ox = 0; oy = 0;
    dirty = markDirty;
    zoomInput.value = 1;
    if (zoomWrap) zoomWrap.classList.remove("hidden");
    if (empty) empty.classList.add("hidden");
    render();
  }

  zoomInput.addEventListener("input", () => {
    zoom = parseFloat(zoomInput.value);
    dirty = true;
    clamp(); render();
  });

  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener("pointerdown", (e) => {
    if (!img) return;
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const k = SIZE / canvas.getBoundingClientRect().width;
    ox += (e.clientX - lastX) * k;
    oy += (e.clientY - lastY) * k;
    lastX = e.clientX; lastY = e.clientY;
    dirty = true;
    clamp(); render();
  });
  const stop = () => { dragging = false; canvas.classList.remove("dragging"); };
  canvas.addEventListener("pointerup", stop);
  canvas.addEventListener("pointercancel", stop);
  canvas.addEventListener("wheel", (e) => {
    if (!img) return;
    e.preventDefault();
    zoom = Math.min(4, Math.max(1, zoom + (e.deltaY < 0 ? 0.08 : -0.08)));
    zoomInput.value = zoom;
    dirty = true;
    clamp(); render();
  }, { passive: false });

  return {
    loadFile(file) {
      return new Promise((resolve) => {
        if (!file || !file.type.startsWith("image/")) return resolve(false);
        const reader = new FileReader();
        reader.onload = () => {
          const im = new Image();
          im.onload = () => { setImage(im, true); resolve(true); };
          im.onerror = () => resolve(false);
          im.src = reader.result;
        };
        reader.onerror = () => resolve(false);
        reader.readAsDataURL(file);
      });
    },
    loadSrc(src) {
      const im = new Image();
      im.onload = () => setImage(im, false);
      im.src = src;
    },
    hasImage: () => !!img,
    changed: () => dirty,
    exportPhoto() {
      const out = document.createElement("canvas");
      out.width = out.height = 256;
      drawTo(out.getContext("2d"), 256);
      return out.toDataURL("image/jpeg", 0.85);
    },
  };
}

const regCropper = createCropper({
  canvas: $("#crop"),
  zoomInput: $("#zoom"),
  zoomWrap: $("#zoom-wrap"),
  empty: $("#crop-empty"),
});

$("#photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const ok = await regCropper.loadFile(file);
  $("#reg-error").textContent = ok ? "" : "Elige un archivo de imagen válido.";
});

const regPhone = $("#reg-phone");
const counter = $("#phone-counter");
regPhone.addEventListener("input", () => {
  cleanPhoneInput(regPhone);
  const v = regPhone.value;
  const err = v ? phoneError(v) : "";
  if (!v) { counter.className = "hint"; counter.textContent = "0/10 dígitos · debe empezar con 3"; }
  else if (!err) { counter.className = "hint ok"; counter.textContent = "10/10 dígitos ✓"; }
  else { counter.className = "hint bad"; counter.textContent = `${v.length}/10 dígitos · ${err}`; }
});
$("#login-phone").addEventListener("input", (e) => cleanPhoneInput(e.target));
$("#add-phone").addEventListener("input", (e) => cleanPhoneInput(e.target));

$("#form-register").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#reg-error");
  const name = $("#reg-name").value.trim();
  const phone = regPhone.value;
  const password = $("#reg-pass").value;

  if (!regCropper.hasImage()) return (err.textContent = "Sube una foto de perfil.");
  if (name.length < 2) return (err.textContent = "Escribe tu nombre (mínimo 2 letras).");
  const pe = phoneError(phone);
  if (pe) return (err.textContent = pe);
  if (password.length < 6) return (err.textContent = "La contraseña debe tener mínimo 6 caracteres.");

  try {
    const data = await api("/api/register", { method: "POST", body: { name, phone, password, photo: regCropper.exportPhoto() } });
    err.textContent = "";
    token = data.token;
    localStorage.setItem("meliox_token", token);
    startApp();
  } catch (ex) {
    err.textContent = ex.message;
  }
});

$("#form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  const phone = $("#login-phone").value;
  const password = $("#login-pass").value;
  const pe = phoneError(phone);
  if (pe) return (err.textContent = pe);
  if (!password) return (err.textContent = "Escribe tu contraseña.");

  try {
    const data = await api("/api/login", { method: "POST", body: { phone, password } });
    err.textContent = "";
    token = data.token;
    localStorage.setItem("meliox_token", token);
    startApp();
  } catch (ex) {
    err.textContent = ex.message;
  }
});

async function refreshMe() {
  const data = await api("/api/me");
  me = data.me;
  friends = data.friends;
  incoming = data.incoming;
  if (current && !friends.some((f) => f.phone === current)) {
    const name = $("#peer-name").textContent;
    closeChat();
    toast(`${name} ya no está en tus amigos.`);
  }
  renderSidebar();
  updatePeerHeader();

  const unreadTotal = friends.reduce((a, f) => a + (f.unread || 0), 0);
  baseTitle = unreadTotal ? `(${unreadTotal}) Meliox` : "Meliox";
  if (!blinkTimer) document.title = baseTitle;
  try {
    if (navigator.setAppBadge) {
      (unreadTotal ? navigator.setAppBadge(unreadTotal) : navigator.clearAppBadge()).catch(() => {});
    }
  } catch {}
}

function updatePeerHeader() {
  if (!current) return;
  const f = friends.find((x) => x.phone === current);
  if (!f) return;
  $("#peer-photo").src = f.photo;
  $("#peer-name").textContent = f.name;
  $("#peer-phone").textContent = "+57 " + f.phone;
}

function renderSidebar() {
  $("#me-photo").src = me.photo;
  $("#me-name").textContent = me.name;
  $("#me-phone").textContent = "+57 " + me.phone;

  const rq = $("#requests");
  rq.innerHTML = "";
  if (incoming.length) {
    rq.classList.remove("hidden");
    rq.append(h("div", { class: "req-title" }, `Solicitudes de amistad (${incoming.length})`));
    incoming.forEach((u) =>
      rq.append(
        h("div", { class: "req" },
          h("img", { class: "avatar", src: u.photo, alt: "" }),
          h("div", { class: "req-info" }, h("strong", {}, u.name), h("small", {}, "+57 " + u.phone)),
          h("button", { class: "mini ok", title: "Aceptar", onclick: () => respond(u.phone, true) }, "✓"),
          h("button", { class: "mini no", title: "Rechazar", onclick: () => respond(u.phone, false) }, "✕")
        )
      )
    );
  } else {
    rq.classList.add("hidden");
  }

  const q = $("#search").value.trim().toLowerCase();
  const list = friends
    .filter((f) => !q || f.name.toLowerCase().includes(q) || f.phone.includes(q))
    .sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));

  const ul = $("#chat-list");
  ul.innerHTML = "";
  if (!list.length) {
    ul.append(
      h("li", { class: "list-empty" },
        friends.length ? "Nadie coincide con tu búsqueda." : "Aún no tienes amigos.\nToca el ícono de persona con + para agregar a alguien por su número.")
    );
    ul.firstChild.style.whiteSpace = "pre-line";
    return;
  }
  list.forEach((f) => {
    const preview = f.last ? (f.last.from === me.phone ? "Tú: " : "") + f.last.text : "Toca para chatear";
    const cancelPress = () => clearTimeout(longTimer);
    ul.append(
      h("li", {
        class: "chat-item" + (current === f.phone ? " active" : ""),
        onclick: (e) => {
          if (longPressed) { e.stopPropagation(); longPressed = false; return; }
          openChat(f.phone);
        },
        oncontextmenu: (e) => { e.preventDefault(); openCtx(e.clientX, e.clientY, f); },
        ontouchstart: (e) => {
          longPressed = false;
          const t = e.touches[0];
          longTimer = setTimeout(() => { longPressed = true; openCtx(t.clientX, t.clientY, f); }, 600);
        },
        ontouchend: cancelPress,
        ontouchmove: cancelPress,
        ontouchcancel: cancelPress,
      },
        h("img", { class: "avatar", src: f.photo, alt: "" }),
        h("div", { class: "ci-main" },
          h("div", { class: "ci-top" }, h("strong", {}, f.name), f.last ? h("time", { class: f.unread ? "new" : "" }, listTime(f.last.ts)) : ""),
          h("div", { class: "ci-bottom" }, h("span", { class: "ci-preview" }, preview), f.unread ? h("span", { class: "badge" }, String(f.unread)) : "")
        )
      )
    );
  });
}
$("#search").addEventListener("input", () => me && renderSidebar());

async function respond(phone, accept) {
  try {
    await api("/api/friends/respond", { method: "POST", body: { phone, accept } });
    await refreshMe();
    if (accept) toast("¡Ahora son amigos!");
  } catch (ex) { toast(ex.message); }
}

async function openChat(phone) {
  const f = friends.find((x) => x.phone === phone);
  if (!f) return;
  current = phone;
  updatePeerHeader();
  $("#chat-empty").classList.add("hidden");
  $("#chat").classList.remove("hidden");
  $("#view-home").classList.add("chat-open");
  msgs = [];
  $("#messages").innerHTML = "";
  await loadMessages(true);
  $("#msg-input").focus();
}

async function loadMessages(forceScroll) {
  const phone = current;
  if (!phone) return;
  try {
    const list = await api("/api/messages?with=" + phone);
    if (phone !== current) return;
    msgs = list;
    renderMessages(forceScroll);
    refreshMe();
  } catch (ex) { toast(ex.message); }
}

function renderMessages(forceScroll) {
  const box = $("#messages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  box.innerHTML = "";
  let lastTs = null;
  msgs.forEach((m) => {
    if (lastTs === null || !sameDay(m.ts, lastTs)) box.append(h("div", { class: "day" }, dayLabel(m.ts)));
    lastTs = m.ts;
    const mine = m.from === me.phone;
    box.append(
      h("div", { class: "bubble " + (mine ? "mine" : "theirs") },
        h("span", { class: "text" }, m.text),
        h("span", { class: "meta" }, fmtTime(m.ts), mine ? h("span", { class: "tick" + (m.read ? " read" : "") }, m.read ? "✓✓" : "✓") : "")
      )
    );
  });
  if (forceScroll || nearBottom) box.scrollTop = box.scrollHeight;
}

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#msg-input");
  const text = input.value.trim();
  if (!text || !current) return;
  input.value = "";
  try {
    const m = await api("/api/messages", { method: "POST", body: { to: current, text } });
    msgs.push(m);
    renderMessages(true);
    refreshMe();
  } catch (ex) {
    input.value = text;
    toast(ex.message);
  }
});

function closeChat() {
  current = null;
  msgs = [];
  $("#view-home").classList.remove("chat-open");
  $("#chat").classList.add("hidden");
  $("#chat-empty").classList.remove("hidden");
  if (me) renderSidebar();
}
$("#back").addEventListener("click", closeChat);

const ctxMenu = $("#ctx-menu");
const confirmModal = $("#confirm-modal");
let ctxTarget = null;
let removeTarget = null;

function openCtx(x, y, f) {
  ctxTarget = f;
  ctxMenu.classList.remove("hidden");
  const w = ctxMenu.offsetWidth, hgt = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + "px";
  ctxMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - hgt - 4)) + "px";
}
function closeCtx() { ctxMenu.classList.add("hidden"); }
function closeConfirm() { confirmModal.classList.add("hidden"); }

document.addEventListener("click", closeCtx);
document.addEventListener("scroll", closeCtx, true);
window.addEventListener("resize", closeCtx);
document.addEventListener("contextmenu", (e) => { if (!e.target.closest(".chat-item")) closeCtx(); });

$("#ctx-remove").addEventListener("click", () => {
  if (!ctxTarget) return;
  removeTarget = ctxTarget;
  closeCtx();
  $("#confirm-text").textContent = `¿Eliminar a ${removeTarget.name} de tus amigos? Ya no podrán chatear hasta que se agreguen de nuevo.`;
  $("#confirm-msg").textContent = "";
  confirmModal.classList.remove("hidden");
});
$("#confirm-cancel").addEventListener("click", closeConfirm);
confirmModal.addEventListener("click", (e) => { if (e.target === confirmModal) closeConfirm(); });

$("#confirm-ok").addEventListener("click", async () => {
  if (!removeTarget) return;
  const { phone, name } = removeTarget;
  try {
    await api("/api/friends/remove", { method: "POST", body: { phone } });
    closeConfirm();
    if (current === phone) closeChat();
    await refreshMe();
    toast(`${name} ya no es tu amigo.`);
  } catch (ex) {
    $("#confirm-msg").textContent = ex.message;
  }
});

const modal = $("#modal");
const addMsg = $("#add-msg");
function openModal() {
  addMsg.textContent = "";
  addMsg.className = "form-msg";
  $("#add-phone").value = "";
  modal.classList.remove("hidden");
  $("#add-phone").focus();
}
const closeModal = () => modal.classList.add("hidden");
$("#btn-add").addEventListener("click", openModal);
$("#add-cancel").addEventListener("click", closeModal);
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });

$("#form-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const phone = $("#add-phone").value;
  const pe = phoneError(phone);
  addMsg.className = "form-msg";
  if (pe) return (addMsg.textContent = pe);
  try {
    const r = await api("/api/friends/request", { method: "POST", body: { phone } });
    addMsg.className = "form-msg ok";
    addMsg.textContent = r.status === "accepted"
      ? `¡Ahora eres amigo de ${r.name}!`
      : `Solicitud enviada a ${r.name}. Falta que la acepte.`;
    $("#add-phone").value = "";
    refreshMe();
  } catch (ex) {
    addMsg.textContent = ex.message;
  }
});

const profileModal = $("#profile-modal");
const profileMsg = $("#profile-msg");
const profileCropper = createCropper({
  canvas: $("#crop-profile"),
  zoomInput: $("#profile-zoom"),
});

function openProfile() {
  if (!me) return;
  profileMsg.textContent = "";
  profileMsg.className = "form-msg";
  $("#profile-name").value = me.name;
  $("#profile-photo-input").value = "";
  profileCropper.loadSrc(me.photo);
  profileModal.classList.remove("hidden");
  $("#profile-name").focus();
}
const closeProfile = () => profileModal.classList.add("hidden");

$("#btn-profile").addEventListener("click", openProfile);
$("#me-photo").addEventListener("click", openProfile);
$("#me-info").addEventListener("click", openProfile);
$("#profile-cancel").addEventListener("click", closeProfile);
profileModal.addEventListener("click", (e) => { if (e.target === profileModal) closeProfile(); });

$("#profile-photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const ok = await profileCropper.loadFile(file);
  profileMsg.className = "form-msg";
  profileMsg.textContent = ok ? "" : "Elige un archivo de imagen válido.";
});

$("#form-profile").addEventListener("submit", async (e) => {
  e.preventDefault();
  profileMsg.className = "form-msg";
  const name = $("#profile-name").value.trim();
  if (name.length < 2) return (profileMsg.textContent = "Escribe tu nombre (mínimo 2 letras).");

  const body = {};
  if (name !== me.name) body.name = name;
  if (profileCropper.changed()) body.photo = profileCropper.exportPhoto();
  if (!Object.keys(body).length) return closeProfile();

  try {
    await api("/api/profile", { method: "POST", body });
    closeProfile();
    await refreshMe();
    toast("Perfil actualizado");
  } catch (ex) {
    profileMsg.textContent = ex.message;
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeModal(); closeProfile(); closeCtx(); closeConfirm(); }
});

let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch {}
}
["pointerdown", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));

function tone(freq, start, dur, vol = 0.15) {
  if (!audioCtx) return;
  try {
    const t0 = audioCtx.currentTime + start;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.02);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  } catch {}
}
const playMsgSound = () => { tone(880, 0, 0.12); tone(1175, 0.13, 0.2); };
const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };

let ringTimer = null;
function startRing(kind) {
  stopRing();
  const once = kind === "in"
    ? () => { tone(659, 0, 0.25, 0.22); tone(523, 0.3, 0.25, 0.22); tone(659, 0.8, 0.25, 0.22); tone(523, 1.1, 0.25, 0.22); vibrate([400, 200, 400]); }
    : () => tone(440, 0, 1.0, 0.08);
  once();
  ringTimer = setInterval(once, kind === "in" ? 2400 : 3000);
}
function stopRing() {
  clearInterval(ringTimer);
  ringTimer = null;
  vibrate(0);
}

let baseTitle = "Meliox";
let blinkTimer = null;
function blinkTitle() {
  if (!document.hidden || blinkTimer) return;
  let on = false;
  blinkTimer = setInterval(() => {
    on = !on;
    document.title = on ? "💬 ¡Mensaje nuevo!" : baseTitle;
  }, 1000);
}
function stopBlink() {
  if (!blinkTimer) return;
  clearInterval(blinkTimer);
  blinkTimer = null;
  document.title = baseTitle;
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) stopBlink(); });

const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported =
  window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const notifBanner = $("#notif-banner");
const notifText = $("#notif-text");
const notifBtn = $("#notif-btn");
let notifAction = null;
let notifHideTimer = null;

function showNotifBanner(text, btn) {
  clearTimeout(notifHideTimer);
  notifText.textContent = text;
  notifAction = btn ? btn.action : null;
  notifBtn.textContent = btn ? btn.label : "";
  notifBtn.classList.toggle("hidden", !btn);
  notifBanner.classList.remove("hidden");
}
const hideNotifBanner = () => { clearTimeout(notifHideTimer); notifBanner.classList.add("hidden"); };
notifBtn.addEventListener("click", () => notifAction && notifAction());

function httpsHelp() {
  alert("Los celulares solo permiten notificaciones push seguras bajo https://.");
}

function b64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function ensurePushSubscription() {
  if (!swReg || !token) return "error";
  try {
    const { key } = await api("/api/push/key");
    if (!key) return "no-server";
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const cur = new Uint8Array(sub.options.applicationServerKey || []);
      const want = b64ToUint8(key);
      if (cur.length !== want.length || cur.some((v, i) => v !== want[i])) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) });
    await api("/api/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
    pushActive = true;
    return "ok";
  } catch (ex) {
    return "error";
  }
}

async function testPush() {
  toast("En 5 segundos te llega una prueba. Minimiza Meliox para verla.");
  try {
    await api("/api/push/test", { method: "POST" });
    toast("Prueba enviada ✓");
  } catch (ex) { toast(ex.message); }
}

async function activatePush(announce) {
  const r = await ensurePushSubscription();
  if (r === "ok") {
    if (announce) {
      showNotifBanner("Notificaciones activadas ✓", { label: "Probar", action: testPush });
      notifHideTimer = setTimeout(hideNotifBanner, 15000);
    } else hideNotifBanner();
  }
}

async function setupNotifications() {
  hideNotifBanner();
  if (!window.isSecureContext || !pushSupported) return;
  try {
    swReg = await navigator.serviceWorker.register("/sw.js");
  } catch (e) {
    return;
  }

  if (Notification.permission === "granted") {
    activatePush(true);
  } else if (Notification.permission !== "denied") {
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      activatePush(true);
    }
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "open-chat" && me) openChat(e.data.phone);
  });
}

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
const RING_TIMEOUT = 45000;

let call = null;
const callEl = $("#call");
const remoteVideo = $("#remote-video");
const localVideo = $("#local-video");

const callSignal = (to, type, extra = {}) =>
  api("/api/call/signal", { method: "POST", body: { to, type, ...extra } }).catch(() => {});

function setCallUI(state, status) {
  callEl.classList.toggle("video", !!(call && call.video));
  callEl.classList.toggle("incoming", state === "incoming");
  callEl.classList.toggle("ringing", state === "incoming" || state === "calling");
  callEl.classList.toggle("connected", state === "connected");
  if (status !== undefined) $("#call-status").textContent = status;
}

function showCall() {
  const f = friends.find((x) => x.phone === call.peer);
  $("#call-photo").src = f ? f.photo : "";
  $("#call-name").textContent = f ? f.name : "+57 " + call.peer;
  $("#call-mute").classList.remove("off");
  $("#call-cam").classList.remove("off");
  callEl.classList.remove("hidden");
}

async function getMedia(video) {
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Las llamadas necesitan https://.");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false,
    });
  } catch (ex) {
    throw new Error("No se pudo acceder al micrófono o cámara.");
  }
}

function makePeer() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const c = call;
  pc.onicecandidate = (e) => {
    if (e.candidate) callSignal(c.peer, "ice", { id: c.id, data: e.candidate.toJSON() });
  };
  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
    remoteVideo.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (call !== c) return;
    if (pc.connectionState === "connected") onConnected();
    else if (pc.connectionState === "failed") endCall("Se perdió la conexión", true);
  };
  c.pc = pc;
  for (const t of c.stream.getTracks()) pc.addTrack(t, c.stream);
  if (c.video) { localVideo.srcObject = c.stream; localVideo.play().catch(() => {}); }
  return pc;
}

function onConnected() {
  if (!call || call.startedAt) return;
  clearTimeout(call.timer);
  stopRing();
  call.startedAt = Date.now();
  setCallUI("connected", "00:00");
  call.tick = setInterval(() => {
    const s = Math.floor((Date.now() - call.startedAt) / 1000);
    $("#call-status").textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }, 1000);
}

async function flushCandidates() {
  const list = call.cands.splice(0);
  for (const c of list) { try { await call.pc.addIceCandidate(c); } catch {} }
}

async function startCall(video) {
  if (!current || !me) return;
  if (call) return toast("Ya estás en una llamada.");
  const peer = current;
  let stream;
  try { stream = await getMedia(video); } catch (ex) { return toast(ex.message); }
  call = { id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()), peer, video, role: "caller", stream, cands: [], answered: false };
  showCall();
  setCallUI("calling", video ? "Videollamando…" : "Llamando…");
  startRing("out");
  const c = call;
  try {
    const pc = makePeer();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await callSignal(peer, "offer", { id: c.id, video, data: { type: offer.type, sdp: offer.sdp } });
    c.timer = setTimeout(() => { if (call === c && !c.startedAt) endCall("No contestó", true); }, RING_TIMEOUT);
  } catch (ex) {
    endCall("No se pudo iniciar la llamada", false);
  }
}

function incomingCall(s) {
  const f = friends.find((x) => x.phone === s.from);
  if (!f) return;
  if (s.age > RING_TIMEOUT) return;
  call = { id: s.id, peer: s.from, video: !!s.video, role: "callee", cands: [], offer: s.data };
  showCall();
  setCallUI("incoming", s.video ? "Videollamada entrante" : "Llamada entrante");
  startRing("in");
  const c = call;
  c.timer = setTimeout(() => { if (call === c && !c.startedAt) endCall("Llamada perdida", false); }, Math.max(1000, RING_TIMEOUT - (s.age || 0)));
}

async function acceptCall() {
  const c = call;
  if (!c || c.role !== "callee" || c.pc) return;
  try {
    c.stream = await getMedia(c.video);
  } catch (ex) {
    toast(ex.message);
    return endCall("", true, "reject");
  }
  if (call !== c) { c.stream.getTracks().forEach((t) => t.stop()); return; }
  stopRing();
  clearTimeout(c.timer);
  setCallUI("calling", "Conectando…");
  try {
    const pc = makePeer();
    await pc.setRemoteDescription(c.offer);
    await flushCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await callSignal(c.peer, "answer", { id: c.id, data: { type: answer.type, sdp: answer.sdp } });
  } catch (ex) {
    endCall("No se pudo conectar", true);
  }
}

function endCall(reason, notify, type = "end") {
  const c = call;
  if (!c) return;
  call = null;
  clearTimeout(c.timer);
  clearInterval(c.tick);
  stopRing();
  if (notify) {
    callSignal(c.peer, type, { id: c.id, missed: c.role === "caller" && !c.startedAt });
  }
  try { c.pc && c.pc.close(); } catch {}
  if (c.stream) c.stream.getTracks().forEach((t) => t.stop());
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
  if (reason) {
    $("#call-status").textContent = reason;
    callEl.classList.remove("incoming", "ringing");
    setTimeout(() => { if (!call) callEl.classList.add("hidden"); }, 1400);
  } else {
    callEl.classList.add("hidden");
  }
  callEl.classList.remove("connected", "video");
}

async function handleSignal(s) {
  if (s.type === "offer") {
    if (call) return callSignal(s.from, "busy", { id: s.id });
    return incomingCall(s);
  }
  if (!call || call.id !== s.id) return;
  if (s.type === "answer" && call.role === "caller" && call.pc && !call.answered) {
    call.answered = true;
    stopRing();
    setCallUI("calling", "Conectando…");
    try {
      await call.pc.setRemoteDescription(s.data);
      await flushCandidates();
    } catch (ex) {}
  } else if (s.type === "ice") {
    if (call.pc && call.pc.remoteDescription) { try { await call.pc.addIceCandidate(s.data); } catch {} }
    else call.cands.push(s.data);
  } else if (s.type === "end") {
    endCall(call.startedAt ? "Llamada finalizada" : "Llamada perdida", false);
  } else if (s.type === "reject") {
    endCall("Rechazó la llamada", false);
  } else if (s.type === "busy") {
    endCall("Está en otra llamada", false);
  }
}

let draining = false;
async function drainSignals() {
  if (draining || !token || !me) return;
  draining = true;
  try {
    const list = await api("/api/signals");
    for (const s of list) await handleSignal(s);
  } catch {}
  draining = false;
}
setInterval(() => { if (!document.hidden || call) drainSignals(); }, 2000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) drainSignals(); });

$("#btn-voice").addEventListener("click", () => startCall(false));
$("#btn-video").addEventListener("click", () => startCall(true));
$("#call-accept").addEventListener("click", acceptCall);
$("#call-end").addEventListener("click", () => {
  if (!call) return;
  if (call.role === "callee" && !call.pc) endCall("", true, "reject");
  else endCall("Llamada finalizada", true);
});
$("#call-mute").addEventListener("click", (e) => {
  if (!call || !call.stream) return;
  const t = call.stream.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  e.currentTarget.classList.toggle("off", !t.enabled);
});
$("#call-cam").addEventListener("click", (e) => {
  if (!call || !call.stream) return;
  const t = call.stream.getVideoTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  e.currentTarget.classList.toggle("off", !t.enabled);
});

function connect() {
  if (es) es.close();
  es = new EventSource(`${API}/api/events?token=${encodeURIComponent(token)}`);
  es.addEventListener("newmsg", async (e) => {
    const { from } = JSON.parse(e.data);
    const watching = current === from && !document.hidden;
    if (current === from) await loadMessages(false);
    else await refreshMe();
    if (!watching) {
      playMsgSound();
      blinkTitle();
    }
  });
  es.addEventListener("signal", () => drainSignals());
  es.addEventListener("read", (e) => {
    const { by } = JSON.parse(e.data);
    if (current === by) loadMessages(false);
  });
  es.addEventListener("friends", () => refreshMe());
  es.addEventListener("ready", () => { refreshMe(); if (current) loadMessages(false); });
}

function syncNow() {
  if (!token || !me || document.hidden) return;
  if (current) loadMessages(false);
  else refreshMe().catch(() => {});
}
setInterval(syncNow, 15000);
document.addEventListener("visibilitychange", syncNow);

async function startApp() {
  try {
    await refreshMe();
    show("home");
    connect();
    setupNotifications();
    const wanted = new URLSearchParams(location.search).get("chat");
    if (wanted) {
      history.replaceState(null, "", location.pathname);
      openChat(wanted);
    }
  } catch (ex) {
    if (token) toast(ex.message);
    show("login");
  }
}

async function dropPush(oldToken) {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await fetch(API + "/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + oldToken },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe();
  } catch {}
}

function logout() {
  if (call) endCall("", true);
  if (es) es.close();
  es = null;
  const oldToken = token;
  const hadPush = pushActive;
  token = null; me = null; friends = []; incoming = []; current = null; msgs = [];
  pushActive = false;
  if (hadPush && oldToken) dropPush(oldToken);
  hideNotifBanner();
  baseTitle = "Meliox";
  stopBlink();
  document.title = "Meliox";
  localStorage.removeItem("meliox_token");
  $("#login-pass").value = "";
  $("#chat").classList.add("hidden");
  $("#chat-empty").classList.remove("hidden");
  $("#view-home").classList.remove("chat-open");
  closeProfile();
  show("login");
}
$("#logout").addEventListener("click", logout);

if (token) startApp();
