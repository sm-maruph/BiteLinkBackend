import { config } from '../../config.js'
import { parse } from '../../schemas.js'
import { bootstrapSchema, changePasswordSchema, loginSchema } from './schemas.js'
import { bootstrap, changePassword, login, logout, refresh, registerTenant } from './service.js'
import { authenticate } from './middleware.js'
import { listMemberships } from './repository.js'

const cookieOptions = () => ({ httpOnly: true, secure: config.COOKIE_SECURE, sameSite: config.COOKIE_SECURE ? 'none' : 'lax', path: '/api/auth', maxAge: config.REFRESH_TOKEN_DAYS * 86_400 })
const requestInfo = (request) => ({ ip: request.ip, userAgent: request.headers['user-agent'] })

export async function authRoutes(app) {
  app.post('/bootstrap', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (request, reply) => {
    if (request.headers['x-bootstrap-token'] !== config.BOOTSTRAP_TOKEN) return reply.code(403).send({ error: 'invalid_bootstrap_token' })
    const client = await app.db.connect()
    try { return reply.code(201).send(await bootstrap(client, parse(bootstrapSchema, request.body))) }
    finally { client.release() }
  })

  app.post('/register', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const input = parse(bootstrapSchema, request.body)
    const client = await app.db.connect()
    try { await registerTenant(client, input) } finally { client.release() }
    const result = await login(app.db, { email: input.email, password: input.password }, requestInfo(request))
    reply.setCookie('bitelink_refresh', result.refreshToken, cookieOptions())
    const { refreshToken, ...response } = result
    return reply.code(201).send(response)
  })

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const result = await login(app.db, parse(loginSchema, request.body), requestInfo(request))
    if (!result) return reply.code(401).send({ error: 'invalid_credentials' })
    reply.setCookie('bitelink_refresh', result.refreshToken, cookieOptions())
    const { refreshToken, ...response } = result
    return response
  })

  app.post('/refresh', async (request, reply) => {
    if (!request.cookies.bitelink_refresh) return reply.code(401).send({ error: 'refresh_token_required' })
    const client = await app.db.connect()
    try {
      const result = await refresh(client, request.cookies.bitelink_refresh, requestInfo(request))
      if (!result) return reply.code(401).send({ error: 'invalid_refresh_token' })
      reply.setCookie('bitelink_refresh', result.refreshToken, cookieOptions())
      const { refreshToken, ...response } = result
      return response
    } finally { client.release() }
  })

  app.post('/logout', async (request, reply) => {
    await logout(app.db, request.cookies.bitelink_refresh)
    reply.clearCookie('bitelink_refresh', { path: '/api/auth' })
    return reply.code(204).send()
  })

  app.post('/change-password',{preHandler:authenticate},async(request,reply)=>{
    const changed=await changePassword(app.db,request.identity.userId,parse(changePasswordSchema,request.body))
    if(!changed)return reply.code(400).send({error:'current_password_incorrect'})
    return {changed:true}
  })

  app.get('/me', { preHandler: authenticate }, async (request) => ({
    user: { id: request.identity.userId, email: request.identity.email },
    tenants: await listMemberships(app.db, request.identity.userId),
  }))
}
