import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import { pool } from './db.js'
import { config } from './config.js'
import { authenticate, resolveTenantContext } from './modules/auth/middleware.js'
import { authRoutes } from './modules/auth/routes.js'
import { storageRoutes } from './modules/storage/routes.js'
import { publicRoutes } from './routes/public.js'
import { menuRoutes } from './routes/menu.js'
import { orderRoutes } from './routes/orders.js'
import { contextRoutes } from './routes/context.js'
import { workspaceRoutes } from './routes/workspace.js'
import { staffRoutes } from './routes/staff.js'
import { organizationRoutes } from './routes/organization.js'

export async function buildApp() {
  const frontendOrigins = [...new Set([
    ...config.FRONTEND_ORIGIN.split(','),
    'https://bitelinkqr.onrender.com',
  ].map((value) => value.trim().replace(/\/$/, '')).filter(Boolean))]

  const app = Fastify({
    logger: config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : true,
    trustProxy: true,
    bodyLimit: 1_048_576,
  })

  app.decorate('db', pool)
  await app.register(helmet)
  await app.register(cookie)
  await app.register(multipart, { limits: { files: 1, fileSize: config.STORAGE_MAX_BYTES } })
  await app.register(cors, {
    origin: frontendOrigins,
    credentials: true,
    allowedHeaders: ['authorization', 'content-type', 'x-tenant-id', 'idempotency-key', 'x-demo-user-id'],
  })
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' })

  app.get('/health', async () => {
    await pool.query('select 1')
    return { status: 'ok' }
  })

  await app.register(authRoutes, { prefix: '/api/auth' })

  await app.register(async (publicApi) => {
    await publicApi.register(rateLimit, { max: 60, timeWindow: '1 minute' })
    await publicApi.register(publicRoutes)
  }, { prefix: '/api/public' })

  await app.register(async (api) => {
    api.addHook('preHandler', authenticate)
    api.addHook('preHandler', resolveTenantContext)
    await api.register(menuRoutes)
    await api.register(orderRoutes)
    await api.register(contextRoutes)
    await api.register(workspaceRoutes)
    await api.register(staffRoutes)
    await api.register(organizationRoutes)
    await api.register(storageRoutes)
  }, { prefix: '/api/v1' })

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'request failed')
    if (error.code === '23505') return reply.code(409).send({ error: 'conflict' })
    if (error.code === '23503') return reply.code(409).send({ error: 'referenced_record_invalid' })
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: error.message, details: error.details })
    }
    return reply.code(500).send({ error: 'internal_server_error' })
  })

  app.addHook('onClose', async () => pool.end())
  return app
}
