import { withTransaction } from '../db.js'
import { menuQuery, parse, uuid } from '../schemas.js'
import { z } from 'zod'

export async function menuRoutes(app) {
  app.get('/menu-items', async (request) => {
    const query = parse(menuQuery, request.query)
    return withTransaction(request.context, async (client) => {
      const offset = (query.page - 1) * query.pageSize
      const params = [request.context.tenantId, query.restaurantId, query.outletId ?? null, query.categoryId ?? null, query.pageSize, offset]
      const { rows } = await client.query(
        `select i.id, i.restaurant_id, i.category_id, c.name as category_name, i.name, i.slug,
                i.description, i.image_url, coalesce(omi.price_override, i.base_price) as price,
                coalesce(omi.availability, i.availability) as availability, i.preparation_minutes,
                i.is_featured, i.tags, i.dietary, i.sort_order,
                count(*) over()::int as total_count
           from app.menu_items i
           join app.menu_categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
           left join app.outlet_menu_items omi on omi.tenant_id = i.tenant_id
                 and omi.menu_item_id = i.id and omi.outlet_id = $3
          where i.tenant_id = $1 and i.restaurant_id = $2
            and ($4::uuid is null or i.category_id = $4)
          order by c.sort_order, i.sort_order, i.name limit $5 offset $6`,
        params,
      )
      return { items: rows, page: query.page, pageSize: query.pageSize, total: rows[0]?.total_count ?? 0 }
    })
  })

  app.patch('/menu-items/:id/availability', async (request, reply) => {
    const id = parse(uuid, request.params.id)
    const availability = parse(z.object({ availability: z.enum(['available', 'sold_out', 'unavailable']) }), request.body).availability
    return withTransaction(request.context, async (client) => {
      const allowed = await client.query(`select app.has_permission($1, 'menu.write', i.restaurant_id, null) allowed from app.menu_items i where i.tenant_id=$1 and i.id=$2`, [request.context.tenantId, id])
      if (!allowed.rows[0]?.allowed) return reply.code(403).send({ error: 'permission_denied' })
      const { rows } = await client.query('update app.menu_items set availability=$3 where tenant_id=$1 and id=$2 returning *', [request.context.tenantId, id, availability])
      if (!rows[0]) return reply.code(404).send({ error: 'menu_item_not_found' })
      return rows[0]
    })
  })
}
