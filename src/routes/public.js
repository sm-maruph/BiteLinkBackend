import { withPublicTransaction } from '../db.js'

export async function publicRoutes(app) {
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
    return result
  })
}
