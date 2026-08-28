import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'

if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is missing')
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='false'?false:{rejectUnauthorized:false},max:1})
const migrations=[
  {name:'009_staff_temporary_credentials.sql',check:"select exists(select 1 from information_schema.columns where table_schema='app' and table_name='user_credentials' and column_name='must_change_password') applied"},
  {name:'010_outlet_limits_and_approval.sql',check:"select exists(select 1 from billing.plan_entitlements where feature_key='outlets.max') applied"},
  {name:'011_staff_credentials_grant.sql',check:"select has_table_privilege('bitelink_api','app.user_credentials','INSERT') applied"},
]
try{for(const migration of migrations){const state=await pool.query(migration.check);if(state.rows[0].applied){console.log(`skip ${migration.name}`);continue}const sql=await readFile(resolve('../BiteLinkQR/database/migrations',migration.name),'utf8');await pool.query(sql);console.log(`applied ${migration.name}`)}}finally{await pool.end()}
