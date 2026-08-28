import { withTransaction } from '../db.js'
import { createHash, randomBytes } from 'node:crypto'

export async function workspaceRoutes(app) {
  app.post('/tables', async (request, reply) => withTransaction(request.context, async (client) => {
    const {restaurantId,outletId,tableNumber,capacity=4}=request.body||{}
    const normalizedNumber=String(tableNumber||'').trim()
    const normalizedCapacity=Number(capacity)
    if(!restaurantId||!outletId||!normalizedNumber) return reply.code(400).send({error:'restaurant_outlet_and_table_required'})
    if(normalizedNumber.length>20||!/^[a-zA-Z0-9_-]+$/.test(normalizedNumber)) return reply.code(400).send({error:'invalid_table_number'})
    if(!Number.isInteger(normalizedCapacity)||normalizedCapacity<1||normalizedCapacity>50) return reply.code(400).send({error:'invalid_table_capacity'})
    const access=await client.query("select app.has_permission($1,'tables.write',$2,$3) allowed",[request.context.tenantId,restaurantId,outletId])
    if(!access.rows[0]?.allowed) return reply.code(403).send({error:'permission_denied'})
    const outlet=await client.query('select id from app.outlets where tenant_id=$1 and restaurant_id=$2 and id=$3 and status=$4',[request.context.tenantId,restaurantId,outletId,'active'])
    if(!outlet.rows[0]) return reply.code(404).send({error:'outlet_not_found'})
    const qrHash=createHash('sha256').update(randomBytes(32)).digest('hex')
    const created=await client.query(`insert into app.dining_tables(tenant_id,restaurant_id,outlet_id,table_number,qr_token_hash,capacity,status)
      values($1,$2,$3,$4,$5,$6,'available') returning id,table_number,capacity,status`,[request.context.tenantId,restaurantId,outletId,normalizedNumber,qrHash,normalizedCapacity])
    return reply.code(201).send(created.rows[0])
  }))

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

  app.get('/restaurant-analytics', async (request, reply) => withTransaction(request.context, async (client) => {
    const { restaurantId } = request.query
    if (!restaurantId) return reply.code(400).send({ error: 'restaurant_required' })
    const restaurant = await client.query('select id from app.restaurants where tenant_id=$1 and id=$2',[request.context.tenantId,restaurantId])
    if(!restaurant.rows[0]) return reply.code(404).send({error:'restaurant_not_found'})
    const outlets=await client.query('select id,slug,name from app.outlets where tenant_id=$1 and restaurant_id=$2 order by name',[request.context.tenantId,restaurantId])
    const orders=await client.query('select outlet_id,status,grand_total,placed_at from app.orders where tenant_id=$1 and restaurant_id=$2',[request.context.tenantId,restaurantId])
    const tables=await client.query('select outlet_id,status,capacity from app.dining_tables where tenant_id=$1 and restaurant_id=$2',[request.context.tenantId,restaurantId])
    const payments=await client.query('select status,amount from app.payments where tenant_id=$1 and restaurant_id=$2',[request.context.tenantId,restaurantId])
    const team=await client.query("select count(distinct user_id)::int total from app.tenant_memberships where tenant_id=$1 and status='active'",[request.context.tenantId])
    const outletRows=outlets.rows.map(outlet=>{const scopedOrders=orders.rows.filter(row=>row.outlet_id===outlet.id),scopedTables=tables.rows.filter(row=>row.outlet_id===outlet.id);return {slug:outlet.slug,name:outlet.name,revenue:scopedOrders.filter(row=>['served','completed'].includes(row.status)).reduce((sum,row)=>sum+Number(row.grand_total),0),orders:scopedOrders.length,activeTables:scopedTables.filter(row=>!['available','disabled'].includes(row.status)).length,totalTables:scopedTables.filter(row=>row.status!=='disabled').length,seats:scopedTables.reduce((sum,row)=>sum+Number(row.capacity||0),0)}})
    const days=Array.from({length:7},(_,index)=>{const date=new Date();date.setUTCHours(0,0,0,0);date.setUTCDate(date.getUTCDate()-(6-index));return date})
    const trend=days.map(date=>{const end=new Date(date);end.setUTCDate(end.getUTCDate()+1);const rows=orders.rows.filter(row=>{const placed=new Date(row.placed_at);return placed>=date&&placed<end});return {date:date.toISOString().slice(0,10),revenue:rows.filter(row=>['served','completed'].includes(row.status)).reduce((sum,row)=>sum+Number(row.grand_total),0),orders:rows.length}})
    const statuses=Object.entries(orders.rows.reduce((counts,row)=>({...counts,[row.status]:(counts[row.status]||0)+1}),{})).map(([name,value])=>({name,value}))
    return {outlets:outletRows,trend,statuses,summary:{revenue:outletRows.reduce((sum,row)=>sum+row.revenue,0),orders:orders.rows.length,averageOrder:orders.rows.length?orders.rows.reduce((sum,row)=>sum+Number(row.grand_total),0)/orders.rows.length:0,activeTables:outletRows.reduce((sum,row)=>sum+row.activeTables,0),totalTables:outletRows.reduce((sum,row)=>sum+row.totalTables,0),verifiedPayments:payments.rows.filter(row=>row.status==='verified').reduce((sum,row)=>sum+Number(row.amount),0),teamMembers:team.rows[0]?.total||0}}
  }))
}
