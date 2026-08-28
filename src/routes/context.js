import { withTransaction } from '../db.js'

export async function contextRoutes(app) {
  app.get('/context', async (request) => withTransaction(request.context, async (client) => {
    const restaurants = await client.query(
      `select r.id,r.name,r.slug,r.status,
              coalesce(jsonb_agg(jsonb_build_object('id',o.id,'name',o.name,'slug',o.slug,'status',o.status)
                order by (o.status='active') desc,o.name) filter(where o.id is not null),'[]') outlets
         from app.restaurants r left join app.outlets o on o.tenant_id=r.tenant_id and o.restaurant_id=r.id
        where r.tenant_id=$1 group by r.id order by r.name`, [request.context.tenantId],
    )
    const roles = await client.query(
      `select distinct ro.code,ro.name,ro.scope,mr.restaurant_id,mr.outlet_id
         from app.tenant_memberships m join app.membership_roles mr on mr.membership_id=m.id and mr.tenant_id=m.tenant_id
         join app.roles ro on ro.id=mr.role_id
        where m.tenant_id=$1 and m.user_id=$2 and m.status='active'`, [request.context.tenantId,request.context.userId],
    )
    return { tenantId: request.context.tenantId, restaurants: restaurants.rows, roles: roles.rows }
  }))
}
