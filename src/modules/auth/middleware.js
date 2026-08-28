import { config } from '../../config.js'
import { verifyAccessToken } from './tokens.js'

function bearerToken(request) {
  const value = request.headers.authorization
  return value?.startsWith('Bearer ') ? value.slice(7).trim() : null
}

export async function authenticate(request, reply) {
  if (config.ALLOW_DEMO_AUTH && request.headers['x-demo-user-id']) {
    request.identity = { userId: request.headers['x-demo-user-id'] }
    return
  }
  const token = bearerToken(request)
  if (!token) return reply.code(401).send({ error: 'authentication_required' })
  try {
    const payload = await verifyAccessToken(token)
    request.identity = { userId: payload.sub, email: payload.email }
  } catch {
    return reply.code(401).send({ error: 'invalid_access_token' })
  }
}

export async function resolveTenantContext(request, reply) {
  const tenantId = request.headers['x-tenant-id']
  if (!tenantId) return reply.code(400).send({ error: 'tenant_header_required' })
  const { rows } = await request.server.db.query(
    `select user_id,tenant_id from app.tenant_memberships where user_id=$1 and tenant_id=$2 and status='active'`,
    [request.identity.userId, tenantId],
  )
  if (!rows[0]) return reply.code(403).send({ error: 'tenant_access_denied' })
  request.context = { userId: rows[0].user_id, tenantId: rows[0].tenant_id }
}
