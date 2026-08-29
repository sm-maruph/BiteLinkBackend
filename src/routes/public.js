import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { pool, withPublicTransaction } from '../db.js'

const publicOrderBody = z.object({
  items: z.array(z.object({ menuItemId: z.string().uuid(), quantity: z.number().int().min(1).max(99) })).min(1).max(100),
  notes: z.string().trim().max(1000).optional(),
})

export async function publicRoutes(app) {
  app.get('/restaurants/:restaurantSlug/outlets/:outletSlug/tables/:tableNumber/orders', async (request, reply) => {
    const { restaurantSlug, outletSlug, tableNumber } = request.params
    const result = await pool.query(
      `select ord.id,ord.order_number,ord.status,ord.subtotal,ord.discount_total,ord.grand_total,ord.placed_at,
              coalesce(jsonb_agg(jsonb_build_object('id',oi.menu_item_id,'name',oi.item_name_snapshot,'price',oi.unit_price_snapshot,'quantity',oi.quantity)
                order by oi.created_at) filter (where oi.id is not null),'[]') items
         from app.restaurants r join app.outlets o on o.tenant_id=r.tenant_id and o.restaurant_id=r.id
         join app.dining_tables t on t.tenant_id=r.tenant_id and t.restaurant_id=r.id and t.outlet_id=o.id
         join app.orders ord on ord.tenant_id=r.tenant_id and ord.restaurant_id=r.id and ord.outlet_id=o.id and ord.table_id=t.id
         left join app.order_items oi on oi.tenant_id=ord.tenant_id and oi.order_id=ord.id
        where r.slug=$1 and o.slug=$2 and t.table_number=$3
        group by ord.id order by ord.placed_at desc limit 50`,
      [restaurantSlug, outletSlug, tableNumber],
    )
    return { items: result.rows }
  })

  app.get('/restaurants/:restaurantSlug/outlets/:outletSlug/tables/:tableNumber/orders/latest', async (request, reply) => {
    const { restaurantSlug, outletSlug, tableNumber } = request.params
    const result = await pool.query(
      `select ord.id,ord.order_number,ord.status,ord.subtotal,ord.discount_total,ord.grand_total,ord.placed_at
         from app.restaurants r join app.outlets o on o.tenant_id=r.tenant_id and o.restaurant_id=r.id
         join app.dining_tables t on t.tenant_id=r.tenant_id and t.restaurant_id=r.id and t.outlet_id=o.id
         join app.orders ord on ord.tenant_id=r.tenant_id and ord.restaurant_id=r.id and ord.outlet_id=o.id and ord.table_id=t.id
        where r.slug=$1 and o.slug=$2 and t.table_number=$3 order by ord.placed_at desc limit 1`,
      [restaurantSlug, outletSlug, tableNumber],
    )
    const order = result.rows[0] || null
    if (!order) return reply.code(404).send({ error: 'order_not_found' })
    return order
  })

  app.post('/restaurants/:restaurantSlug/outlets/:outletSlug/tables/:tableNumber/orders', async (request, reply) => {
    const parsed = publicOrderBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_order', details: parsed.error.issues })
    const { restaurantSlug, outletSlug, tableNumber } = request.params
    const client = await pool.connect()
    try {
      await client.query('begin')
      const location = await client.query(
        `select r.tenant_id,r.id restaurant_id,o.id outlet_id,o.tax_rate,o.service_charge_rate,t.id table_id
           from app.restaurants r join app.outlets o on o.tenant_id=r.tenant_id and o.restaurant_id=r.id
           join app.dining_tables t on t.tenant_id=r.tenant_id and t.restaurant_id=r.id and t.outlet_id=o.id
          where r.slug=$1 and o.slug=$2 and t.table_number=$3 and t.status<>'disabled'`,
        [restaurantSlug, outletSlug, tableNumber],
      )
      if (!location.rows[0]) { await client.query('rollback'); return reply.code(404).send({ error: 'table_not_found' }) }
      const place = location.rows[0]
      const ids = parsed.data.items.map((item) => item.menuItemId)
      const menu = await client.query(
        `select i.id,i.name,i.description,coalesce(omi.price_override,i.base_price) price,
                coalesce(omi.availability,i.availability) availability
           from app.menu_items i left join app.outlet_menu_items omi
             on omi.tenant_id=i.tenant_id and omi.menu_item_id=i.id and omi.outlet_id=$3
          where i.tenant_id=$1 and i.restaurant_id=$2 and i.id=any($4::uuid[])`,
        [place.tenant_id, place.restaurant_id, place.outlet_id, ids],
      )
      if (menu.rows.length !== new Set(ids).size || menu.rows.some((item) => item.availability !== 'available')) {
        await client.query('rollback'); return reply.code(409).send({ error: 'menu_item_unavailable' })
      }
      const session = await client.query(
        `select id from app.table_sessions where tenant_id=$1 and table_id=$2 and status='active' order by opened_at desc limit 1`,
        [place.tenant_id, place.table_id],
      )
      let sessionId = session.rows[0]?.id
      if (!sessionId) {
        const tokenHash = createHash('sha256').update(randomUUID()).digest('hex')
        const createdSession = await client.query(
          `insert into app.table_sessions (tenant_id,restaurant_id,outlet_id,table_id,public_token_hash)
           values ($1,$2,$3,$4,$5) returning id`,
          [place.tenant_id, place.restaurant_id, place.outlet_id, place.table_id, tokenHash],
        )
        sessionId = createdSession.rows[0].id
      }
      const byId = new Map(menu.rows.map((item) => [item.id, item]))
      const lines = parsed.data.items.map((item) => ({ ...item, ...byId.get(item.menuItemId) }))
      const subtotal = lines.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0)
      const offers=await client.query(`select offer_type,rules from app.offers where tenant_id=$1 and restaurant_id=$2 and (outlet_id is null or outlet_id=$3) and is_active and (starts_at is null or starts_at<=now()) and (ends_at is null or ends_at>=now())`,[place.tenant_id,place.restaurant_id,place.outlet_id])
      const discountFor=line=>{const matching=offers.rows.filter(offer=>offer.offer_type!=='combo'&&(offer.rules?.menuItemIds||[]).includes(line.menuItemId)).flatMap(offer=>offer.rules?.tiers||[]).filter(tier=>line.quantity>=Number(tier.quantity));const percent=matching.length?Math.max(...matching.map(tier=>Number(tier.percent))):0;return {percent,amount:Number((Number(line.price)*line.quantity*percent/100).toFixed(2))}}
      const discountedLines=lines.map(line=>({...line,discount:discountFor(line)})),tierDiscount=discountedLines.reduce((sum,line)=>sum+line.discount.amount,0),comboDiscount=offers.rows.filter(offer=>offer.offer_type==='combo').reduce((sum,offer)=>{const comboLines=(offer.rules?.menuItemIds||[]).map(id=>lines.find(line=>line.menuItemId===id));if(comboLines.some(line=>!line))return sum;const uses=Math.min(...comboLines.map(line=>line.quantity)),regular=comboLines.reduce((total,line)=>total+Number(line.price),0);return sum+Math.max(0,regular-Number(offer.rules.comboPrice||regular))*uses},0),discount=Number(Math.max(tierDiscount,comboDiscount).toFixed(2))
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`${place.tenant_id}:${place.outlet_id}:orders`])
      const number = await client.query('select coalesce(max(order_number),0)+1 value from app.orders where tenant_id=$1 and outlet_id=$2', [place.tenant_id, place.outlet_id])
      const created = await client.query(
        `insert into app.orders (tenant_id,restaurant_id,outlet_id,table_id,session_id,order_number,subtotal,discount_total,tax_total,service_charge_total,grand_total,notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,0,0,$9,$10) returning *`,
        [place.tenant_id, place.restaurant_id, place.outlet_id, place.table_id, sessionId, number.rows[0].value, subtotal, discount, subtotal - discount, parsed.data.notes],
      )
      for (const line of discountedLines) await client.query(
        `insert into app.order_items (tenant_id,order_id,menu_item_id,item_name_snapshot,description_snapshot,unit_price_snapshot,quantity,discount_snapshot,line_total)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [place.tenant_id, created.rows[0].id, line.menuItemId, line.name, line.description, line.price, line.quantity, line.discount.amount, Number(line.price) * line.quantity-line.discount.amount],
      )
      await client.query('commit')
      return reply.code(201).send({ ...created.rows[0], items: discountedLines })
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally { client.release() }
  })

  app.get('/demo/platform-overview', async () => withPublicTransaction(async (client) => {
    const totals = await client.query(
      `select count(distinct id)::int restaurants, count(distinct outlet_id)::int active_outlets
         from app.public_restaurants`,
    )
    const recent = await client.query(
      `select id, name, slug, count(outlet_id)::int outlets,
              jsonb_agg(jsonb_build_object('id',outlet_id,'name',outlet_name,'slug',outlet_slug) order by outlet_name) outlet_list
         from app.public_restaurants
        group by id,name,slug order by name limit 10`,
    )
    return {
      totals: { ...totals.rows[0], ordersToday: null, monthlyRecurringRevenue: null },
      restaurants: recent.rows,
      generatedAt: new Date().toISOString(),
    }
  }))

  app.get('/demo/workspaces/:restaurantSlug/:outletSlug', async (request, reply) => {
    const { restaurantSlug, outletSlug } = request.params
    const data = await withPublicTransaction(async (client) => {
      const restaurant = await client.query('select * from app.public_restaurants where slug=$1 and outlet_slug=$2', [restaurantSlug, outletSlug])
      if (!restaurant.rows[0]) return null
      const menu = await client.query('select * from app.public_menu_items where restaurant_slug=$1 and outlet_slug=$2 order by category_sort_order,sort_order', [restaurantSlug,outletSlug])
      const offers = await client.query('select * from app.public_offers where restaurant_slug=$1 and outlet_slug=$2 order by created_at desc', [restaurantSlug,outletSlug])
      const tables = await client.query('select * from app.public_demo_tables where restaurant_slug=$1 and outlet_slug=$2 order by table_number', [restaurantSlug,outletSlug])
      const orders = await client.query('select * from app.public_demo_orders where restaurant_slug=$1 and outlet_slug=$2 order by placed_at desc', [restaurantSlug,outletSlug])
      const payments = await client.query('select * from app.public_demo_payments where restaurant_slug=$1 and outlet_slug=$2 order by created_at desc', [restaurantSlug,outletSlug])
      const requests = await client.query('select * from app.public_demo_requests where restaurant_slug=$1 and outlet_slug=$2 order by created_at desc', [restaurantSlug,outletSlug])
      const team = await client.query("select * from app.public_demo_team where tenant_slug='bitelink-demo' order by display_name")
      const completedRevenue = orders.rows.filter((o) => o.status === 'completed').reduce((sum,o) => sum+Number(o.grand_total),0)
      const activeTables = tables.rows.filter((t) => t.status !== 'available' && t.status !== 'disabled').length
      return {
        restaurant: restaurant.rows[0], menu: menu.rows, offers: offers.rows, tables: tables.rows,
        orders: orders.rows, payments: payments.rows, requests: requests.rows, team: team.rows,
        metrics: { revenueToday: completedRevenue, ordersToday: orders.rows.length, activeTables, totalTables: tables.rows.length,
          averageOrder: orders.rows.length ? orders.rows.reduce((sum,o)=>sum+Number(o.grand_total),0)/orders.rows.length : 0 },
      }
    })
    if (!data) return reply.code(404).send({ error: 'demo_workspace_not_found' })
    return data
  })

  app.get('/demo/restaurants/:restaurantSlug/analytics', async (request, reply) => {
    const { restaurantSlug } = request.params
    const result = await withPublicTransaction(async (client) => {
      const outlets = await client.query('select outlet_slug,outlet_name from app.public_restaurants where slug=$1 order by outlet_name',[restaurantSlug])
      if (!outlets.rows.length) return null
      const orders = await client.query('select outlet_slug,status,grand_total,placed_at from app.public_demo_orders where restaurant_slug=$1',[restaurantSlug])
      const tables = await client.query('select outlet_slug,status,capacity from app.public_demo_tables where restaurant_slug=$1',[restaurantSlug])
      const payments = await client.query('select outlet_slug,status,amount,method,created_at from app.public_demo_payments where restaurant_slug=$1',[restaurantSlug])
      const team = await client.query("select count(*)::int total from app.public_demo_team where tenant_slug='bitelink-demo'")
      const outletRows=outlets.rows.map(outlet=>{
        const scopedOrders=orders.rows.filter(row=>row.outlet_slug===outlet.outlet_slug)
        const scopedTables=tables.rows.filter(row=>row.outlet_slug===outlet.outlet_slug)
        const revenue=scopedOrders.filter(row=>['served','completed'].includes(row.status)).reduce((sum,row)=>sum+Number(row.grand_total),0)
        return {slug:outlet.outlet_slug,name:outlet.outlet_name,revenue,orders:scopedOrders.length,
          activeTables:scopedTables.filter(row=>!['available','disabled'].includes(row.status)).length,totalTables:scopedTables.filter(row=>row.status!=='disabled').length,
          seats:scopedTables.reduce((sum,row)=>sum+Number(row.capacity||0),0)}
      })
      const days=Array.from({length:7},(_,index)=>{const date=new Date();date.setUTCHours(0,0,0,0);date.setUTCDate(date.getUTCDate()-(6-index));return date})
      const trend=days.map(date=>{const end=new Date(date);end.setUTCDate(end.getUTCDate()+1);const rows=orders.rows.filter(row=>{const placed=new Date(row.placed_at);return placed>=date&&placed<end});return {date:date.toISOString().slice(0,10),revenue:rows.filter(row=>['served','completed'].includes(row.status)).reduce((sum,row)=>sum+Number(row.grand_total),0),orders:rows.length}})
      const statuses=Object.entries(orders.rows.reduce((counts,row)=>({...counts,[row.status]:(counts[row.status]||0)+1}),{})).map(([name,value])=>({name,value}))
      return {outlets:outletRows,trend,statuses,summary:{revenue:outletRows.reduce((sum,row)=>sum+row.revenue,0),orders:orders.rows.length,
        averageOrder:orders.rows.length?orders.rows.reduce((sum,row)=>sum+Number(row.grand_total),0)/orders.rows.length:0,
        activeTables:outletRows.reduce((sum,row)=>sum+row.activeTables,0),totalTables:outletRows.reduce((sum,row)=>sum+row.totalTables,0),
        verifiedPayments:payments.rows.filter(row=>row.status==='verified').reduce((sum,row)=>sum+Number(row.amount),0),teamMembers:team.rows[0]?.total||0}}
    })
    if(!result) return reply.code(404).send({error:'demo_restaurant_not_found'})
    return result
  })

  app.get('/restaurants/:restaurantSlug/outlets/:outletSlug', async (request, reply) => {
    const { restaurantSlug, outletSlug } = request.params
    const result = await withPublicTransaction(async (client) => {
      const restaurant = await client.query(
        `select r.id, r.name, r.slug, r.logo_url, r.outlet_id, r.outlet_name,
                r.outlet_slug, r.address_line, r.city, r.outlet_phone,
                r.tagline, r.description, r.cover_image_url, r.phone, r.email, r.chef_name,
                r.social_links, r.seo, r.template_key, r.theme_key, r.design_settings
           from app.public_restaurants r
          where r.slug = $1 and r.outlet_slug = $2`,
        [restaurantSlug, outletSlug],
      )
      if (!restaurant.rows[0]) return null
      const menu = await client.query(
        `select restaurant_slug, outlet_slug, category_name, category_sort_order, id, name, slug,
                description, image_url, price, availability, preparation_minutes, is_featured, tags, sort_order
           from app.public_menu_items
          where restaurant_slug = $1 and outlet_slug = $2
          order by category_sort_order, sort_order, name`,
        [restaurantSlug, outletSlug],
      )
      const offers = await client.query(
        `select id, name, description, offer_type, discount_value, rules, starts_at, ends_at
           from app.public_offers
          where restaurant_slug = $1 and outlet_slug = $2
          order by created_at desc`,
        [restaurantSlug, outletSlug],
      )
      return { restaurant: restaurant.rows[0], menu: menu.rows, offers: offers.rows }
    })
    if (!result) return reply.code(404).send({ error: 'restaurant_or_outlet_not_found' })
    const popularity = await pool.query(
      `select oi.menu_item_id,count(*)::int order_count,sum(oi.quantity)::int quantity_ordered
         from app.order_items oi join app.orders o on o.tenant_id=oi.tenant_id and o.id=oi.order_id
        where o.restaurant_id=$1 and o.outlet_id=$2 and o.status not in ('rejected','cancelled')
        group by oi.menu_item_id order by quantity_ordered desc`,
      [result.restaurant.id, result.restaurant.outlet_id],
    )
    const counts = new Map(popularity.rows.map((item,index)=>[item.menu_item_id,{order_count:item.order_count,quantity_ordered:item.quantity_ordered,popular_now:index<5&&item.quantity_ordered>0}]))
    const now = new Date(), activeOffers = result.offers.filter(offer=>(!offer.starts_at||new Date(offer.starts_at)<=now)&&(!offer.ends_at||new Date(offer.ends_at)>=now))
    const targetedIds = new Set(activeOffers.flatMap(offer=>offer.rules?.menuItemIds||offer.rules?.itemIds||[]))
    result.menu = result.menu.map(item=>{const itemOffers=activeOffers.filter(offer=>(offer.rules?.menuItemIds||offer.rules?.itemIds||[]).includes(item.id));return {...item,...(counts.get(item.id)||{order_count:0,quantity_ordered:0,popular_now:false}),on_offer:itemOffers.length>0,offers:itemOffers.map(offer=>({id:offer.id,name:offer.name,description:offer.description,offerType:offer.offer_type,menuItemIds:offer.rules?.menuItemIds||[],comboPrice:offer.rules?.comboPrice,tiers:offer.rules?.tiers||[]}))}})
    result.comboOffers=activeOffers.filter(offer=>offer.offer_type==='combo').map(offer=>{const ids=offer.rules?.menuItemIds||[],items=result.menu.filter(item=>ids.includes(item.id)),regularPrice=items.reduce((sum,item)=>sum+Number(item.price),0),comboPrice=Number(offer.rules?.comboPrice||offer.discount_value);return {id:offer.id,name:offer.name,description:offer.description,comboPrice,regularPrice,savings:Math.max(0,regularPrice-comboPrice),items}}).filter(offer=>offer.items.length>=2)
    return result
  })
}
