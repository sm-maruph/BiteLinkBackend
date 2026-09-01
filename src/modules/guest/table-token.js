import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../../config.js'

const sign = (value) => createHmac('sha256', config.TABLE_QR_SECRET).update(value).digest('base64url')

export const createTableToken = (table) => {
  const subject = `${table.id}.${table.qr_token_hash}`
  return `${table.id}.${sign(subject)}`
}

export const verifyTableToken = (table, token) => {
  if (!token || typeof token !== 'string') return false
  const [id, signature, extra] = token.split('.')
  if (extra || id !== table.id || !signature) return false
  const expected = sign(`${table.id}.${table.qr_token_hash}`)
  const actualBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

export async function requireTableToken(request, reply) {
  if (!request.params?.tableNumber) return
  const token = request.headers['x-table-token']
  const { restaurantSlug, outletSlug, tableNumber } = request.params
  const { rows } = await request.server.db.query(
    `select t.id,t.qr_token_hash from app.dining_tables t
       join app.restaurants r on r.tenant_id=t.tenant_id and r.id=t.restaurant_id
       join app.outlets o on o.tenant_id=t.tenant_id and o.id=t.outlet_id
      where r.slug=$1 and o.slug=$2 and t.table_number=$3 and t.status<>'disabled'`,
    [restaurantSlug, outletSlug, tableNumber],
  )
  if (!rows[0] || !verifyTableToken(rows[0], token)) {
    return reply.code(403).send({ error: 'valid_table_qr_required' })
  }
}
