import { withTransaction } from '../db.js'
import { outletBody,parse,restaurantBody,themeBody,uuid } from '../schemas.js'

export async function organizationRoutes(app){
  app.post('/restaurants',async(request,reply)=>withTransaction(request.context,async client=>{
    const body=parse(restaurantBody,request.body)
    const allowed=await client.query("select app.has_permission($1,'tenant.manage') allowed",[request.context.tenantId])
    if(!allowed.rows[0]?.allowed)return reply.code(403).send({error:'permission_denied'})
    const {rows}=await client.query("insert into app.restaurants(tenant_id,name,slug,status) values($1,$2,$3,'active') returning *",[request.context.tenantId,body.name,body.slug])
    await client.query('insert into app.restaurant_profiles(tenant_id,restaurant_id) values($1,$2)',[request.context.tenantId,rows[0].id])
    await client.query('insert into app.restaurant_themes(tenant_id,restaurant_id,template_key,theme_key,published_at) values($1,$2,$3,$4,now())',[request.context.tenantId,rows[0].id,body.templateKey,body.themeKey])
    return reply.code(201).send(rows[0])
  }))
  app.post('/outlets',async(request,reply)=>withTransaction(request.context,async client=>{
    const body=parse(outletBody,request.body)
    const allowed=await client.query("select app.has_permission($1,'outlet.manage',$2,null) allowed",[request.context.tenantId,body.restaurantId])
    if(!allowed.rows[0]?.allowed)return reply.code(403).send({error:'permission_denied'})
    const subscription=await client.query(`select s.status,p.name plan_name,e.limit_value from billing.subscriptions s join billing.plans p on p.id=s.plan_id left join billing.plan_entitlements e on e.plan_id=p.id and e.feature_key='outlets.max' where s.tenant_id=$1 and s.status in ('trialing','active','past_due','paused') order by s.created_at desc limit 1`,[request.context.tenantId])
    if(!subscription.rows[0]||!['trialing','active'].includes(subscription.rows[0].status))return reply.code(402).send({error:'active_subscription_required'})
    const usage=await client.query("select count(*)::int total from app.outlets where tenant_id=$1 and status<>'closed'",[request.context.tenantId])
    const limit=subscription.rows[0].limit_value===null?null:Number(subscription.rows[0].limit_value)
    if(limit!==null&&usage.rows[0].total>=limit)return reply.code(409).send({error:'outlet_limit_reached',limit,used:usage.rows[0].total,plan:subscription.rows[0].plan_name})
    const {rows}=await client.query("insert into app.outlets(tenant_id,restaurant_id,name,slug,address_line,city,status) values($1,$2,$3,$4,$5,$6,'setup') returning *",[request.context.tenantId,body.restaurantId,body.name,body.slug,body.addressLine,body.city])
    return reply.code(201).send(rows[0])
  }))
  app.get('/subscription-usage',async request=>withTransaction(request.context,async client=>{const subscription=await client.query(`select p.name plan_name,e.limit_value,s.status from billing.subscriptions s join billing.plans p on p.id=s.plan_id left join billing.plan_entitlements e on e.plan_id=p.id and e.feature_key='outlets.max' where s.tenant_id=$1 and s.status in ('trialing','active','past_due','paused') order by s.created_at desc limit 1`,[request.context.tenantId]);const usage=await client.query("select count(*)::int total,count(*) filter(where status='active')::int active,count(*) filter(where status='setup')::int pending from app.outlets where tenant_id=$1 and status<>'closed'",[request.context.tenantId]);return {...subscription.rows[0],...usage.rows[0]} }))
  app.patch('/outlets/:id/approve',async(request,reply)=>withTransaction(request.context,async client=>{const id=parse(uuid,request.params.id);const admin=await client.query('select app.is_platform_admin() allowed');if(!admin.rows[0]?.allowed)return reply.code(403).send({error:'platform_admin_required'});const {rows}=await client.query("update app.outlets set status='active' where tenant_id=$1 and id=$2 and status='setup' returning *",[request.context.tenantId,id]);return rows[0]||reply.code(404).send({error:'pending_outlet_not_found'})}))
  app.patch('/restaurants/:id/theme',async(request,reply)=>withTransaction(request.context,async client=>{
    const id=parse(uuid,request.params.id),body=parse(themeBody,request.body)
    const allowed=await client.query("select app.has_permission($1,'restaurant.manage',$2,null) allowed",[request.context.tenantId,id])
    if(!allowed.rows[0]?.allowed)return reply.code(403).send({error:'permission_denied'})
    const {rows}=await client.query('update app.restaurant_themes set template_key=$3,theme_key=$4,published_at=now() where tenant_id=$1 and restaurant_id=$2 returning *',[request.context.tenantId,id,body.templateKey,body.themeKey])
    return rows[0]||reply.code(404).send({error:'restaurant_not_found'})
  }))
}
