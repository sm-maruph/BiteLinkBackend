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
  {name:'012_customer_order_privacy.sql',check:"select exists(select 1 from information_schema.columns where table_schema='app' and table_name='orders' and column_name='customer_token_hash') applied"},
  {name:'013_role_permissions_write_policy.sql',check:"select exists(select 1 from pg_policies where schemaname='app' and tablename='role_permissions' and policyname='role_permissions_tenant_manage') applied"},
  {name:'014_edit_system_roles.sql',check:"select coalesce((select position('r.code' in qual)>0 and position('owner' in qual)>0 from pg_policies where schemaname='app' and tablename='role_permissions' and policyname='role_permissions_tenant_manage'),false) applied"},
  {name:'015_order_staff_visibility.sql',check:"select not exists(select 1 from app.roles r join app.role_permissions rp on rp.role_id=r.id where r.code='order_staff' and rp.permission_code in ('orders.serve','orders.complete')) applied"},
  {name:'016_customer_bill_payments.sql',check:"select exists(select 1 from information_schema.columns where table_schema='app' and table_name='payments' and column_name='order_id') applied"},
  {name:'017_order_eta.sql',check:"select exists(select 1 from information_schema.columns where table_schema='app' and table_name='orders' and column_name='estimated_ready_at') applied"},
]
try{for(const migration of migrations){const state=await pool.query(migration.check);if(state.rows[0].applied){console.log(`skip ${migration.name}`);continue}const sql=await readFile(resolve('../BiteLinkQR/database/migrations',migration.name),'utf8');await pool.query(sql);console.log(`applied ${migration.name}`)}}finally{await pool.end()}
