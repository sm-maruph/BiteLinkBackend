import 'dotenv/config'
import pg from 'pg'
import dns from 'node:dns/promises'

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing from Backend/.env')
  process.exit(1)
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 10_000,
})

const requiredRelations = [
  'app.tenants',
  'app.users',
  'app.restaurants',
  'app.menu_items',
  'app.orders',
  'app.public_menu_items',
  'app.public_restaurants',
  'app.user_credentials',
  'app.auth_sessions',
]

try {
  const connection = await pool.query('select current_database() database, current_user connection_user, version() version')
  const relations = await pool.query(
    `select requested.name, to_regclass(requested.name) is not null as present
       from unnest($1::text[]) requested(name)`,
    [requiredRelations],
  )
  const roles = await pool.query(
    `select exists(select 1 from pg_roles where rolname='bitelink_api') api_role_exists,
            exists(select 1 from pg_roles where rolname='bitelink_public') public_role_exists,
            pg_has_role(current_user,'bitelink_api','member') can_assume_api,
            pg_has_role(current_user,'bitelink_public','member') can_assume_public`,
  )
  const features = await pool.query(`select
    exists(select 1 from information_schema.columns where table_schema='app' and table_name='user_credentials' and column_name='must_change_password') staff_temporary_credentials,
    exists(select 1 from billing.plan_entitlements where feature_key='outlets.max') outlet_plan_limits,
    has_table_privilege('bitelink_api','app.user_credentials','INSERT') staff_credentials_insert_grant`)
  const missing = relations.rows.filter((relation) => !relation.present).map((relation) => relation.name)
  const roleState = roles.rows[0]
  const featureState=features.rows[0]
  const ready = missing.length === 0 && roleState.api_role_exists && roleState.public_role_exists && roleState.can_assume_api && roleState.can_assume_public && featureState.staff_temporary_credentials && featureState.outlet_plan_limits && featureState.staff_credentials_insert_grant

  console.log(JSON.stringify({
    connected: true,
    ready,
    database: connection.rows[0].database,
    connectionUser: connection.rows[0].connection_user,
    postgresVersion: connection.rows[0].version.match(/PostgreSQL\s+[^\s]+/)?.[0],
    requiredRelations: relations.rows,
    runtimeRoles: roleState,
    features:featureState,
  }, null, 2))
  if (!ready) process.exitCode = 1
} catch (error) {
  let network
  try {
    const hostname = new URL(process.env.DATABASE_URL).hostname
    const [ipv4, ipv6] = await Promise.all([
      dns.resolve4(hostname).catch(() => []),
      dns.resolve6(hostname).catch(() => []),
    ])
    network = {
      hostname,
      hasIPv4: ipv4.length > 0,
      hasIPv6: ipv6.length > 0,
      recommendation: !ipv4.length && ipv6.length
        ? 'This is an IPv6-only Supabase direct endpoint. Use the Dashboard Connect > Session pooler URL (port 5432) on an IPv4-only network.'
        : undefined,
    }
  } catch { network = undefined }
  console.error(JSON.stringify({ connected: false, error: error.message, code: error.code, network }, null, 2))
  process.exitCode = 1
} finally {
  await pool.end()
}
