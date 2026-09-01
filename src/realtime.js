import websocket from '@fastify/websocket'
import { pool, withTransaction } from './db.js'
import { verifyAccessToken } from './modules/auth/tokens.js'
import { createHash } from 'node:crypto'
import { verifyTableToken } from './modules/guest/table-token.js'

const clients = new Set()

export async function registerRealtime(app) {
  await app.register(websocket)

  const listener = await pool.connect()
  await listener.query('listen bitelink_events')
  listener.on('notification', (message) => {
    try {
      const event = JSON.parse(message.payload)
      for (const client of clients) {
        if (client.tenantId !== event.tenantId) continue
        if (event.restaurantId && client.restaurantId !== event.restaurantId) continue
        if (event.outletId && client.outletId !== event.outletId) continue
        if (client.customerTokenHash && client.customerTokenHash !== event.customerTokenHash) continue
        if (client.socket.readyState === 1) client.socket.send(JSON.stringify(event))
      }
    } catch (error) {
      app.log.error({ err: error }, 'invalid realtime database event')
    }
  })

  app.get('/api/realtime', { websocket: true }, (socket) => {
    const state = { socket, tenantId: null, restaurantId: null, outletId: null, customerTokenHash:null }
    const timer = setTimeout(() => socket.close(4401, 'authentication timeout'), 10_000)
    socket.on('message', async (raw) => {
      if (state.tenantId) return
      try {
        const message = JSON.parse(String(raw))
        if(message.mode==='guest'){
          const result=await pool.query(`select t.id,t.qr_token_hash,t.tenant_id,t.restaurant_id,t.outlet_id from app.dining_tables t join app.restaurants r on r.tenant_id=t.tenant_id and r.id=t.restaurant_id join app.outlets o on o.tenant_id=t.tenant_id and o.id=t.outlet_id where r.slug=$1 and o.slug=$2 and t.table_number=$3 and t.status<>'disabled'`,[message.restaurantSlug,message.outletSlug,message.tableNumber])
          if(!result.rows[0]||!verifyTableToken(result.rows[0],message.tableToken)||typeof message.customerSession!=='string')throw new Error('guest authentication failed')
          Object.assign(state,{tenantId:result.rows[0].tenant_id,restaurantId:result.rows[0].restaurant_id,outletId:result.rows[0].outlet_id,customerTokenHash:createHash('sha256').update(message.customerSession).digest('hex')})
        }else{
          const payload = await verifyAccessToken(message.accessToken)
          if (!message.tenantId || !message.restaurantId || !message.outletId) throw new Error('scope required')
          const allowed = await withTransaction({ userId: payload.sub, tenantId: message.tenantId }, async (client) => {
            const result = await client.query("select app.has_permission($1,'orders.read',$2,$3) allowed", [message.tenantId, message.restaurantId, message.outletId])
            return result.rows[0]?.allowed === true
          })
          if (!allowed) return socket.close(4403, 'permission denied')
          Object.assign(state, { tenantId: message.tenantId, restaurantId: message.restaurantId, outletId: message.outletId })
        }
        clients.add(state)
        clearTimeout(timer)
        socket.send(JSON.stringify({ type: 'ready' }))
      } catch {
        socket.close(4401, 'authentication failed')
      }
    })
    socket.on('close', () => { clearTimeout(timer); clients.delete(state) })
    socket.on('error', () => clients.delete(state))
  })

  app.addHook('onClose', async () => {
    clients.clear()
    await listener.query('unlisten bitelink_events').catch(() => {})
    listener.release()
  })
}

export async function publishRealtime(client, event) {
  await client.query("select pg_notify('bitelink_events',$1)", [JSON.stringify(event)])
}
