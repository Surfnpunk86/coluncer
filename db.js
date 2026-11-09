/**
 * Capa de datos de ventas (Postgres).
 * Variable de entorno: DATABASE_URL (Neon, Supabase, Render Postgres…). Sin ella, el sitio funciona igual
 * (la tienda y los pagos no dependen de la base) y el dashboard avisa que falta conectarla.
 */
const { Pool, types } = require("pg");
types.setTypeParser(20, v => Number(v));   // BIGINT → número (montos y ids caben de sobra)

let pool = null;
const enabled = () => !!process.env.DATABASE_URL;

function getPool() {
  if (!enabled()) return null;
  if (!pool) {
    const url = process.env.DATABASE_URL;
    const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(url);
    const ssl = process.env.DATABASE_SSL === "disable" || local ? false : { rejectUnauthorized: false };
    pool = new Pool({ connectionString: url, ssl, max: 5, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000 });
    pool.on("error", e => console.error("Postgres (conexión inactiva):", e.message));
  }
  return pool;
}
const q = (text, params) => getPool().query(text, params);

async function init() {
  if (!enabled()) { console.warn("DATABASE_URL no configurada: el dashboard de ventas no guardará datos."); return false; }
  await q(`
    CREATE TABLE IF NOT EXISTS sales (
      id             BIGSERIAL PRIMARY KEY,
      source         TEXT NOT NULL DEFAULT 'wompi',        -- wompi | manual
      reference      TEXT NOT NULL UNIQUE,
      wompi_id       TEXT,
      status         TEXT NOT NULL DEFAULT 'INICIADA',     -- INICIADA | PENDING | APPROVED | DECLINED | VOIDED | ERROR
      amount_cents   BIGINT NOT NULL DEFAULT 0,
      payment_method TEXT,
      channel        TEXT,
      items          JSONB NOT NULL DEFAULT '[]'::jsonb,
      customer       JSONB NOT NULL DEFAULT '{}'::jsonb,
      fulfillment    TEXT NOT NULL DEFAULT 'nuevo',        -- nuevo | preparando | enviado | entregado | cancelado
      tracking       TEXT,
      notes          TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at        TIMESTAMPTZ,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS notified_status TEXT;   -- último estado por el que se envió el correo de pedido
    CREATE INDEX IF NOT EXISTS sales_created_idx ON sales (created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS sales_wompi_idx ON sales (wompi_id) WHERE wompi_id IS NOT NULL;
  `);
  return true;
}

const FINAL = ["APPROVED", "DECLINED", "VOIDED", "ERROR"];

/* Sin base de datos, los pedidos en curso se guardan en memoria (se pierden si Render reinicia; solo sirve
   para poder enviar el correo cuando el pago se confirma poco después). */
const mem = new Map();
function memPut(reference, patch) {
  const cur = mem.get(reference) || { reference, items: [], customer: {}, status: "INICIADA", notified_status: null };
  mem.set(reference, { ...cur, ...patch, ts: Date.now() });
  if (mem.size > 500) { const old = [...mem.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]; mem.delete(old[0]); }
}

/* El pedido (productos + datos de envío) se registra ANTES del pago, con estado INICIADA. */
async function recordIntent({ reference, amount_cents, items, customer }) {
  if (!enabled()) { memPut(reference, { amount_cents, items: items || [], customer: customer || {} }); return; }
  await q(
    `INSERT INTO sales (source, reference, status, amount_cents, items, customer)
     VALUES ('wompi', $1, 'INICIADA', $2, $3::jsonb, $4::jsonb)
     ON CONFLICT (reference) DO UPDATE SET
       items = EXCLUDED.items, customer = sales.customer || EXCLUDED.customer, amount_cents = EXCLUDED.amount_cents, updated_at = now()
     WHERE sales.status = 'INICIADA'`,
    [reference, amount_cents, JSON.stringify(items || []), JSON.stringify(customer || {})]
  );
}

/* Reclama el aviso por correo de un pedido: devuelve la fila solo la primera vez que el pago está PENDIENTE o
   APROBADO (y una segunda vez si pasa de pendiente a aprobado). Evita correos repetidos. */
async function claimNotification(reference, status) {
  if (status !== "APPROVED" && status !== "PENDING") return null;
  if (!enabled()) {
    const m = mem.get(reference); if (!m) return null;
    if (m.notified_status === null || (m.notified_status === "PENDING" && status === "APPROVED")) {
      m.notified_status = status; return m;
    }
    return null;
  }
  const { rows } = await q(
    `UPDATE sales SET notified_status = $2 WHERE reference = $1
       AND (notified_status IS NULL OR (notified_status = 'PENDING' AND $2 = 'APPROVED'))
     RETURNING ${COLS}`, [reference, status]);
  return rows[0] || null;
}
async function releaseNotification(reference, previous) {   // si el correo falla, se podrá reintentar
  if (!enabled()) { const m = mem.get(reference); if (m) m.notified_status = previous; return; }
  await q(`UPDATE sales SET notified_status = $2 WHERE reference = $1`, [reference, previous]);
}

/* Estado real según Wompi (por la página de resultado, por el webhook o al enviar el formulario de envío). */
async function upsertFromWompi(tx) {
  if (!tx || !tx.reference || !tx.id) return;
  if (!enabled()) { memPut(tx.reference, { status: tx.status, wompi_id: tx.id }); return; }
  const approved = tx.status === "APPROVED";
  const customer = tx.customer_email ? { email: String(tx.customer_email).slice(0, 120) } : {};
  await q(
    `INSERT INTO sales (source, reference, wompi_id, status, amount_cents, payment_method, customer, paid_at)
     VALUES ('wompi', $1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (reference) DO UPDATE SET
       wompi_id       = EXCLUDED.wompi_id,
       status         = CASE WHEN sales.status = 'APPROVED' THEN sales.status ELSE EXCLUDED.status END,
       amount_cents   = EXCLUDED.amount_cents,
       payment_method = COALESCE(EXCLUDED.payment_method, sales.payment_method),
       customer       = EXCLUDED.customer || sales.customer,
       paid_at        = COALESCE(sales.paid_at, EXCLUDED.paid_at),
       updated_at     = now()`,
    [tx.reference, tx.id, tx.status || "PENDING", Number.isFinite(tx.amount_in_cents) ? tx.amount_in_cents : 0,
     tx.payment_method_type || null, JSON.stringify(customer), approved ? (tx.finalized_at || new Date().toISOString()) : null]
  );
}

const COLS = `id, source, reference, wompi_id, status, amount_cents, payment_method, channel, items, customer,
              fulfillment, tracking, notes, created_at, paid_at, updated_at`;

async function list({ from, to, status, fulfillment, source, search, includeStarted, limit = 2000 }) {
  const w = [], p = [];
  const add = (sql, v) => { p.push(v); w.push(sql.replace("?", "$" + p.length)); };
  if (from) add("COALESCE(paid_at, created_at) >= ?", from);
  if (to) add("COALESCE(paid_at, created_at) < ?", to);
  if (status) add("status = ?", status);
  else if (!includeStarted) w.push("status <> 'INICIADA'");
  if (fulfillment) add("fulfillment = ?", fulfillment);
  if (source) add("source = ?", source);
  if (search) {
    p.push("%" + search.replace(/[%_\\]/g, m => "\\" + m) + "%");
    w.push(`(reference ILIKE $${p.length} OR customer::text ILIKE $${p.length} OR items::text ILIKE $${p.length} OR COALESCE(tracking,'') ILIKE $${p.length})`);
  }
  p.push(Math.min(Number(limit) || 2000, 5000));
  const { rows } = await q(
    `SELECT ${COLS} FROM sales ${w.length ? "WHERE " + w.join(" AND ") : ""}
     ORDER BY COALESCE(paid_at, created_at) DESC, id DESC LIMIT $${p.length}`, p);
  return rows;
}

async function get(id) {
  const { rows } = await q(`SELECT ${COLS} FROM sales WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function createManual(s) {
  const { rows } = await q(
    `INSERT INTO sales (source, reference, status, amount_cents, payment_method, channel, items, customer, fulfillment, notes, created_at, paid_at)
     VALUES ('manual', $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11) RETURNING ${COLS}`,
    [s.reference, s.status, s.amount_cents, s.payment_method, s.channel, JSON.stringify(s.items), JSON.stringify(s.customer),
     s.fulfillment, s.notes, s.date, s.status === "APPROVED" ? s.date : null]
  );
  return rows[0];
}

/* Campos editables: siempre envío/guía/notas/cliente; en ventas manuales también pago, monto, canal y productos. */
async function update(id, patch) {
  const cur = await get(id);
  if (!cur) return null;
  const set = [], p = [];
  const put = (col, v, cast = "") => { p.push(v); set.push(`${col} = $${p.length}${cast}`); };
  if (patch.fulfillment !== undefined) put("fulfillment", patch.fulfillment);
  if (patch.tracking !== undefined) put("tracking", patch.tracking);
  if (patch.notes !== undefined) put("notes", patch.notes);
  if (patch.customer !== undefined) put("customer", JSON.stringify({ ...cur.customer, ...patch.customer }), "::jsonb");
  if (cur.source === "manual") {
    if (patch.status !== undefined) {
      put("status", patch.status);
      if (patch.status === "APPROVED" && !cur.paid_at) put("paid_at", new Date().toISOString());
    }
    if (patch.amount_cents !== undefined) put("amount_cents", patch.amount_cents);
    if (patch.channel !== undefined) put("channel", patch.channel);
    if (patch.payment_method !== undefined) put("payment_method", patch.payment_method);
    if (patch.items !== undefined) put("items", JSON.stringify(patch.items), "::jsonb");
  }
  if (!set.length) return cur;
  set.push("updated_at = now()");
  p.push(id);
  const { rows } = await q(`UPDATE sales SET ${set.join(", ")} WHERE id = $${p.length} RETURNING ${COLS}`, p);
  return rows[0];
}

async function removeManual(id) {
  const r = await q(`DELETE FROM sales WHERE id = $1 AND source = 'manual'`, [id]);
  return r.rowCount > 0;
}

module.exports = { enabled, init, recordIntent, upsertFromWompi, claimNotification, releaseNotification, list, get, createManual, update, removeManual, FINAL };
