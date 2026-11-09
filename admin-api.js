/**
 * Acceso de administrador (login real en el servidor) y API del dashboard de ventas.
 * Variables de entorno (Render → Environment):
 *   ADMIN_USER       usuario (por defecto "admin")
 *   ADMIN_PASSWORD   contraseña (mínimo 10 caracteres). Sin ella el panel queda bloqueado.
 *   SESSION_SECRET   texto largo y aleatorio para firmar la sesión (si falta, se genera uno al arrancar y
 *                    las sesiones se cierran cada vez que Render reinicia el servicio).
 */
const crypto = require("crypto");
const express = require("express");
const db = require("./db");

const SESSION_HOURS = 8;
const COOKIE = "coluncer_admin";
const FULFILLMENT = ["nuevo", "preparando", "enviado", "entregado", "cancelado"];
const MANUAL_STATUS = ["APPROVED", "PENDING", "VOIDED"];

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET no definido: las sesiones de admin se cerrarán en cada reinicio.");

const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = payload => crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");

function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + SESSION_HOURS * 3600_000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function readToken(token) {
  if (typeof token !== "string") return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}
function cookieOf(req, name) {
  const m = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}
const setCookie = (req, res, value, maxAgeSec) =>
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${req.secure ? "; Secure" : ""}`);

const configured = () => (process.env.ADMIN_PASSWORD || "").length >= 10;

/* Texto limpio y acotado (sin caracteres de control) */
const clean = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);

function cleanItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 30).map(i => ({
    name: clean(i && i.name, 140),
    qty: Math.min(Math.max(parseInt(i && i.qty, 10) || 1, 1), 999),
    unit: Math.max(Math.round(Number(i && i.unit) || 0), 0)   // COP por unidad (puede ser 0 si no se conoce)
  })).filter(i => i.name);
}
function cleanCustomer(c) {
  c = c || {};
  const o = {};
  for (const [k, max] of [["nombre", 120], ["doc", 30], ["tel", 20], ["mail", 120], ["dep", 80], ["ciu", 80], ["dir", 200], ["barrio", 300]])
    if (c[k] !== undefined) o[k] = clean(c[k], max);
  return o;
}

function mount(app, { makeRateLimit, originAllowed, diagnostics }) {
  const loginLimit = makeRateLimit(8, 15 * 60_000);   // 8 intentos cada 15 min por IP
  const apiLimit = makeRateLimit(120, 60_000);
  const json = express.json({ limit: "20kb" });
  const nostore = (req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); };

  app.post("/api/admin/login", nostore, loginLimit, json, async (req, res) => {
    if (!originAllowed(req)) return res.status(403).json({ error: "Origen no autorizado." });
    if (!configured()) return res.status(503).json({ error: "no_configurado" });
    const { user, password } = req.body || {};
    const okUser = safeEq(user ?? "", process.env.ADMIN_USER || "admin");
    const okPass = safeEq(password ?? "", process.env.ADMIN_PASSWORD);
    if (!(okUser && okPass)) {
      await new Promise(r => setTimeout(r, 400));   // frena la fuerza bruta
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }
    setCookie(req, res, makeToken(process.env.ADMIN_USER || "admin"), SESSION_HOURS * 3600);
    res.json({ ok: true });
  });

  app.post("/api/admin/logout", nostore, (req, res) => { setCookie(req, res, "", 0); res.json({ ok: true }); });

  app.get("/api/admin/me", nostore, (req, res) => {
    const s = readToken(cookieOf(req, COOKIE));
    res.json({ ok: !!s, configured: configured(), db: db.enabled() });
  });

  /* Todo lo que sigue exige sesión válida */
  const guard = (req, res, next) => {
    if (!readToken(cookieOf(req, COOKIE))) return res.status(401).json({ error: "Sesión vencida. Inicia sesión de nuevo." });
    if (req.method !== "GET" && !originAllowed(req)) return res.status(403).json({ error: "Origen no autorizado." });
    if (!db.enabled()) return res.status(503).json({ error: "sin_base", message: "Falta conectar la base de datos (DATABASE_URL en Render)." });
    next();
  };
  const fail = (res, e) => { console.error("API admin:", e.message); res.status(500).json({ error: "Error del servidor." }); };

  /* Estado de la configuración (solo sí/no, nunca los valores secretos) */
  app.get("/api/admin/diagnostico", nostore, apiLimit, (req, res) => {
    if (!readToken(cookieOf(req, COOKIE))) return res.status(401).json({ error: "Sesión vencida. Inicia sesión de nuevo." });
    res.json({ checks: typeof diagnostics === "function" ? diagnostics() : [] });
  });

  app.get("/api/admin/sales", nostore, apiLimit, guard, async (req, res) => {
    try {
      const qy = req.query;
      const date = v => { const d = new Date(String(v)); return isNaN(d) ? null : d.toISOString(); };
      const rows = await db.list({
        from: qy.from ? date(qy.from) : null,
        to: qy.to ? date(qy.to) : null,
        status: ["APPROVED", "PENDING", "DECLINED", "VOIDED", "ERROR", "INICIADA"].includes(qy.status) ? qy.status : null,
        fulfillment: FULFILLMENT.includes(qy.fulfillment) ? qy.fulfillment : null,
        source: ["wompi", "manual"].includes(qy.source) ? qy.source : null,
        search: clean(qy.q, 80),
        includeStarted: qy.started === "1"
      });
      res.json({ sales: rows });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/admin/sales", nostore, apiLimit, guard, json, async (req, res) => {
    try {
      const b = req.body || {};
      const items = cleanItems(b.items);
      const customer = cleanCustomer(b.customer);
      if (!items.length && !(Number(b.amount) > 0)) return res.status(400).json({ error: "Agrega al menos un producto o un monto." });
      const status = MANUAL_STATUS.includes(b.status) ? b.status : "APPROVED";
      const fromItems = items.reduce((t, i) => t + i.unit * i.qty, 0);
      const amount = Math.round(Number(b.amount) > 0 ? Number(b.amount) : fromItems);
      if (!(amount > 0) || amount > 2_000_000_000) return res.status(400).json({ error: "Monto inválido." });
      const d = b.date ? new Date(b.date) : new Date();
      const row = await db.createManual({
        reference: `M-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
        status, amount_cents: amount * 100,
        payment_method: clean(b.payment_method, 40) || null,
        channel: clean(b.channel, 40) || "Manual",
        items, customer,
        fulfillment: FULFILLMENT.includes(b.fulfillment) ? b.fulfillment : "nuevo",
        notes: clean(b.notes, 500) || null,
        date: isNaN(d) ? new Date().toISOString() : d.toISOString()
      });
      res.status(201).json({ sale: row });
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/admin/sales/:id", nostore, apiLimit, guard, json, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!(id > 0)) return res.status(400).json({ error: "Id inválido." });
      const b = req.body || {}, patch = {};
      if (b.fulfillment !== undefined) {
        if (!FULFILLMENT.includes(b.fulfillment)) return res.status(400).json({ error: "Estado de envío inválido." });
        patch.fulfillment = b.fulfillment;
      }
      if (b.tracking !== undefined) patch.tracking = clean(b.tracking, 120) || null;
      if (b.notes !== undefined) patch.notes = clean(b.notes, 500) || null;
      if (b.customer !== undefined) patch.customer = cleanCustomer(b.customer);
      if (b.status !== undefined) { if (!MANUAL_STATUS.includes(b.status)) return res.status(400).json({ error: "Estado de pago inválido." }); patch.status = b.status; }
      if (b.amount !== undefined) { const a = Math.round(Number(b.amount)); if (!(a > 0) || a > 2_000_000_000) return res.status(400).json({ error: "Monto inválido." }); patch.amount_cents = a * 100; }
      if (b.channel !== undefined) patch.channel = clean(b.channel, 40) || null;
      if (b.payment_method !== undefined) patch.payment_method = clean(b.payment_method, 40) || null;
      if (b.items !== undefined) patch.items = cleanItems(b.items);
      const row = await db.update(id, patch);
      if (!row) return res.status(404).json({ error: "Venta no encontrada." });
      res.json({ sale: row });
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/admin/sales/:id", nostore, apiLimit, guard, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!(id > 0)) return res.status(400).json({ error: "Id inválido." });
      const ok = await db.removeManual(id);
      if (!ok) return res.status(400).json({ error: "Solo se pueden eliminar ventas manuales." });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { mount, clean, cleanItems };
