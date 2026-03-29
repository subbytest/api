// api/db.js — Neon PostgreSQL REST proxy
import { neon } from '@neondatabase/serverless';

// Naikkan body size limit — default Vercel hanya 1MB, foto base64 bisa 200-500KB
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

const sql = neon(process.env.DATABASE_URL);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, Prefer',
  'Content-Type': 'application/json',
};

// Whitelist tabel yang boleh diakses — cegah akses ke tabel sistem
const ALLOWED_TABLES = new Set([
  // Duitku
  'dk_users', 'dk_wallets', 'dk_trx', 'dk_budgets', 'dk_savings', 'dk_routines',
  // Brompit
  'rl_users', 'rl_motors', 'rl_bbm', 'rl_fuel', 'rl_parts', 'rl_service',
  // Tanduran
  'bq_users', 'bq_plants', 'bq_journals', 'bq_photos', 'bq_usermeta'
]);

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 200;

function escapeHtml(str) {
  // Tidak dipakai di sini tapi tersedia kalau perlu
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function parseQuery(query) {
  const where = [];
  const values = [];
  let order = null;
  let select = '*';
  let limit = DEFAULT_LIMIT;
  let idx = 1;

  for (const [key, val] of Object.entries(query)) {
    if (key === 'order') {
      const dotIdx = val.indexOf('.');
      const col = dotIdx !== -1 ? val.substring(0, dotIdx) : val;
      const dir = dotIdx !== -1 ? val.substring(dotIdx + 1) : 'asc';
      const safeCol = col.replace(/[^a-z0-9_]/gi, '');
      const safeDir = dir === 'desc' ? 'DESC' : 'ASC';
      if (safeCol) order = `${safeCol} ${safeDir}`;
      continue;
    }
    if (key === 'select') {
      const cleaned = val.split(',').map(c => c.trim().replace(/[^a-z0-9_*]/gi, '')).filter(Boolean).join(', ');
      if (cleaned) select = cleaned;
      continue;
    }
    if (key === 'limit') {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n > 0) limit = Math.min(n, MAX_LIMIT);
      continue;
    }

    const dotIdx = val.indexOf('.');
    if (dotIdx === -1) continue;
    const op = val.substring(0, dotIdx);
    const operand = val.substring(dotIdx + 1);
    const safeKey = key.replace(/[^a-z0-9_]/gi, '');
    if (!safeKey) continue;

    switch (op) {
      case 'eq':
        if (operand === 'null') {
          where.push(`${safeKey} IS NULL`);
        } else {
          where.push(`${safeKey} = $${idx++}`);
          values.push(operand);
        }
        break;
      case 'neq':
        if (operand === 'null') {
          where.push(`${safeKey} IS NOT NULL`);
        } else {
          where.push(`${safeKey} != $${idx++}`);
          values.push(operand);
        }
        break;
      case 'is':
        where.push(operand === 'null' ? `${safeKey} IS NULL` : `${safeKey} IS NOT NULL`);
        break;
      case 'gt':
        where.push(`${safeKey} > $${idx++}`); values.push(operand); break;
      case 'gte':
        where.push(`${safeKey} >= $${idx++}`); values.push(operand); break;
      case 'lt':
        where.push(`${safeKey} < $${idx++}`); values.push(operand); break;
      case 'lte':
        where.push(`${safeKey} <= $${idx++}`); values.push(operand); break;
      case 'like':
        where.push(`${safeKey} LIKE $${idx++}`); values.push(operand); break;
      case 'ilike':
        where.push(`${safeKey} ILIKE $${idx++}`); values.push(operand); break;
    }
  }

  return { where, values, order, select, limit };
}

export default async function handler(req, res) {
  // Preflight
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).end();
  }

  // Set CORS on all responses
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  // Ambil nama tabel dari URL path: /api/db/dk_users → dk_users
  const urlPath = req.url.split('?')[0];
  const urlParts = urlPath.split('/').filter(Boolean);
  const table = urlParts[urlParts.length - 1];

  // Validasi nama tabel
  if (!table || !/^[a-z][a-z0-9_]*$/.test(table)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }

  // Whitelist check — cegah akses ke tabel sistem/tidak dikenal
  if (!ALLOWED_TABLES.has(table)) {
    return res.status(403).json({ error: 'Table not allowed' });
  }

  const filters = req.query;

  try {
    // ── GET ───────────────────────────────────────────────
    if (req.method === 'GET') {
      const { where, values, order, select, limit } = parseQuery(filters);
      let q = `SELECT ${select} FROM ${table}`;
      if (where.length) q += ` WHERE ${where.join(' AND ')}`;
      if (order) q += ` ORDER BY ${order}`;
      q += ` LIMIT ${limit}`;
      const rows = await sql(q, values);
      return res.status(200).json(rows);
    }

    // ── POST ──────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Body must be a JSON object' });
      }
      const keys = Object.keys(body);
      if (!keys.length) {
        return res.status(400).json({ error: 'Body cannot be empty' });
      }
      const safeCols = keys.map(k => k.replace(/[^a-z0-9_]/gi, '')).filter(Boolean);
      if (safeCols.length !== keys.length) {
        return res.status(400).json({ error: 'Invalid column name in body' });
      }
      const cols = safeCols.join(', ');
      const placeholders = safeCols.map((_, i) => `$${i + 1}`).join(', ');
      const vals = keys.map(k => body[k] === undefined ? null : body[k]);
      const q = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`;
      const rows = await sql(q, vals);
      return res.status(201).json(rows);
    }

    // ── PATCH ─────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Body must be a JSON object' });
      }
      const keys = Object.keys(body);
      if (!keys.length) {
        return res.status(400).json({ error: 'Body cannot be empty' });
      }
      const { where, values } = parseQuery(filters);
      if (!where.length) {
        return res.status(400).json({ error: 'PATCH requires at least one filter' });
      }
      let idx = values.length + 1;
      const safeCols = keys.map(k => k.replace(/[^a-z0-9_]/gi, '')).filter(Boolean);
      if (safeCols.length !== keys.length) {
        return res.status(400).json({ error: 'Invalid column name in body' });
      }
      const sets = safeCols.map(k => `${k} = $${idx++}`).join(', ');
      const vals = [...values, ...keys.map(k => body[k] === undefined ? null : body[k])];
      const q = `UPDATE ${table} SET ${sets} WHERE ${where.join(' AND ')} RETURNING *`;
      const rows = await sql(q, vals);
      return res.status(200).json(rows);
    }

    // ── DELETE ────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const { where, values } = parseQuery(filters);
      if (!where.length) {
        return res.status(400).json({ error: 'DELETE requires at least one filter' });
      }
      const q = `DELETE FROM ${table} WHERE ${where.join(' AND ')} RETURNING *`;
      const rows = await sql(q, values);
      return res.status(200).json(rows);
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error(`[db] ${req.method} ${table}:`, err.message);
    return res.status(500).json({ error: err.message });
  }
}
