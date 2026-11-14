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
let replyingTo = null;   // mensaje al que estoy respondiendo { id, from, text }

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
    if (res.status === 401 && token) {
      // Un 401 puede ser pasajero (el servidor acaba de reiniciarse): se reintenta una vez antes de cerrar la sesión
      if (!opts._retried) {
        await new Promise((r) => setTimeout(r, 1500));
        if (token) return api(path, { ...opts, _retried: true });
      } else logout();
    }
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

// Pantalla "Conectando…" (mientras el servidor despierta; en Render gratis puede tardar hasta un minuto)
const connectingEl = h("div", { class: "modal hidden", id: "connecting" },
  h("div", { class: "modal-card" },
    h("h3", {}, "Conectando…"),
    h("p", { class: "hint", id: "connecting-text" }, "Abriendo tu sesión.")
  )
);
document.body.append(connectingEl);

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
    const preview = f.last
      ? (f.last.from === me.phone ? "Tú: " : "") + (f.last.deleted ? "🚫 Mensaje eliminado" : f.last.text)
      : "Toca para chatear";
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
  clearReply();
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
  // Si el mensaje al que respondía se eliminó para todos, se quita la respuesta
  if (replyingTo && msgs.some((x) => x.id === replyingTo.id && x.deleted)) clearReply();
  msgs.forEach((m) => {
    if (lastTs === null || !sameDay(m.ts, lastTs)) box.append(h("div", { class: "day" }, dayLabel(m.ts)));
    lastTs = m.ts;
    const mine = m.from === me.phone;
    const bubble = h("div", { class: "bubble " + (mine ? "mine" : "theirs") + (m.deleted ? " deleted" : ""), "data-id": m.id });
    if (m.reply) bubble.append(quoteEl(m.reply));
    bubble.append(
      h("span", { class: "text" }, m.deleted ? (mine ? "🚫 Eliminaste este mensaje" : "🚫 Se eliminó este mensaje") : m.text),
      h("span", { class: "meta" }, fmtTime(m.ts), mine && !m.deleted ? h("span", { class: "tick" + (m.read ? " read" : "") }, m.read ? "✓✓" : "✓") : "")
    );
    attachMsgEvents(bubble, m);
    box.append(bubble);
  });
  if (forceScroll || nearBottom) box.scrollTop = box.scrollHeight;
}

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#msg-input");
  const text = input.value.trim();
  if (!text || !current) return;
  input.value = "";
  const body = { to: current, text };
  if (replyingTo) body.replyTo = replyingTo.id;
  try {
    const m = await api("/api/messages", { method: "POST", body });
    clearReply();
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
  clearReply();
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

// ---------- Mensajes: responder, copiar y eliminar (como WhatsApp) ----------
// Computadora: clic derecho sobre un mensaje.  Celular: mantener presionado (o deslizar a la derecha para responder).
(function addMessageStyles() {
  const st = document.createElement("style");
  st.textContent = `
    .bubble { touch-action: pan-y; }
    .bubble.deleted .text { font-style: italic; color: rgba(233, 237, 239, 0.6); }
    .bubble .quote {
      flex-basis: 100%; min-width: 0; margin: 0 0 4px; padding: 5px 8px; cursor: pointer;
      border-left: 4px solid var(--accent); background: rgba(0, 0, 0, 0.22); border-radius: 6px; font-size: 0.82rem;
    }
    .bubble .quote b { display: block; color: var(--accent); font-size: 0.76rem; }
    .bubble .quote span { display: block; color: rgba(233, 237, 239, 0.75); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bubble.flash { animation: flashMsg 1.4s ease-out; }
    @keyframes flashMsg { 0%, 45% { box-shadow: 0 0 0 3px rgba(31, 216, 164, 0.8); } 100% { box-shadow: 0 1px 1px rgba(0, 0, 0, 0.25); } }
    @media (pointer: coarse) { .bubble { -webkit-touch-callout: none; user-select: none; -webkit-user-select: none; } }
    .reply-bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; background: var(--panel-2); border-top: 1px solid var(--line); }
    .reply-bar .rq { flex: 1; min-width: 0; padding: 3px 10px; border-left: 4px solid var(--accent); background: rgba(0, 0, 0, 0.2); border-radius: 6px; }
    .reply-bar .rq b { display: block; color: var(--accent); font-size: 0.78rem; }
    .reply-bar .rq span { display: block; color: var(--muted); font-size: 0.85rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mmenu {
      position: fixed; z-index: 30; min-width: 200px; padding: 4px;
      background: var(--panel-2); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    }
    .mmenu button {
      display: block; width: 100%; text-align: left; padding: 11px 12px; background: none; border: none; border-radius: 8px;
      color: var(--text); font-size: 0.95rem; cursor: pointer;
    }
    .mmenu button:hover { background: rgba(255, 255, 255, 0.07); }
    .mmenu button.danger { color: var(--danger); }
    .del-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }
  `;
  document.head.append(st);
})();

let msgLongPressed = false;

// Barra "Respondiendo a…" encima de la caja de texto
const replyBar = h("div", { class: "reply-bar hidden", id: "reply-bar" },
  h("div", { class: "rq" }, h("b", { id: "reply-who" }), h("span", { id: "reply-text" })),
  h("button", { type: "button", class: "icon-btn", title: "Cancelar respuesta", "aria-label": "Cancelar respuesta", onclick: () => clearReply() }, "✕")
);
$("#chat").insertBefore(replyBar, $("#composer"));

function senderName(phone) {
  if (me && phone === me.phone) return "Tú";
  const f = friends.find((x) => x.phone === phone);
  return f ? f.name : "Mensaje";
}

function setReply(m) {
  if (!m || m.deleted) return;
  replyingTo = { id: m.id, from: m.from, text: m.text };
  $("#reply-who").textContent = senderName(m.from);
  $("#reply-text").textContent = m.text;
  replyBar.classList.remove("hidden");
  $("#msg-input").focus();
}
function clearReply() {
  replyingTo = null;
  replyBar.classList.add("hidden");
}

function quoteEl(r) {
  const txt = r.gone ? "Mensaje no disponible" : r.deleted ? "🚫 Mensaje eliminado" : r.text;
  return h("div", { class: "quote", onclick: (e) => { e.stopPropagation(); jumpToMessage(r.id); } },
    h("b", {}, senderName(r.from)),
    h("span", {}, txt)
  );
}

function jumpToMessage(id) {
  const el = $("#messages").querySelector('[data-id="' + id + '"]');
  if (!el) return toast("El mensaje original ya no está en este chat.");
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

// Menú del mensaje
const msgMenu = h("div", { class: "mmenu hidden", id: "msg-menu" });
document.body.append(msgMenu);
const closeMsgMenu = () => msgMenu.classList.add("hidden");

function copyText(text) {
  const done = () => toast("Copiado");
  try {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(done, () => toast("No se pudo copiar."));
    const ta = h("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    done();
  } catch { toast("No se pudo copiar."); }
}

function openMsgMenu(x, y, m) {
  closeCtx();
  msgMenu.innerHTML = "";
  if (!m.deleted) {
    msgMenu.append(h("button", { type: "button", onclick: () => { closeMsgMenu(); setReply(m); } }, "Responder"));
    msgMenu.append(h("button", { type: "button", onclick: () => { closeMsgMenu(); copyText(m.text); } }, "Copiar"));
  }
  msgMenu.append(h("button", { type: "button", class: "danger", onclick: () => { closeMsgMenu(); askDelete(m); } }, "Eliminar"));
  msgMenu.classList.remove("hidden");
  const w = msgMenu.offsetWidth, hgt = msgMenu.offsetHeight;
  msgMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + "px";
  msgMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - hgt - 4)) + "px";
}

// Clic derecho (computadora), mantener presionado y deslizar a la derecha (celular)
function attachMsgEvents(bubble, m) {
  let timer = null, sx = 0, sy = 0, dx = 0, swiping = false;
  const cancel = () => clearTimeout(timer);
  const reset = () => { cancel(); swiping = false; dx = 0; bubble.style.transform = ""; };

  bubble.addEventListener("contextmenu", (e) => { e.preventDefault(); openMsgMenu(e.clientX, e.clientY, m); });
  bubble.addEventListener("click", (e) => {
    if (msgLongPressed) { e.stopPropagation(); msgLongPressed = false; } // el "levantar el dedo" no debe cerrar el menú
  });
  bubble.addEventListener("touchstart", (e) => {
    msgLongPressed = false; swiping = false; dx = 0;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY;
    cancel();
    timer = setTimeout(() => { msgLongPressed = true; vibrate(25); openMsgMenu(sx, sy, m); }, 500);
  }, { passive: true });
  bubble.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    dx = t.clientX - sx;
    const dy = t.clientY - sy;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) cancel();
    if (!m.deleted && dx > 8 && Math.abs(dy) < Math.abs(dx)) {
      swiping = true;
      bubble.style.transform = "translateX(" + Math.min(dx, 70) + "px)";
    }
  }, { passive: true });
  bubble.addEventListener("touchend", () => {
    const reply = swiping && dx > 60;
    reset();
    if (reply) { vibrate(15); setReply(m); }
  }, { passive: true });
  bubble.addEventListener("touchcancel", reset, { passive: true });
}

// Ventana para eliminar
const delModal = h("div", { class: "modal hidden", id: "del-modal" },
  h("div", { class: "modal-card" },
    h("h3", {}, "Eliminar mensaje"),
    h("p", { class: "hint", id: "del-text" }),
    h("p", { class: "form-msg", id: "del-msg" }),
    h("div", { class: "del-actions" },
      h("button", { type: "button", class: "btn danger", id: "del-all", onclick: () => doDelete("all") }, "Eliminar para todos"),
      h("button", { type: "button", class: "btn danger", id: "del-me", onclick: () => doDelete("me") }, "Eliminar para mí"),
      h("button", { type: "button", class: "btn secondary", onclick: () => closeDel() }, "Cancelar")
    )
  )
);
document.body.append(delModal);
let delTarget = null;
function closeDel() { delModal.classList.add("hidden"); delTarget = null; }
delModal.addEventListener("click", (e) => { if (e.target === delModal) closeDel(); });

function askDelete(m) {
  delTarget = m;
  // Para todos: solo mis propios mensajes que no se hayan eliminado ya
  const canAll = m.from === (me && me.phone) && !m.deleted;
  $("#del-all").classList.toggle("hidden", !canAll);
  $("#del-text").textContent = canAll
    ? "Elige cómo quieres eliminarlo."
    : "Se borrará solo de tu chat. La otra persona lo seguirá viendo.";
  $("#del-msg").textContent = "";
  delModal.classList.remove("hidden");
}

async function doDelete(scope) {
  const m = delTarget;
  if (!m) return;
  try {
    await api("/api/messages/delete", { method: "POST", body: { id: m.id, scope } });
    if (replyingTo && replyingTo.id === m.id) clearReply();
    closeDel();
    await loadMessages(false);
    toast(scope === "all" ? "Mensaje eliminado para todos" : "Mensaje eliminado para ti");
  } catch (ex) {
    $("#del-msg").textContent = ex.message;
  }
}

document.addEventListener("click", closeMsgMenu);
document.addEventListener("scroll", closeMsgMenu, true);
window.addEventListener("resize", closeMsgMenu);
document.addEventListener("contextmenu", (e) => { if (!e.target.closest(".bubble")) closeMsgMenu(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!msgMenu.classList.contains("hidden")) closeMsgMenu();
  else if (!delModal.classList.contains("hidden")) closeDel();
  else clearReply();
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

// ---------- Sonidos (sin archivos: se generan con el navegador) ----------
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

// Título parpadeante cuando llega un mensaje y la pestaña está en segundo plano
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

// ---------- Notificaciones (push en el celular, como WhatsApp) ----------
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
  alert(
    "Los celulares solo permiten notificaciones y llamadas en páginas seguras (https://).\n\n" +
    "OPCIÓN 1 (cualquier celular): en la PC, en otra terminal, corre:\n" +
    "cloudflared tunnel --url http://localhost:3001\n" +
    "y abre en el celular la dirección https://…trycloudflare.com que aparece.\n\n" +
    "OPCIÓN 2 (solo Android con Chrome): abre chrome://flags/#unsafely-treat-insecure-origin-as-secure , " +
    "escribe " + location.origin + " , actívalo y reinicia Chrome."
  );
}

function b64ToUint8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Devuelve "ok", "no-server" o "error" (el motivo queda en pushError)
let pushError = "";
async function ensurePushSubscription() {
  pushError = "";
  if (!swReg || !token) { pushError = "no hay sesión iniciada o el servicio de notificaciones no arrancó"; return "error"; }
  try {
    const { key } = await api("/api/push/key");
    if (!key) return "no-server";
    const reg = await navigator.serviceWorker.ready;
    const want = b64ToUint8(key);
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      // Si el servidor cambió de llave, la suscripción vieja ya no sirve
      const cur = new Uint8Array(sub.options.applicationServerKey || []);
      if (cur.length !== want.length || cur.some((v, i) => v !== want[i])) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
      } catch (e1) {
        // A veces falla la primera vez: se espera y se intenta otra vez
        await new Promise((r) => setTimeout(r, 1500));
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
      }
    }
    await api("/api/push/subscribe", { method: "POST", body: { subscription: sub.toJSON() } });
    pushActive = true;
    return "ok";
  } catch (ex) {
    console.warn("Push:", ex);
    const name = (ex && ex.name) || "Error";
    const msg = (ex && ex.message) || String(ex);
    pushError = name + ": " + msg;
    if (name === "AbortError") {
      pushError += " — el navegador no logra conectar con el servicio de notificaciones de Google (revisa Brave, VPN, antivirus o firewall).";
    }
    return "error";
  }
}

async function testPush() {
  toast("En 5 segundos te llega una prueba. Minimiza Meliox para verla.");
  try {
    await api("/api/push/test", { method: "POST" });
    toast("Prueba enviada ✓ Si no la ves, revisa los permisos de notificaciones del celular.");
  } catch (ex) { toast(ex.message); }
}

// Intenta suscribir este dispositivo y muestra el resultado en el aviso
async function activatePush(announce) {
  const r = await ensurePushSubscription();
  if (r === "ok") {
    if (announce) {
      showNotifBanner("Notificaciones activadas ✓", { label: "Probar", action: testPush });
      notifHideTimer = setTimeout(hideNotifBanner, 15000);
    } else hideNotifBanner();
  } else if (r === "no-server") {
    showNotifBanner("El servidor no tiene las notificaciones instaladas (falta correr: npm install web-push).", null);
  } else {
    showNotifBanner("No se pudieron activar las notificaciones. Motivo: " + pushError, { label: "Reintentar", action: () => activatePush(true) });
  }
}

async function setupNotifications() {
  hideNotifBanner();
  if (!window.isSecureContext) {
    return showNotifBanner("Sin https:// el celular no permite notificaciones ni llamadas.", { label: "Ayuda", action: httpsHelp });
  }
  if (isIOS && !isStandalone) {
    return showNotifBanner("En iPhone: toca Compartir → «Añadir a pantalla de inicio» y abre Meliox desde ese ícono.", null);
  }
  if (!pushSupported) {
    return showNotifBanner("Este navegador no soporta notificaciones push.", null);
  }
  try { swReg = await navigator.serviceWorker.register("/sw.js"); }
  catch { return showNotifBanner("No se pudo iniciar el servicio de notificaciones.", { label: "Reintentar", action: setupNotifications }); }

  if (Notification.permission === "granted") return activatePush(true);
  if (Notification.permission === "denied") {
    return showNotifBanner("Las notificaciones están bloqueadas. Actívalas en los ajustes del navegador (candado junto a la dirección).", null);
  }
  showNotifBanner("Activa las notificaciones para enterarte de mensajes y llamadas.", {
    label: "Activar",
    action: async () => {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return showNotifBanner("No diste permiso. Puedes activarlo desde los ajustes del navegador.", null);
      activatePush(true);
    },
  });
}

// Respaldo sin push: aviso del navegador cuando la pestaña está en segundo plano
function notifyInPage(from, text, tag) {
  if (pushActive || !("Notification" in window) || Notification.permission !== "granted") return;
  const f = friends.find((x) => x.phone === from);
  if (!f) return;
  try {
    const n = new Notification(f.name, { body: text, icon: f.photo, tag: tag || "chat-" + from });
    n.onclick = () => { window.focus(); openChat(from); n.close(); };
  } catch {}
}

// Al tocar una notificación, el service worker nos pide abrir ese chat
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data && e.data.type === "open-chat" && me) openChat(e.data.phone);
  });
}

// ---------- Llamadas y videollamadas (WebRTC) ----------
// Nota: dentro de tu casa funciona con STUN. Entre redes distintas (datos móviles) puede
// fallar en algunas conexiones: ahí haría falta un servidor TURN.
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
const RING_TIMEOUT = 45000;

let call = null; // { id, peer, video, role, pc, stream, cands, offer, timer, tick, startedAt }
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
    throw new Error("Las llamadas necesitan https://. Toca «Ayuda» en el aviso verde.");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false,
    });
  } catch (ex) {
    if (ex.name === "NotAllowedError") throw new Error("Debes permitir el micrófono" + (video ? " y la cámara" : "") + ".");
    if (ex.name === "NotFoundError") throw new Error("No se encontró " + (video ? "cámara o " : "") + "micrófono.");
    throw new Error("No se pudo acceder al micrófono" + (video ? " o la cámara." : "."));
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
  if (!f) return; // solo amigos
  if (s.age > RING_TIMEOUT) return; // ya expiró
  call = { id: s.id, peer: s.from, video: !!s.video, role: "callee", cands: [], offer: s.data };
  showCall();
  setCallUI("incoming", s.video ? "Videollamada entrante" : "Llamada entrante");
  startRing("in");
  const c = call;
  c.timer = setTimeout(() => { if (call === c && !c.startedAt) endCall("Llamada perdida", false); }, Math.max(1000, RING_TIMEOUT - (s.age || 0)));
  if (document.hidden) {
    notifyInPage(s.from, s.video ? "🎥 Videollamada entrante" : "📞 Llamada entrante", "call-" + s.from);
  }
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
    console.warn("Llamada:", ex);
    endCall("No se pudo conectar", true);
  }
}

// reason: texto que se muestra un momento; notify: avisar al otro; type: end | reject
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
    if (call) return callSignal(s.from, "busy", { id: s.id }); // ya estoy en una llamada
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
    } catch (ex) { console.warn("Llamada:", ex); }
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
// Revisa llamadas entrantes cada 2 s (funciona aunque el tiempo real esté bloqueado)
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

// ---------- Tiempo real ----------
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
      const f = friends.find((x) => x.phone === from);
      if (document.hidden && f && f.last && f.last.from === from) notifyInPage(from, f.last.text);
    }
  });
  es.addEventListener("signal", () => drainSignals());
  es.addEventListener("read", (e) => {
    const { by } = JSON.parse(e.data);
    if (current === by) loadMessages(false);
  });
  es.addEventListener("friends", () => refreshMe());
  es.addEventListener("chat", (e) => {
    const { peer } = JSON.parse(e.data);
    if (current === peer) loadMessages(false); else refreshMe();
  });
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
  // Mientras se abre la sesión NO se muestra el login (así nadie cree que debe volver a entrar)
  Object.values(views).forEach((v) => v.classList.add("hidden"));
  connectingEl.classList.remove("hidden");
  for (let tries = 0; ; tries++) {
    try {
      await refreshMe();
      break;
    } catch (ex) {
      // Sin token = el servidor dijo de verdad que la sesión no vale (logout() ya mostró el login)
      if (!token) { connectingEl.classList.add("hidden"); return; }
      // Cualquier otro fallo (servidor dormido, sin internet): se espera y se reintenta, la sesión NO se pierde
      $("#connecting-text").textContent = tries < 2
        ? "Abriendo tu sesión…"
        : "Despertando el servidor… puede tardar hasta un minuto. No cierres la app.";
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  connectingEl.classList.add("hidden");
  show("home");
  connect();
  setupNotifications();
  // Si venimos de tocar una notificación (/?chat=3001234567), abrimos ese chat
  const wanted = new URLSearchParams(location.search).get("chat");
  if (wanted) {
    history.replaceState(null, "", location.pathname);
    openChat(wanted);
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
