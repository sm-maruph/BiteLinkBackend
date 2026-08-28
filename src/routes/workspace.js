import { withTransaction } from '../db.js'

export async function workspaceRoutes(app) {
  app.get('/workspace', async (request, reply) => withTransaction(request.context, async (client) => {
    const { restaurantId, outletId } = request.query
    if (!restaurantId || !outletId) return reply.code(400).send({ error: 'restaurant_and_outlet_required' })
    const access=await client.query("select app.has_permission($1,'orders.read',$2,$3) allowed",[request.context.tenantId,restaurantId,outletId])
    if(!access.rows[0]?.allowed) return reply.code(403).send({error:'permission_denied'})
    const restaurant = await client.query(
      `select r.id,r.name,r.slug,r.logo_url,o.id outlet_id,o.name outlet_name,o.slug outlet_slug,
              o.address_line,o.city,p.tagline,p.description,p.cover_image_url,p.phone,p.email,p.chef_name,
              t.template_key,t.theme_key,t.design_settings
         from app.restaurants r join app.outlets o on o.tenant_id=r.tenant_id and o.restaurant_id=r.id
         left join app.restaurant_profiles p on p.restaurant_id=r.id and p.tenant_id=r.tenant_id
         left join app.restaurant_themes t on t.restaurant_id=r.id and t.tenant_id=r.tenant_id
        where r.tenant_id=$1 and r.id=$2 and o.id=$3`, [request.context.tenantId,restaurantId,outletId])
    if (!restaurant.rows[0]) return reply.code(404).send({ error: 'workspace_not_found' })
    const menu = await client.query(`select i.id,i.name,i.description,i.image_url,coalesce(omi.price_override,i.base_price) price,
      coalesce(omi.availability,i.availability) availability,i.preparation_minutes,i.tags,i.is_featured,c.name category_name
      from app.menu_items i join app.menu_categories c on c.id=i.category_id and c.tenant_id=i.tenant_id
      left join app.outlet_menu_items omi on omi.menu_item_id=i.id and omi.outlet_id=$3 and omi.tenant_id=i.tenant_id
      where i.tenant_id=$1 and i.restaurant_id=$2 order by c.sort_order,i.sort_order`,[request.context.tenantId,restaurantId,outletId])
    const offers = await client.query('select * from app.offers where tenant_id=$1 and restaurant_id=$2 and (outlet_id is null or outlet_id=$3) order by created_at desc',[request.context.tenantId,restaurantId,outletId])
    const tables = await client.query('select id,table_number,capacity,status from app.dining_tables where tenant_id=$1 and restaurant_id=$2 and outlet_id=$3 order by table_number',[request.context.tenantId,restaurantId,outletId])
    const orders = await client.query(`select o.*,t.table_number,rv.rating review_rating,rv.comment review_comment,coalesce(string_agg(oi.item_name_snapshot||' x '||oi.quantity,'; ' order by oi.created_at),'') items
      from app.orders o join app.dining_tables t on t.id=o.table_id and t.tenant_id=o.tenant_id left join app.order_items oi on oi.order_id=o.id and oi.tenant_id=o.tenant_id
      left join app.order_reviews rv on rv.tenant_id=o.tenant_id and rv.order_id=o.id
      where o.tenant_id=$1 and o.restaurant_id=$2 and o.outlet_id=$3 group by o.id,t.table_number,rv.rating,rv.comment order by o.placed_at desc`,[request.context.tenantId,restaurantId,outletId])
    const payments = await client.query(`select p.*,t.table_number from app.payments p join app.table_sessions s on s.id=p.session_id and s.tenant_id=p.tenant_id
      join app.dining_tables t on t.id=s.table_id and t.tenant_id=s.tenant_id where p.tenant_id=$1 and p.restaurant_id=$2 and p.outlet_id=$3 order by p.created_at desc`,[request.context.tenantId,restaurantId,outletId])
    const requests = await client.query(`select q.*,t.table_number from app.service_requests q join app.dining_tables t on t.id=q.table_id and t.tenant_id=q.tenant_id
      where q.tenant_id=$1 and q.restaurant_id=$2 and q.outlet_id=$3 order by q.created_at desc`,[request.context.tenantId,restaurantId,outletId])
    const team = await client.query(`select u.id,u.display_name,u.email,m.status,coalesce(string_agg(distinct ro.name,', '),'Member') roles
      from app.tenant_memberships m join app.users u on u.id=m.user_id left join app.membership_roles mr on mr.membership_id=m.id and mr.tenant_id=m.tenant_id
      left join app.roles ro on ro.id=mr.role_id where m.tenant_id=$1 group by u.id,m.status order by u.display_name`,[request.context.tenantId])
    const completedRevenue=orders.rows.filter(o=>o.status==='completed').reduce((sum,o)=>sum+Number(o.grand_total),0)
    return {restaurant:restaurant.rows[0],menu:menu.rows,offers:offers.rows,tables:tables.rows,orders:orders.rows,payments:payments.rows,requests:requests.rows,team:team.rows,
      metrics:{revenueToday:completedRevenue,ordersToday:orders.rows.length,activeTables:tables.rows.filter(t=>!['available','disabled'].includes(t.status)).length,totalTables:tables.rows.length,averageOrder:orders.rows.length?orders.rows.reduce((s,o)=>s+Number(o.grand_total),0)/orders.rows.length:0}}
  }))
}
