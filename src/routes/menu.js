import { withTransaction } from '../db.js'
import { menuCategoryBody, menuItemBody, menuQuery, parse, uuid } from '../schemas.js'
import { z } from 'zod'

export async function menuRoutes(app) {
  app.get('/menu-categories',async request=>withTransaction(request.context,async client=>{const restaurantId=parse(uuid,request.query.restaurantId);const {rows}=await client.query('select id,name,slug,description,sort_order from app.menu_categories where tenant_id=$1 and restaurant_id=$2 and is_active order by sort_order,name',[request.context.tenantId,restaurantId]);return {items:rows}}))
  app.post('/menu-categories',async(request,reply)=>withTransaction(request.context,async client=>{const body=parse(menuCategoryBody,request.body);const allowed=await client.query("select app.has_permission($1,'menu.write',$2,$3) allowed",[request.context.tenantId,body.restaurantId,body.outletId||null]);if(!allowed.rows[0]?.allowed)return reply.code(403).send({error:'permission_denied'});const {rows}=await client.query('insert into app.menu_categories(tenant_id,restaurant_id,name,slug,description,sort_order) values($1,$2,$3,$4,$5,(select coalesce(max(sort_order),0)+1 from app.menu_categories where tenant_id=$1 and restaurant_id=$2)) returning *',[request.context.tenantId,body.restaurantId,body.name,body.slug,body.description||null]);return reply.code(201).send(rows[0])}))
  app.post('/menu-items',async(request,reply)=>withTransaction(request.context,async client=>{const body=parse(menuItemBody,request.body);const scope=body.universal?null:body.outletId;if(!scope&&!body.universal)return reply.code(400).send({error:'outlet_scope_required'});const allowed=await client.query("select app.has_permission($1,'menu.write',$2,$3) allowed",[request.context.tenantId,body.restaurantId,scope]);if(!allowed.rows[0]?.allowed)return reply.code(403).send({error:'permission_denied'});if(body.universal){const broad=await client.query("select app.has_permission($1,'restaurant.manage',$2,null) allowed",[request.context.tenantId,body.restaurantId]);if(!broad.rows[0]?.allowed)return reply.code(403).send({error:'universal_menu_requires_restaurant_manager'})}const category=await client.query('select 1 from app.menu_categories where tenant_id=$1 and restaurant_id=$2 and id=$3',[request.context.tenantId,body.restaurantId,body.categoryId]);if(!category.rows[0])return reply.code(400).send({error:'invalid_category'});const {rows}=await client.query("insert into app.menu_items(tenant_id,restaurant_id,outlet_id,category_id,name,slug,description,image_url,base_price,preparation_minutes,is_featured,sort_order) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,(select coalesce(max(sort_order),0)+1 from app.menu_items where tenant_id=$1 and restaurant_id=$2 and category_id=$4)) returning *",[request.context.tenantId,body.restaurantId,scope,body.categoryId,body.name,body.slug,body.description||null,body.imageUrl||null,body.basePrice,body.preparationMinutes,body.featured]);return reply.code(201).send(rows[0])}))
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
          where i.tenant_id = $1 and i.restaurant_id = $2 and (i.outlet_id is null or i.outlet_id=$3)
            and ($4::uuid is null or i.category_id = $4)
          order by c.sort_order, i.sort_order, i.name limit $5 offset $6`,
        params,
      )
      return { items: rows, page: query.page, pageSize: query.pageSize, total: rows[0]?.total_count ?? 0 }
    })
  })

  app.patch('/menu-items/:id/availability', async (request, reply) => {
    const id = parse(uuid, request.params.id)
    const body = parse(z.object({ availability: z.enum(['available', 'sold_out', 'unavailable']), outletId:uuid.optional() }), request.body)
    return withTransaction(request.context, async (client) => {
      const allowed = await client.query(`select app.has_permission($1, 'menu.write', i.restaurant_id, $3) allowed from app.menu_items i where i.tenant_id=$1 and i.id=$2`, [request.context.tenantId, id, body.outletId||null])
      if (!allowed.rows[0]?.allowed) return reply.code(403).send({ error: 'permission_denied' })
      const { rows } = await client.query('select restaurant_id from app.menu_items where tenant_id=$1 and id=$2', [request.context.tenantId, id])
      if (!rows[0]) return reply.code(404).send({ error: 'menu_item_not_found' })
      if(body.outletId){const updated=await client.query("insert into app.outlet_menu_items(tenant_id,outlet_id,menu_item_id,availability) values($1,$2,$3,$4) on conflict(outlet_id,menu_item_id) do update set availability=excluded.availability returning availability",[request.context.tenantId,body.outletId,id,body.availability]);return {...rows[0],availability:updated.rows[0].availability}}
      const updated=await client.query('update app.menu_items set availability=$3 where tenant_id=$1 and id=$2 returning *', [request.context.tenantId, id, body.availability])
      return updated.rows[0]
    })
  })
  app.patch('/menu-items/:id',async(request,reply)=>withTransaction(request.context,async client=>{const id=parse(uuid,request.params.id),body=request.body||{},item=await client.query('select restaurant_id,outlet_id from app.menu_items where tenant_id=$1 and id=$2',[request.context.tenantId,id]);if(!item.rows[0])return reply.code(404).send({error:'menu_item_not_found'});const access=await client.query("select app.has_permission($1,'menu.write',$2,$3) allowed",[request.context.tenantId,item.rows[0].restaurant_id,item.rows[0].outlet_id]);if(!access.rows[0]?.allowed)return reply.code(403).send({error:'permission_denied'});const rows=await client.query('update app.menu_items set name=coalesce($3,name),description=coalesce($4,description),image_url=coalesce($5,image_url),base_price=coalesce($6,base_price),preparation_minutes=coalesce($7,preparation_minutes),updated_at=now() where tenant_id=$1 and id=$2 returning *',[request.context.tenantId,id,body.name||null,body.description||null,body.imageUrl||null,body.basePrice??null,body.preparationMinutes??null]);return rows.rows[0]}))
  app.delete('/menu-items/:id',async(request,reply)=>withTransaction(request.context,async client=>{const id=parse(uuid,request.params.id),item=await client.query('select restaurant_id,outlet_id from app.menu_items where tenant_id=$1 and id=$2',[request.context.tenantId,id]);if(!item.rows[0])return reply.code(404).send({error:'menu_item_not_found'});const access=await client.query("select app.has_permission($1,'menu.write',$2,$3) allowed",[request.context.tenantId,item.rows[0].restaurant_id,item.rows[0].outlet_id]);if(!access.rows[0]?.allowed)return reply.code(403).send({error:'permission_denied'});await client.query('delete from app.menu_items where tenant_id=$1 and id=$2',[request.context.tenantId,id]);return reply.code(204).send()}))
}
