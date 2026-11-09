// ===================== Meliox =====================
const $ = (s) => document.querySelector(s);

// Configuración de la API adaptada para Render y entorno local:
// Si la aplicación se carga desde Render (ej: melioxchat.onrender.com), usa rutas relativas ("").
// Si entras desde tu red local o localhost, mantiene la conexión al puerto 3001.
const API = location.hostname.includes("onrender.com")
  ? ""
  : (location.port === "3001" ? "" : `http://${location.hostname}:3001`);

// ---------- Número colombiano: empieza con 3 y EXACTAMENTE 10 dígitos ----------
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

// ---------- Utilidades ----------
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

// ---------- Estado ----------
let token = localStorage.getItem("meliox_token");
let me = null;
let friends = [];
let incoming = [];
let current = null; // teléfono del chat abierto
let msgs = [];
let es = null;
let longPressed = false; // para "mantener presionado" en el celular
let longTimer = null;
let swReg = null;        // service worker (notificaciones push)
let pushActive = false;  // este dispositivo ya recibe notificaciones push

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error("No se pudo conectar con el servidor. ¿Está corriendo node server.cjs?");
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401 && token) logout();
    throw new Error(data.error || "Error de conexión.");
  }
  return data;
}

// ---------- Vistas ----------
const views = { login: $("#view-login"), register: $("#view-register"), home: $("#view-home") };
function show(name) {
  Object.values(views).forEach((v) => v.classList.add("hidden"));
  views[name].classList.remove("hidden");
}
$("#go-register").addEventListener("click", (e) => { e.preventDefault(); show("register"); });
$("#go-login").addEventListener("click", (e) => { e.preventDefault(); show("login"); });

// ---------- Editor de foto (mover + zoom), reutilizable ----------
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

// ---------- Registro y login ----------
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

// ---------- App ----------
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

  // Contador de mensajes sin leer en la pestaña y en el ícono de la app
  const unreadTotal = friends.reduce((a, f) => a + (f.unread || 0), 0);
  document.title = unreadTotal ? `(${unreadTotal}) Meliox` : "Meliox";
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

// ---------- Chat ----------
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

// ---------- Eliminar amigo ----------
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

// ---------- Agregar amigo ----------
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

// ---------- Editar mi perfil ----------
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

// ---------- Notificaciones (push en el celular, como WhatsApp) ----------
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported =
  window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const notifBanner = $("#notif-banner");
const notifText = $("#notif-text");
const notifBtn = $("#notif-btn");

function showNotifBanner(text, withButton) {
  notifText.textContent = text;
  notifBtn.classList.toggle("hidden", !withButton);
  notifBanner.classList.remove("hidden");
}
const hideNotifBanner = () => notifBanner.classList.add("hidden");

function b64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Devuelve "ok", "no-server" (el servidor no tiene web-push) o "error"
async function ensurePushSubscription() {
  if (!swReg || !token) return "error";
  try {
    const { key } = await api("/api/push/key");
    if (!key) return "no-server";
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      // Si el servidor cambió de llave, la suscripción vieja ya no sirve
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
    console.warn("Push:", ex);
    return "error";
  }
}

async function setupNotifications() {
  hideNotifBanner();
  if (isIOS && !isStandalone) {
    return showNotifBanner("En iPhone: toca Compartir → «Añadir a pantalla de inicio» y abre Meliox desde ese ícono para recibir notificaciones.", false);
  }
  if (!window.isSecureContext) {
    // Con http://192.168... el navegador no permite notificaciones: lo avisamos solo la primera vez
    try {
      if (localStorage.getItem("meliox_https_hint")) return;
      localStorage.setItem("meliox_https_hint", "1");
    } catch {}
    return showNotifBanner("Para recibir notificaciones en el celular, Meliox debe abrirse con una dirección https://.", false);
  }
  if (!pushSupported) return;
  try { swReg = await navigator.serviceWorker.register("/sw.js"); } catch { return; }

  if (Notification.permission === "granted") {
    if ((await ensurePushSubscription()) === "no-server") {
      showNotifBanner("El servidor no tiene las notificaciones instaladas (falta npm install web-push).", false);
    }
    return;
  }
  if (Notification.permission === "denied") {
    return showNotifBanner("Las notificaciones están bloqueadas para este sitio. Actívalas en los ajustes del navegador.", false);
  }
  showNotifBanner("Activa las notificaciones para enterarte cuando te escriban.", true);
}

notifBtn.addEventListener("click", async () => {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    return showNotifBanner("No diste permiso. Puedes activarlo después desde los ajustes del navegador.", false);
  }
  const r = await ensurePushSubscription();
  if (r === "ok") { hideNotifBanner(); toast("Notificaciones activadas."); }
  else if (r === "no-server") showNotifBanner("El servidor no tiene las notificaciones instaladas (falta npm install web-push).", false);
  else showNotifBanner("No se pudieron activar. Toca Activar para intentar de nuevo.", true);
});

// Respaldo sin push: aviso del navegador cuando la pestaña está en segundo plano
function notifyInPage(from) {
  if (pushActive || !("Notification" in window) || Notification.permission !== "granted") return;
  const f = friends.find((x) => x.phone === from);
  if (!f || !f.last || f.last.from !== from) return;
  try {
    const n = new Notification(f.name, { body: f.last.text, icon: f.photo, tag: "chat-" + from });
    n.onclick = () => { window.focus(); openChat(from); n.close(); };
  } catch {}
}

// Al tocar una notificación, el service worker nos pide abrir ese chat
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "open-chat" && me) openChat(e.data.phone);
  });
}

// ---------- Tiempo real ----------
function connect() {
  if (es) es.close();
  es = new EventSource(`${API}/api/events?token=${encodeURIComponent(token)}`);
  es.addEventListener("newmsg", async (e) => {
    const { from } = JSON.parse(e.data);
    const watching = current === from && !document.hidden;
    if (current === from) await loadMessages(false);
    else await refreshMe();
    if (!watching) notifyInPage(from);
  });
  es.addEventListener("read", (e) => {
    const { by } = JSON.parse(e.data);
    if (current === by) loadMessages(false);
  });
  es.addEventListener("friends", () => refreshMe());
  es.addEventListener("ready", () => { refreshMe(); if (current) loadMessages(false); });
}

// Red de seguridad: si algún intermediario (proxy, túnel) bloquea el tiempo real,
// la app igual se actualiza cada 15 s y al volver a la pestaña.
function syncNow() {
  if (!token || !me || document.hidden) return;
  if (current) loadMessages(false);
  else refreshMe().catch(() => {});
}
setInterval(syncNow, 15000);
document.addEventListener("visibilitychange", syncNow);

// ---------- Inicio / salida ----------
async function startApp() {
  try {
    await refreshMe();
    show("home");
    connect();
    setupNotifications();
    // Si venimos de tocar una notificación (/?chat=3001234567), abrimos ese chat
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

// Quita este dispositivo de las notificaciones de la cuenta que se cierra
// (usa fetch directo para no depender de api(), que llama a logout en un 401)
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
  if (es) es.close();
  es = null;
  const oldToken = token;
  const hadPush = pushActive;
  token = null; me = null; friends = []; incoming = []; current = null; msgs = [];
  pushActive = false;
  if (hadPush && oldToken) dropPush(oldToken);
  hideNotifBanner();
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