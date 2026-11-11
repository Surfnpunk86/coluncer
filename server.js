/**
 * Servidor COLUNCER (Render · Web Service de Node)
 *  - Sirve las páginas del sitio y sus archivos públicos.
 *  - POST /api/wompi-signature → firma de integridad de Wompi.
 *
 * El secreto de integridad vive SOLO en la variable de entorno
 * WOMPI_INTEGRITY_SECRET (Render → Environment). Nunca va en el código.
 *
 * Firma Wompi: SHA256(referencia + montoEnCentavos + moneda + secreto)
 */
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const db = require("./db");
const adminApi = require("./admin-api");

const app = express();
const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.set("trust proxy", 1); // Render va detrás de un proxy: necesario para ver la IP real

/* ---- Encabezados de seguridad ---- */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  next();
});

/* ---- Firma de integridad de Wompi ---- */
const MAX_AMOUNT_COP_CENTS = 200_000_000; // tope: 2.000.000 COP por transacción
const REFERENCE_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

/* Límite sencillo por IP (cada ruta tiene su propio tope por minuto) */
function makeRateLimit(max, windowMs = 60_000) {
  const hits = new Map();
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (t > v.reset) hits.delete(k); }, 5 * 60_000).unref();
  return (req, res, next) => {
    const now = Date.now();
    const rec = hits.get(req.ip) || { n: 0, reset: now + windowMs };
    if (now > rec.reset) { rec.n = 0; rec.reset = now + windowMs; }
    rec.n += 1;
    hits.set(req.ip, rec);
    if (rec.n > max) return res.status(429).json({ error: "Demasiadas solicitudes. Intenta más tarde." });
    next();
  };
}
const rateLimit = makeRateLimit(30);
const shipLimit = makeRateLimit(10);

/* Solo se aceptan pedidos que vengan de este mismo sitio (o de ALLOWED_ORIGINS, separados por coma). */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // misma página (algunos navegadores no envían Origin en same-origin)
  const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const self = `${req.protocol}://${req.headers.host}`;
  return origin === self || extra.includes(origin);
}

/* ---- Utilidades de texto y correo ---- */
const RESEND_API_BASE = process.env.RESEND_API_BASE || "https://api.resend.com";
const MAIL_TO = process.env.MAIL_TO || "gerencia@coluncer.com";
const clean = adminApi.clean;
const htmlEsc = (v) => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* El correo sale por la API web de Resend (HTTPS), porque Render bloquea el correo SMTP en el plan gratuito.
   Variables en Render: RESEND_API_KEY, MAIL_FROM (ej. "COLUNCER Pedidos <pedidos@coluncer.com>"), MAIL_TO. */
async function sendEmail({ subject, text, html, replyTo }) {
  const key = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM;
  if (!key || !from) { console.warn("Correo no configurado (faltan RESEND_API_KEY / MAIL_FROM)"); return false; }
  const r = await fetch(`${RESEND_API_BASE}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [MAIL_TO], subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!r.ok) throw new Error(`Resend respondió ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return true;
}

/* Datos de envío del cliente (se piden ANTES del pago). Devuelve {data} o {error}. */
function validateCustomer(c) {
  c = c && typeof c === "object" ? c : {};
  const d = {
    nombre: clean(c.nombre, 120), doc: clean(c.doc, 30), tel: clean(c.tel, 20), mail: clean(c.mail, 120),
    dep: clean(c.dep, 80), ciu: clean(c.ciu, 80), dir: clean(c.dir, 200), barrio: clean(c.barrio, 300)
  };
  const tel = d.tel.replace(/\D/g, "");
  if (!d.nombre || !d.doc || !d.dep || !d.ciu || !d.dir) return { error: "Faltan datos de envío obligatorios." };
  if (tel.length < 10 || tel.length > 12) return { error: "Celular inválido." };
  if (d.mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.mail)) return { error: "Correo inválido." };
  return { data: d };
}

/* ---- Paso previo al pago: firma de integridad + registro del pedido (productos y datos de envío) ---- */
app.post("/api/wompi-signature", rateLimit, express.json({ limit: "12kb" }), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!originAllowed(req)) return res.status(403).json({ error: "Origen no autorizado." });

  const secret = process.env.WOMPI_INTEGRITY_SECRET;
  if (!secret) return res.status(500).json({ error: "Falta configurar WOMPI_INTEGRITY_SECRET en Render (Environment)." });

  const { reference, amountInCents, currency } = req.body || {};
  if (typeof reference !== "string" || !REFERENCE_PATTERN.test(reference))
    return res.status(400).json({ error: "Referencia inválida." });
  if (!Number.isInteger(amountInCents) || amountInCents <= 0 || amountInCents > MAX_AMOUNT_COP_CENTS)
    return res.status(400).json({ error: "Monto inválido." });
  if (currency !== "COP") return res.status(400).json({ error: "Moneda no soportada." });

  let customer = {};
  if (req.body.customer !== undefined) {
    const v = validateCustomer(req.body.customer);
    if (v.error) return res.status(400).json({ error: v.error });
    customer = v.data;
  }

  const signature = crypto.createHash("sha256")
    .update(`${reference}${amountInCents}${currency}${secret}`).digest("hex");
  res.json({ signature });

  /* Registro del pedido en estado INICIADA. Nunca bloquea el pago. */
  Promise.resolve(db.recordIntent({ reference, amount_cents: amountInCents, items: adminApi.cleanItems(req.body.items), customer }))
    .catch(e => console.error("No se pudo registrar el pedido:", e.message));
});

/* ---- Aviso por correo cuando el pago se confirma (aprobado o pendiente), una sola vez por pedido ---- */
async function notifyOrder(tx) {
  if (!tx || !tx.reference || (tx.status !== "APPROVED" && tx.status !== "PENDING")) return;
  let row = null, prev = null;
  try {
    row = await db.claimNotification(tx.reference, tx.status);
    if (!row) return;
    prev = tx.status === "APPROVED" && row.notified_status !== "APPROVED" ? "PENDING" : null;
    const c = row.customer || {};
    const estado = tx.status === "APPROVED" ? "PAGO APROBADO" : "PAGO PENDIENTE DE CONFIRMAR";
    const monto = Number.isFinite(tx.amount_in_cents) ? "$" + Math.round(tx.amount_in_cents / 100).toLocaleString("es-CO") : "(no disponible)";
    const items = (row.items || []).map(i => `${i.qty || 1}x ${i.name}${i.unit ? " — $" + Math.round(i.unit).toLocaleString("es-CO") + " c/u" : ""}`);
    const rows = [
      ["Estado del pago", estado], ["Referencia", tx.reference], ["ID transacción Wompi", tx.id], ["Monto (según Wompi)", monto],
      ["Medio de pago", tx.payment_method_type || "—"],
      ["Nombre", c.nombre || "—"], ["Documento", c.doc || "—"], ["Celular", c.tel || "—"], ["Correo", c.mail || tx.customer_email || "—"],
      ["Departamento", c.dep || "—"], ["Ciudad", c.ciu || "—"], ["Dirección", c.dir || "—"], ["Indicaciones", c.barrio || "—"]
    ];
    const text = `Nuevo pedido para enviar\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nProductos:\n${items.map(l => "• " + l).join("\n") || "—"}\n`;
    const html = `<h2>Nuevo pedido para enviar</h2><table cellpadding="6" style="border-collapse:collapse">`
      + rows.map(([k, v]) => `<tr><td style="color:#666"><b>${htmlEsc(k)}</b></td><td>${htmlEsc(v)}</td></tr>`).join("")
      + `</table><h3>Productos</h3><ul>${items.map(l => `<li>${htmlEsc(l)}</li>`).join("") || "<li>—</li>"}</ul>`;
    const ok = await sendEmail({ subject: `[COLUNCER] Pedido · ${estado} · ${tx.reference}`, text, html, replyTo: c.mail || undefined });
    if (!ok) await db.releaseNotification(tx.reference, prev);   // correo sin configurar: se reintentará cuando lo esté
  } catch (e) {
    console.error("No se pudo enviar el correo del pedido:", e.message);
    if (row) await db.releaseNotification(tx.reference, prev).catch(() => {});
  }
}

const fs = require("fs");
const WOMPI_API_BASE = process.env.WOMPI_API_BASE || "https://production.wompi.co/v1";
const WHATSAPP = /^\d{10,15}$/.test(process.env.WHATSAPP_NUMBER || "") ? process.env.WHATSAPP_NUMBER : "573117353460";
const TX_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const RESULT_PAGES = {
  aprobado: {
    icon: "✓", title: "Gracias por tu compra",
    lead: "Tu pago fue aprobado y ya recibimos tus datos de envío. Estamos preparando tu pedido. Cuando quieras saber cómo va, rastréalo por WhatsApp.",
    actions: '<a class="btn btn-wa" href="{{TRACK}}" target="_blank" rel="noopener" data-track>Rastrear mi pedido por WhatsApp</a><a class="btn btn-ink" href="/store.html">Seguir comprando</a>'
  },
  pendiente: {
    icon: "…", title: "Estamos confirmando tu pago",
    lead: "Tu pago está en proceso de verificación. Puede tardar unos minutos (más si pagaste por PSE o en efectivo). Ya tenemos tus datos de envío; apenas Wompi lo confirme despachamos. Por favor no vuelvas a pagar, para evitar un cobro doble.",
    actions: '<a class="btn btn-wa" href="{{TRACK}}" target="_blank" rel="noopener" data-track>Rastrear mi pedido por WhatsApp</a><a class="btn btn-ink" href="/">Volver al inicio</a>'
  },
  rechazado: {
    icon: "✕", title: "Tu pago no fue aprobado",
    lead: "No se pudo completar el cobro. Puedes intentarlo de nuevo o con otro medio de pago. Si crees que te descontaron el dinero, escríbenos y lo revisamos contigo.",
    actions: '<a class="btn btn-lime" href="/store.html">Intentar de nuevo</a><a class="btn btn-ink" href="https://wa.me/{{WA}}" target="_blank" rel="noopener">Escribirnos por WhatsApp</a>'
  }
};
const GRACIAS_TEMPLATE = fs.readFileSync(path.join(ROOT, "gracias.html"), "utf8");

function renderGracias(state) {
  const c = RESULT_PAGES[state];
  let html = GRACIAS_TEMPLATE;
  return html
    .replace("{{ACTIONS}}", c.actions).replace(/{{TRACK}}/g, "https://wa.me/{{WA}}")
    .replace(/{{STATE}}/g, state).replace(/{{TITLE}}/g, c.title)
    .replace("{{ICON}}", c.icon).replace("{{LEAD}}", c.lead)
    .replace(/{{WA}}/g, WHATSAPP);
}
for (const state of Object.keys(RESULT_PAGES)) {
  app.get(`/gracias-${state}`, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(renderGracias(state));
  });
}

/* APPROVED → aprobado · PENDING → pendiente · DECLINED / VOIDED / ERROR → rechazado.
   Si no se puede confirmar (Wompi no responde, id raro) → pendiente, nunca "aprobado". */
function stateFromWompi(status) {
  if (status === "APPROVED") return "aprobado";
  if (status === "DECLINED" || status === "VOIDED" || status === "ERROR") return "rechazado";
  return "pendiente";
}
app.get("/pago-resultado", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  /* Wompi puede devolver "?id=…" (o dejar la URL con otro formato): se extrae con tolerancia */
  const rawQs = req.originalUrl.split("?").slice(1).join("?");
  const id = String(req.query.id || (rawQs.match(/(?:^|[?&])id=([A-Za-z0-9_-]{1,64})/) || [])[1] || "");
  const refQ = String(req.query.ref || "").match(/^[A-Za-z0-9_-]{1,80}/);
  if (!TX_ID_PATTERN.test(id)) return res.redirect(302, "/gracias-pendiente" + (refQ ? "?ref=" + refQ[0] : ""));
  try {
    const r = await fetch(`${WOMPI_API_BASE}/transactions/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Wompi respondió ${r.status}`);
    const { data } = await r.json();
    if (data) {
      await Promise.resolve(db.upsertFromWompi(data)).catch(e => console.error("No se pudo guardar la venta:", e.message));
      notifyOrder(data);   // correo con productos + datos de envío (una sola vez); no retrasa la redirección
    }
    const ref = typeof data?.reference === "string" && REFERENCE_PATTERN.test(data.reference) ? data.reference : "";
    const qs = new URLSearchParams({ ...(ref ? { ref } : {}), id }).toString();
    return res.redirect(302, `/gracias-${stateFromWompi(data?.status)}${qs ? "?" + qs : ""}`);
  } catch (e) {
    console.error("No se pudo consultar la transacción", id, e.message);
    return res.redirect(302, "/gracias-pendiente" + (refQ ? "?ref=" + refQ[0] : ""));
  }
});

/* ---- Eventos de Wompi (webhook): mantiene el dashboard al día cuando un pago pendiente se aprueba o se rechaza ----
   En Wompi → Desarrolladores → Seguimiento de transacciones → URL de eventos:  https://coluncer.com/api/wompi-events
   Variable en Render: WOMPI_EVENTS_SECRET (el "secreto de eventos" que muestra Wompi). */
app.post("/api/wompi-events", makeRateLimit(120), express.json({ limit: "32kb" }), async (req, res) => {
  const secret = process.env.WOMPI_EVENTS_SECRET;
  if (!secret) return res.status(503).json({ error: "WOMPI_EVENTS_SECRET no configurado." });
  try {
    const { data, signature, timestamp } = req.body || {};
    const props = signature && Array.isArray(signature.properties) ? signature.properties : null;
    if (!props || !data || typeof signature.checksum !== "string" || timestamp === undefined) return res.status(400).json({ error: "Evento inválido." });
    const values = props.map(p => String(p).split(".").reduce((o, k) => (o == null ? o : o[k]), data));
    if (values.some(v => v === undefined || v === null)) return res.status(400).json({ error: "Evento inválido." });
    const expected = crypto.createHash("sha256").update(values.join("") + timestamp + secret).digest("hex");
    const a = Buffer.from(expected), b = Buffer.from(signature.checksum.toLowerCase());
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Firma inválida." });
    const tx = data.transaction;
    if (tx && TX_ID_PATTERN.test(String(tx.id)) && REFERENCE_PATTERN.test(String(tx.reference))) {
      await db.upsertFromWompi(tx);
      await notifyOrder(tx);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("Evento de Wompi:", e.message);
    res.status(500).json({ error: "Error." });
  }
});

/* ---- Administrador: login y API del dashboard de ventas ---- */
adminApi.mount(app, {
  makeRateLimit, originAllowed,
  diagnostics: () => [
    { key: "wompi_secret", label: "Firma de integridad de Wompi (WOMPI_INTEGRITY_SECRET)", ok: !!process.env.WOMPI_INTEGRITY_SECRET, fix: "Sin ella el pago no abre. Pégala en Render → Environment." },
    { key: "db", label: "Base de datos (DATABASE_URL)", ok: db.enabled(), fix: "Sin ella el dashboard no guarda ventas." },
    { key: "email", label: "Correo de pedidos (RESEND_API_KEY y MAIL_FROM)", ok: !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM), fix: "Sin esto no llega el correo con el pedido." },
    { key: "events", label: "Eventos de Wompi (WOMPI_EVENTS_SECRET)", ok: !!process.env.WOMPI_EVENTS_SECRET, fix: "Opcional: actualiza pagos pendientes que luego se aprueban." },
    { key: "wa", label: "WhatsApp del rastreo (+" + WHATSAPP + ")", ok: true, fix: "" }
  ]
});

app.use("/api", (req, res) => res.status(404).json({ error: "No encontrado." }));

/* ---- Archivos públicos (lista explícita: server.js, package.json, etc. nunca se exponen) ---- */
const page = (file, extra) => (req, res) => {
  if (extra) extra(res);
  res.sendFile(path.join(ROOT, file));
};
app.get(["/", "/index.html"], page("index.html"));
app.get("/store.html", page("store.html"));
app.get("/admin.html", page("admin.html", res => {
  res.setHeader("X-Frame-Options", "DENY");   // el panel nunca dentro de un iframe
  res.setHeader("Cache-Control", "no-store");
}));
app.get("/products.js", page("products.js"));
app.get("/theme.css", page("theme.css"));
app.get("/theme.js", page("theme.js"));
app.get("/checkout.js", page("checkout.js"));
app.get("/products.json", page("products.json", res => res.setHeader("Cache-Control", "no-cache")));
app.use("/media", express.static(path.join(ROOT, "media"), { dotfiles: "deny", index: false, maxAge: "7d" }));
app.use("/images", express.static(path.join(ROOT, "images"), { dotfiles: "deny", index: false, maxAge: "7d" }));

app.get("/healthz", (req, res) => res.type("text").send("ok"));

/* Cualquier otra ruta → inicio (igual que el rewrite que tenía el sitio estático) */
app.use((req, res) => res.status(404).sendFile(path.join(ROOT, "index.html")));

db.init()
  .catch(e => console.error("No se pudo preparar la base de datos:", e.message))
  .finally(() => app.listen(PORT, () => console.log(`COLUNCER escuchando en el puerto ${PORT}`)));
