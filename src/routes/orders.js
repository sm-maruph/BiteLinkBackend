import { createHash } from 'node:crypto'
import { withTransaction } from '../db.js'
import { orderBody, pagination, parse, statusBody, uuid } from '../schemas.js'
import { z } from 'zod'
import { publishRealtime } from '../realtime.js'

const hashBody = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export async function orderRoutes(app) {
  app.get('/orders', async (request) => {
    const query = parse(pagination, request.query)
    return withTransaction(request.context, async (client) => {
      const { rows } = await client.query(
        `select o.*, coalesce(jsonb_agg(jsonb_build_object('id', oi.id, 'name', oi.item_name_snapshot,
                'quantity', oi.quantity, 'unitPrice', oi.unit_price_snapshot, 'lineTotal', oi.line_total)
                order by oi.created_at) filter (where oi.id is not null), '[]') items,
                count(*) over()::int total_count
           from app.orders o left join app.order_items oi on oi.tenant_id=o.tenant_id and oi.order_id=o.id
          where o.tenant_id=$1 and app.has_permission(o.tenant_id,'orders.read',o.restaurant_id,o.outlet_id)
          group by o.id order by o.placed_at desc limit $2 offset $3`,
        [request.context.tenantId, query.pageSize, (query.page - 1) * query.pageSize],
      )
      return { items: rows, page: query.page, pageSize: query.pageSize, total: rows[0]?.total_count ?? 0 }
    })
  })

  app.post('/orders', async (request, reply) => {
    const body = parse(orderBody, request.body)
    const idempotencyKey = request.headers['idempotency-key']
    if (!idempotencyKey || idempotencyKey.length > 200) return reply.code(400).send({ error: 'valid_idempotency_key_required' })

    return withTransaction(request.context, async (client) => {
      const existing = await client.query('select response_status, response_body, request_hash from app.idempotency_keys where tenant_id=$1 and idempotency_key=$2', [request.context.tenantId, idempotencyKey])
      const requestHash = hashBody(body)
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) return reply.code(409).send({ error: 'idempotency_key_reused' })
        return reply.code(existing.rows[0].response_status ?? 200).send(existing.rows[0].response_body)
      }

      const allowed = await client.query("select app.has_permission($1, 'orders.write', $2, $3) allowed", [request.context.tenantId, body.restaurantId, body.outletId])
      if (!allowed.rows[0].allowed) return reply.code(403).send({ error: 'permission_denied' })

      const ids = body.items.map((item) => item.menuItemId)
      const menu = await client.query(
        `select i.id, i.name, i.description, coalesce(omi.price_override, i.base_price) price,
                coalesce(omi.availability, i.availability) availability
           from app.menu_items i left join app.outlet_menu_items omi
             on omi.tenant_id=i.tenant_id and omi.menu_item_id=i.id and omi.outlet_id=$3
          where i.tenant_id=$1 and i.restaurant_id=$2 and i.id=any($4::uuid[]) for update of i`,
        [request.context.tenantId, body.restaurantId, body.outletId, ids],
      )
      if (menu.rows.length !== new Set(ids).size || menu.rows.some((item) => item.availability !== 'available')) {
        return reply.code(409).send({ error: 'menu_item_unavailable' })
      }
      const byId = new Map(menu.rows.map((item) => [item.id, item]))
      const lines = body.items.map((item) => ({ ...item, ...byId.get(item.menuItemId) }))
      const subtotal = lines.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0)
      const outlet = await client.query('select tax_rate, service_charge_rate from app.outlets where tenant_id=$1 and id=$2 and restaurant_id=$3', [request.context.tenantId, body.outletId, body.restaurantId])
      if (!outlet.rows[0]) return reply.code(404).send({ error: 'outlet_not_found' })
      const tax = Number((subtotal * Number(outlet.rows[0].tax_rate)).toFixed(2))
      const service = Number((subtotal * Number(outlet.rows[0].service_charge_rate)).toFixed(2))
      const orderNumber = await client.query('select app.next_order_number($1,$2) value', [request.context.tenantId, body.outletId])
      const created = await client.query(
        `insert into app.orders (tenant_id, restaurant_id, outlet_id, table_id, session_id, order_number,
          subtotal, tax_total, service_charge_total, grand_total, notes, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [request.context.tenantId, body.restaurantId, body.outletId, body.tableId, body.sessionId,
          orderNumber.rows[0].value, subtotal, tax, service, subtotal + tax + service, body.notes, request.context.userId],
      )
      for (const line of lines) {
        await client.query(
          `insert into app.order_items (tenant_id, order_id, menu_item_id, item_name_snapshot,
             description_snapshot, unit_price_snapshot, quantity, line_total)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [request.context.tenantId, created.rows[0].id, line.menuItemId, line.name, line.description, line.price, line.quantity, Number(line.price) * line.quantity],
        )
      }
      const response = { ...created.rows[0], items: lines }
      await client.query("select app.notify_order_staff($1,'orders.approve','order_placed','New order needs approval')", [created.rows[0].id])
      await client.query(`insert into app.idempotency_keys (tenant_id,idempotency_key,request_hash,response_status,response_body,expires_at) values ($1,$2,$3,201,$4,now()+interval '24 hours')`, [request.context.tenantId, idempotencyKey, requestHash, response])
      return reply.code(201).send(response)
    })
  })

  app.patch('/orders/:id/status', async (request, reply) => {
    const id = parse(uuid, request.params.id)
    const body = parse(statusBody, request.body)
    return withTransaction(request.context, async (client) => {
      const current = await client.query('select * from app.orders where tenant_id=$1 and id=$2 for update', [request.context.tenantId, id])
      if (!current.rows[0]) return reply.code(404).send({ error: 'order_not_found' })
      const transitions={pending:{confirmed:'orders.approve',rejected:'orders.approve',cancelled:'orders.approve'},confirmed:{preparing:'orders.cook',cancelled:'orders.approve'},preparing:{confirmed:'orders.cook',ready:'orders.ready',cancelled:'orders.approve'},ready:{serving:'orders.serve',served:'orders.serve'},serving:{served:'orders.serve'},served:{completed:'orders.complete'}}
      const requiredPermission=transitions[current.rows[0].status]?.[body.status]
      if (!requiredPermission) return reply.code(409).send({error:'invalid_order_status_transition',from:current.rows[0].status,to:body.status})
      const allowed = await client.query('select app.has_permission($1,$2,$3,$4) allowed', [request.context.tenantId,requiredPermission,current.rows[0].restaurant_id,current.rows[0].outlet_id])
      if (!allowed.rows[0].allowed) return reply.code(403).send({ error: 'permission_denied' })
      const estimate=body.estimatedMinutes??(body.status==='confirmed'?20:null)
      const { rows } = await client.query(`update app.orders set status=$3, confirmed_at=case when $3='confirmed' then now() else confirmed_at end, completed_at=case when $3='completed' then now() else completed_at end,estimated_ready_at=case when $4::int is not null then now()+($4::text||' minutes')::interval else estimated_ready_at end where tenant_id=$1 and id=$2 returning *`, [request.context.tenantId, id, body.status,estimate])
      await client.query('insert into app.order_status_history (tenant_id,order_id,from_status,to_status,changed_by,note) values ($1,$2,$3,$4,$5,$6)', [request.context.tenantId, id, current.rows[0].status, body.status, request.context.userId, body.note])
      if(body.status==='confirmed') await client.query("select app.notify_order_staff($1,'orders.cook','order_approved','Order approved for kitchen')",[id])
      if(body.status==='ready') await client.query("select app.notify_order_staff($1,'orders.serve','order_ready','Order ready to serve')",[id])
      if(body.status==='served') await client.query("select app.notify_order_staff($1,'orders.complete','order_served','Order served')",[id])
      await publishRealtime(client,{type:'order.status',tenantId:request.context.tenantId,restaurantId:current.rows[0].restaurant_id,outletId:current.rows[0].outlet_id,orderId:id,status:body.status,customerTokenHash:current.rows[0].customer_token_hash})
      return rows[0]
    })
  })

  app.patch('/orders/:id/estimate',async(request,reply)=>{
    const id=parse(uuid,request.params.id),body=parse(z.object({minutes:z.coerce.number().int().min(1).max(240).optional(),addMinutes:z.coerce.number().int().min(1).max(60).optional()}).refine(value=>(value.minutes?1:0)+(value.addMinutes?1:0)===1),request.body)
    return withTransaction(request.context,async client=>{
      const current=await client.query('select * from app.orders where tenant_id=$1 and id=$2 for update',[request.context.tenantId,id]);if(!current.rows[0])return reply.code(404).send({error:'order_not_found'})
      if(!['confirmed','preparing'].includes(current.rows[0].status))return reply.code(409).send({error:'estimate_not_editable'})
      const allowed=await client.query("select app.has_permission($1,'orders.cook',$2,$3) allowed",[request.context.tenantId,current.rows[0].restaurant_id,current.rows[0].outlet_id]);if(!allowed.rows[0]?.allowed)return reply.code(403).send({error:'permission_denied'})
      const {rows}=body.minutes?await client.query("update app.orders set estimated_ready_at=now()+($3::text||' minutes')::interval where tenant_id=$1 and id=$2 returning *",[request.context.tenantId,id,body.minutes]):await client.query("update app.orders set estimated_ready_at=greatest(coalesce(estimated_ready_at,now()),now())+($3::text||' minutes')::interval where tenant_id=$1 and id=$2 returning *",[request.context.tenantId,id,body.addMinutes])
      return rows[0]
    })
  })

  app.patch('/payments/:id/status', async (request, reply) => {
    const id = parse(uuid, request.params.id)
    const body = parse(z.object({status:z.enum(['verified','rejected'])}), request.body)
    return withTransaction(request.context, async (client) => {
      const current=await client.query('select p.*,o.customer_token_hash from app.payments p left join app.orders o on o.tenant_id=p.tenant_id and o.id=p.order_id where p.tenant_id=$1 and p.id=$2 for update of p',[request.context.tenantId,id])
      if(!current.rows[0]) return reply.code(404).send({error:'payment_not_found'})
      if(!['pending','submitted'].includes(current.rows[0].status)) return reply.code(409).send({error:'payment_already_processed'})
      const allowed=await client.query("select app.has_permission($1,'payments.verify',$2,$3) allowed",[request.context.tenantId,current.rows[0].restaurant_id,current.rows[0].outlet_id])
      if(!allowed.rows[0]?.allowed) return reply.code(403).send({error:'permission_denied'})
      const {rows}=await client.query(`update app.payments set status=$3,verified_at=case when $3='verified' then now() else null end,verified_by=case when $3='verified' then $4::uuid else null::uuid end where tenant_id=$1 and id=$2 returning *`,[request.context.tenantId,id,body.status,request.context.userId])
      await client.query('insert into app.payment_events(tenant_id,payment_id,event_type,status,actor_user_id) values($1,$2,$3,$4,$5)',[request.context.tenantId,id,'reviewed',body.status,request.context.userId])
      await publishRealtime(client,{type:'payment.status',tenantId:request.context.tenantId,restaurantId:current.rows[0].restaurant_id,outletId:current.rows[0].outlet_id,paymentId:id,status:body.status,customerTokenHash:current.rows[0].customer_token_hash})
      return rows[0]
    })
  })
}
