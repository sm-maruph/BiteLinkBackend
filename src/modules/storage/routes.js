import { withTransaction } from '../../db.js'
import { uploadRestaurantAsset, deleteRestaurantAsset } from './service.js'

export async function storageRoutes(app) {
  app.post('/restaurants/:restaurantId/assets', async (request, reply) => {
    const { restaurantId } = request.params
    const allowed = await withTransaction(request.context, async (client) => {
      const outletId = request.query?.outletId || null
      const { rows } = await client.query("select app.has_permission($1,'restaurant.manage',$2,null) or ($3::uuid is not null and app.has_permission($1,'outlet.manage',$2,$3::uuid)) allowed", [request.context.tenantId, restaurantId, outletId])
      return rows[0]?.allowed
    })
    if (!allowed) return reply.code(403).send({ error: 'permission_denied' })
    const file = await request.file()
    if (!file) return reply.code(400).send({ error: 'file_required' })
    return reply.code(201).send(await uploadRestaurantAsset({ tenantId: request.context.tenantId, restaurantId, file }))
  })

  app.delete('/restaurants/:restaurantId/assets', async (request, reply) => {
    const { restaurantId } = request.params
    const allowed = await withTransaction(request.context, async (client) => {
      const { rows } = await client.query("select app.has_permission($1,'restaurant.manage',$2,null) allowed", [request.context.tenantId, restaurantId])
      return rows[0]?.allowed
    })
    if (!allowed) return reply.code(403).send({ error: 'permission_denied' })
    await deleteRestaurantAsset({ tenantId: request.context.tenantId, restaurantId, key: request.body?.key || '' })
    return reply.code(204).send()
  })
}
