import pg from 'pg'
import { config } from './config.js'

const { Pool } = pg

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: config.DATABASE_SSL_REJECT_UNAUTHORIZED } : false,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
})

export async function withTransaction(context, work) {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query('set local role bitelink_api')
    await client.query("select set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)", [
      context.userId,
      context.tenantId,
    ])
    const result = await work(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

export async function withPublicTransaction(work) {
  const client = await pool.connect()
  try {
    await client.query('begin read only')
    await client.query('set local role bitelink_public')
    const result = await work(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}
