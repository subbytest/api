// api/setup.js - Jalankan sekali untuk fix DB constraints
// Akses via: https://api-ruby-two-84.vercel.app/api/setup
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  
  const sql = neon(process.env.DATABASE_URL);
  const results = [];
  
  const queries = [
    // Drop constraint parts condition - supaya bisa simpan nilai apapun
    `ALTER TABLE rl_parts DROP CONSTRAINT IF EXISTS rl_parts_condition_check`,
    // Pastikan kolom condition nullable
    `ALTER TABLE rl_parts ALTER COLUMN condition DROP NOT NULL`,
  ];
  
  for (const q of queries) {
    try {
      await sql(q);
      results.push({ query: q, status: 'OK' });
    } catch (e) {
      results.push({ query: q, status: 'ERROR', error: e.message });
    }
  }
  
  return res.json({ done: true, results });
}
