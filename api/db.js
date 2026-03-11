import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, Prefer',
  'Content-Type': 'application/json',
};

function parseQuery(query) {
  const where = [];
  const values = [];
  let order = null;
  let select = '*';
  let idx = 1;

  for (const [key, val] of Object.entries(query)) {
    if (key === 'order') {
      const [col, dir] = val.split('.');
      const safeCol = col.replace(/[^a-z0-9_]/gi, '');
      const safeDir = dir === 'desc' ? 'DESC' : 'ASC';
      order = `${safeCol} ${safeDir}`;
      continue;
    }
    if (key === 'select') {
      select = val.split(',').map(c => c.trim().replace(/[^a-z0-9_*]/gi, '')).join(', ');
      continue;
    }

    const dotIdx = val.indexOf('.');
    if (dotIdx === -1) continue;
    const op = val.substring(0, dotIdx);
    const operand = val.substring(dotIdx + 1);
    const safeKey = key.replace(/[^a-z0-9_]/gi, '');

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

  return { where, values, order, select };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).set(CORS).end();
  }

  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  const table = req.query.table;
  if (!table || !/^[a-z][a-z0-9_]*$/.test(table)) {
    return res.status(400).json({ error: 'Invalid table name' });
  }

  const { table: _t, ...filters } = req.query;

  try {
    if (req.method === 'GET') {
      const { where, values, order, select } = parseQuery(filters);
      let q = `SELECT ${select} FROM ${table}`;
      if (where.length) q += ` WHERE ${where.join(' AND ')}`;
      if (order) q += ` ORDER BY ${order}`;
      const rows = await sql(q, values);
      return res.status(200).json(rows);
    }

    if (req.method === 'POST') {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Body required' });
      }
      const keys = Object.keys(body);
      const cols = keys.map(k => k.replace(/[^a-z0-9_]/gi, '')).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const vals = keys.map(k => body[k]);
      const q = `INSERT INTO ${table} (${cols}) VALUES (${placeholders}) RETURNING *`;
      const rows = await sql(q, vals);
      return res.status(201).json(rows);
    }

    if (req.method === 'PATCH') {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Body required' });
      }
      const { where, values } = parseQuery(filters);
      if (!where.length) {
        return res.status(400).json({ error: 'PATCH requires at least one filter' });
      }
      const keys = Object.keys(body);
      let idx = values.length + 1;
      const sets = keys.map(k => `${k.replace(/[^a-z0-9_]/gi, '')} = $${idx++}`).join(', ');
      const vals = [...values, ...keys.map(k => body[k])];
      const q = `UPDATE ${table} SET ${sets} WHERE ${where.join(' AND ')} RETURNING *`;
      const rows = await sql(q, vals);
      return res.status(200).json(rows);
    }

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
