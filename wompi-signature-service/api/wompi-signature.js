const crypto = require("crypto");

/**
 * Genera la firma de integridad de Wompi de forma segura, del lado del servidor.
 * El secreto de integridad NUNCA se expone al navegador: vive solo en la
 * variable de entorno WOMPI_INTEGRITY_SECRET, configurada en Vercel.
 *
 * Fórmula oficial de Wompi:
 *   SHA256(referencia + montoEnCentavos + moneda + secretoDeIntegridad)
 *
 * Body esperado (JSON): { reference, amountInCents, currency }
 * Respuesta: { signature }
 */
module.exports = async (req, res) => {
  // CORS: permite que el sitio de Coluncer (u otro origen que definas) llame esta función.
  const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método no permitido. Usa POST." });
    return;
  }

  const secret = process.env.WOMPI_INTEGRITY_SECRET;
  if (!secret) {
    res.status(500).json({ error: "Falta configurar WOMPI_INTEGRITY_SECRET en las variables de entorno de Vercel." });
    return;
  }

  let body = req.body;
  if (!body || typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch (e) { body = {}; }
  }

  const { reference, amountInCents, currency } = body || {};
  if (!reference || !amountInCents || !currency) {
    res.status(400).json({ error: "Faltan datos requeridos: reference, amountInCents, currency." });
    return;
  }

  const chain = `${reference}${amountInCents}${currency}${secret}`;
  const signature = crypto.createHash("sha256").update(chain).digest("hex");

  res.status(200).json({ signature });
};
