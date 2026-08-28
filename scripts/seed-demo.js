import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import pg from 'pg'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
const sql = await readFile(new URL('../../BiteLinkQR/database/migrations/005_demo_catalog.sql', import.meta.url), 'utf8')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }, max: 1 })
try {
  await pool.query(sql)
  const { rows } = await pool.query(`select r.slug restaurant, count(distinct o.id)::int outlets, count(distinct i.id)::int menu_items
    from app.restaurants r left join app.outlets o on o.restaurant_id=r.id left join app.menu_items i on i.restaurant_id=r.id
    where r.slug in ('terrace','kacchi','noodle') group by r.slug order by r.slug`)
  console.log(JSON.stringify({ seeded: true, restaurants: rows }, null, 2))
} finally { await pool.end() }
