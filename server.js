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

/* Límite sencillo por IP: 30 firmas por minuto */
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const rec = hits.get(req.ip) || { n: 0, reset: now + 60_000 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 60_000; }
  rec.n += 1;
  hits.set(req.ip, rec);
  if (rec.n > 30) return res.status(429).json({ error: "Demasiadas solicitudes. Intenta en un minuto." });
  next();
}
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (t > v.reset) hits.delete(k); }, 5 * 60_000).unref();

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
app.get("/products.json", page("products.json", res => res.setHeader("Cache-Control", "no-cache")));
app.use("/images", express.static(path.join(ROOT, "images"), { dotfiles: "deny", index: false, maxAge: "7d" }));

app.get("/healthz", (req, res) => res.type("text").send("ok"));

/* Cualquier otra ruta → inicio (igual que el rewrite que tenía el sitio estático) */
app.use((req, res) => res.status(404).sendFile(path.join(ROOT, "index.html")));

app.listen(PORT, () => console.log(`COLUNCER escuchando en el puerto ${PORT}`));
