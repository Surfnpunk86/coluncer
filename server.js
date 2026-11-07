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
function makeRateLimit(max) {
  const hits = new Map();
  setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (t > v.reset) hits.delete(k); }, 5 * 60_000).unref();
  return (req, res, next) => {
    const now = Date.now();
    const rec = hits.get(req.ip) || { n: 0, reset: now + 60_000 };
    if (now > rec.reset) { rec.n = 0; rec.reset = now + 60_000; }
    rec.n += 1;
    hits.set(req.ip, rec);
    if (rec.n > max) return res.status(429).json({ error: "Demasiadas solicitudes. Intenta en un minuto." });
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

app.post("/api/wompi-signature", rateLimit, express.json({ limit: "2kb" }), (req, res) => {
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

  const signature = crypto.createHash("sha256")
    .update(`${reference}${amountInCents}${currency}${secret}`).digest("hex");
  res.json({ signature });
});

/* ---- Datos de envío → correo ----
   Solo se envían si Wompi confirma que la transacción existe y está APROBADA o PENDIENTE
   (así nadie puede llenar tu bandeja con pedidos falsos). El correo sale por la API web de Resend
   (HTTPS), porque Render bloquea el correo por SMTP en el plan gratuito.
   Variables en Render: RESEND_API_KEY, MAIL_FROM (ej. "COLUNCER Pedidos <pedidos@coluncer.com>"), MAIL_TO. */
const RESEND_API_BASE = process.env.RESEND_API_BASE || "https://api.resend.com";
const MAIL_TO = process.env.MAIL_TO || "gerencia@coluncer.com";
const emailed = new Map(); // id de transacción → veces enviado (evita repetir el mismo correo)

const clean = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
const htmlEsc = (v) => String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

app.post("/api/envio", shipLimit, express.json({ limit: "8kb" }), async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!originAllowed(req)) return res.status(403).json({ error: "Origen no autorizado." });
  const b = req.body || {};

  const d = {
    nombre: clean(b.nombre, 120), doc: clean(b.doc, 30), tel: clean(b.tel, 20), mail: clean(b.mail, 120),
    dep: clean(b.dep, 80), ciu: clean(b.ciu, 80), dir: clean(b.dir, 200), barrio: clean(b.barrio, 300)
  };
  const telDigits = d.tel.replace(/\D/g, "");
  if (!d.nombre || !d.doc || !d.dep || !d.ciu || !d.dir) return res.status(400).json({ error: "Faltan datos obligatorios." });
  if (telDigits.length < 10 || telDigits.length > 12) return res.status(400).json({ error: "Celular inválido." });
  if (d.mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.mail)) return res.status(400).json({ error: "Correo inválido." });
  if (b.consent !== true) return res.status(400).json({ error: "Falta la autorización de datos." });

  /* Sin id de transacción verificable no hay correo: el cliente igual sigue por WhatsApp. */
  const id = String(b.id || "");
  if (!TX_ID_PATTERN.test(id)) return res.json({ ok: true, emailed: false, reason: "sin_verificar" });

  try {
    const r = await fetch(`${WOMPI_API_BASE}/transactions/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.json({ ok: true, emailed: false, reason: "sin_verificar" });
    const tx = (await r.json()).data || {};
    if (tx.status !== "APPROVED" && tx.status !== "PENDING") return res.json({ ok: true, emailed: false, reason: "pago_no_valido" });
    if ((emailed.get(id) || 0) >= 3) return res.json({ ok: true, emailed: true, repeated: true });

    const estado = tx.status === "APPROVED" ? "PAGO APROBADO" : "PAGO PENDIENTE DE CONFIRMAR";
    const monto = Number.isFinite(tx.amount_in_cents) ? "$" + Math.round(tx.amount_in_cents / 100).toLocaleString("es-CO") : "(no disponible)";
    const ref = clean(tx.reference, 80) || "(sin referencia)";
    const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 20).map(l => clean(l, 200)).filter(Boolean);

    const rows = [
      ["Estado del pago", estado], ["Referencia", ref], ["ID transacción Wompi", id], ["Monto (según Wompi)", monto],
      ["Nombre", d.nombre], ["Documento", d.doc], ["Celular", d.tel], ["Correo", d.mail || "—"],
      ["Departamento", d.dep], ["Ciudad", d.ciu], ["Dirección", d.dir], ["Indicaciones", d.barrio || "—"]
    ];
    const text = `Nuevo pedido para enviar\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nProductos (según el cliente):\n${lines.map(l => "• " + l).join("\n") || "—"}\n`;
    const html = `<h2>Nuevo pedido para enviar</h2><table cellpadding="6" style="border-collapse:collapse">`
      + rows.map(([k, v]) => `<tr><td style="color:#666"><b>${htmlEsc(k)}</b></td><td>${htmlEsc(v)}</td></tr>`).join("")
      + `</table><h3>Productos (según el cliente)</h3><ul>${lines.map(l => `<li>${htmlEsc(l)}</li>`).join("") || "<li>—</li>"}</ul>`;

    const ok = await sendEmail({ subject: `[COLUNCER] Datos de envío · ${estado} · ${ref}`, text, html, replyTo: d.mail || undefined });
    if (ok) emailed.set(id, (emailed.get(id) || 0) + 1);
    return res.json({ ok: true, emailed: ok });
  } catch (e) {
    console.error("No se pudo enviar el correo de envío:", e.message);
    return res.json({ ok: true, emailed: false, reason: "error_correo" });
  }
});

app.use("/api", (req, res) => res.status(404).json({ error: "No encontrado." }));

/* ---- Resultado del pago: Wompi → /pago-resultado → /gracias-aprobado | -pendiente | -rechazado ----
   Wompi devuelve al cliente a la URL de retorno con ?id=<id de transacción>. Aquí consultamos el
   estado REAL a la API de Wompi (no confiamos en lo que diga el navegador) y redirigimos. */
const fs = require("fs");
const WOMPI_API_BASE = process.env.WOMPI_API_BASE || "https://production.wompi.co/v1";
const WHATSAPP = /^\d{10,15}$/.test(process.env.WHATSAPP_NUMBER || "") ? process.env.WHATSAPP_NUMBER : "573016315921";
const TX_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

const RESULT_PAGES = {
  aprobado: {
    icon: "✓", title: "Gracias por tu compra",
    lead: "Tu pago fue aprobado. Ya estamos preparando tu pedido: completa tus datos de envío aquí abajo para que podamos despacharlo.",
    formSub: "Déjanos tus datos de envío: los recibimos por correo y por WhatsApp para coordinar la entrega contigo.",
    actions: '<a class="btn btn-ink" href="/store.html">Seguir comprando</a>'
  },
  pendiente: {
    icon: "…", title: "Estamos confirmando tu pago",
    lead: "Tu pago está en proceso de verificación. Puede tardar unos minutos (más si pagaste por PSE o en efectivo). Te avisaremos apenas Wompi lo confirme. Por favor no vuelvas a pagar, para evitar un cobro doble.",
    formSub: "Mientras confirmamos tu pago puedes dejarnos tus datos de envío, así adelantamos tu pedido. Los recibimos por correo y por WhatsApp.",
    actions: '<a class="btn btn-lime" href="https://wa.me/{{WA}}" target="_blank" rel="noopener">Escribirnos por WhatsApp</a><a class="btn btn-ink" href="/">Volver al inicio</a>'
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
  if (state === "rechazado") html = html.replace(/<!--IF_FORM-->[\s\S]*?<!--\/IF_FORM-->/, "");
  return html
    .replace("{{ACTIONS}}", c.actions)
    .replace(/{{STATE}}/g, state).replace(/{{TITLE}}/g, c.title)
    .replace("{{ICON}}", c.icon).replace("{{LEAD}}", c.lead).replace("{{FORM_SUB}}", c.formSub || "")
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
  const id = String(req.query.id || "");
  if (!TX_ID_PATTERN.test(id)) return res.redirect(302, "/gracias-pendiente");
  try {
    const r = await fetch(`${WOMPI_API_BASE}/transactions/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Wompi respondió ${r.status}`);
    const { data } = await r.json();
    const ref = typeof data?.reference === "string" && REFERENCE_PATTERN.test(data.reference) ? data.reference : "";
    const qs = new URLSearchParams({ ...(ref ? { ref } : {}), id }).toString();
    return res.redirect(302, `/gracias-${stateFromWompi(data?.status)}${qs ? "?" + qs : ""}`);
  } catch (e) {
    console.error("No se pudo consultar la transacción", id, e.message);
    return res.redirect(302, "/gracias-pendiente");
  }
});

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
app.get("/products.json", page("products.json", res => res.setHeader("Cache-Control", "no-cache")));
app.use("/images", express.static(path.join(ROOT, "images"), { dotfiles: "deny", index: false, maxAge: "7d" }));

app.get("/healthz", (req, res) => res.type("text").send("ok"));

/* Cualquier otra ruta → inicio (igual que el rewrite que tenía el sitio estático) */
app.use((req, res) => res.status(404).sendFile(path.join(ROOT, "index.html")));

app.listen(PORT, () => console.log(`COLUNCER escuchando en el puerto ${PORT}`));
