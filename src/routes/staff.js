import { withTransaction } from '../db.js'
import { parse, roleAssignmentBody, roleBody, staffMemberBody, uuid } from '../schemas.js'
import { hashPassword } from '../modules/auth/password.js'
import { randomUUID } from 'node:crypto'

const canManage=async(client,context,restaurantId=null,outletId=null)=>(await client.query("select app.has_permission($1,'staff.manage',$2,$3) allowed",[context.tenantId,restaurantId,outletId])).rows[0]?.allowed

export async function staffRoutes(app) {
  app.post('/staff-members',async(request,reply)=>withTransaction(request.context,async client=>{
    const body=parse(staffMemberBody,request.body)
    if(!await canManage(client,request.context,body.restaurantId||null,body.outletId||null)) return reply.code(403).send({error:'permission_denied'})
    const role=await client.query('select id,name,code,scope from app.roles where tenant_id=$1 and id=$2',[request.context.tenantId,body.roleId])
    if(!role.rows[0]) return reply.code(404).send({error:'role_not_found'})
    if(role.rows[0].code==='owner') return reply.code(403).send({error:'owner_role_cannot_be_created_here'})
    if((role.rows[0].scope==='restaurant'&&!body.restaurantId)||(role.rows[0].scope==='outlet'&&(!body.restaurantId||!body.outletId))) return reply.code(400).send({error:'role_scope_required'})
    if(body.outletId){const valid=await client.query('select 1 from app.outlets where tenant_id=$1 and id=$2 and restaurant_id=$3',[request.context.tenantId,body.outletId,body.restaurantId]);if(!valid.rows[0])return reply.code(400).send({error:'invalid_role_scope'})}
    const existing=await client.query('select id from app.users where email=$1',[body.email])
    if(existing.rows[0]) return reply.code(409).send({error:'email_already_registered'})
    const userId=randomUUID()
    await client.query("insert into app.users(id,auth_provider,auth_subject,email,display_name,phone,status) values($1,'bitelink',$2,$3,$4,$5,'active')",[userId,body.email,body.email,body.displayName,body.phone||null])
    await client.query('insert into app.user_credentials(user_id,password_hash,must_change_password) values($1,$2,true)',[userId,await hashPassword(body.temporaryPassword)])
    const membership=await client.query("insert into app.tenant_memberships(tenant_id,user_id,status,joined_at) values($1,$2,'active',now()) returning id",[request.context.tenantId,userId])
    await client.query('insert into app.membership_roles(tenant_id,membership_id,role_id,restaurant_id,outlet_id,granted_by) values($1,$2,$3,$4,$5,$6)',[request.context.tenantId,membership.rows[0].id,body.roleId,body.restaurantId||null,body.outletId||null,request.context.userId])
    return reply.code(201).send({id:userId,email:body.email,display_name:body.displayName,phone:body.phone||null,status:'active',role:role.rows[0].name,mustChangePassword:true})
  }))
  app.get('/notifications',async request=>withTransaction(request.context,async client=>{
    const {rows}=await client.query('select * from app.notifications where tenant_id=$1 and user_id=$2 order by created_at desc limit 100',[request.context.tenantId,request.context.userId])
    return {items:rows,unread:rows.filter(item=>!item.read_at).length}
  }))
  app.patch('/notifications/:id/read',async(request,reply)=>withTransaction(request.context,async client=>{
    const id=parse(uuid,request.params.id)
    const {rows}=await client.query('update app.notifications set read_at=coalesce(read_at,now()) where tenant_id=$1 and user_id=$2 and id=$3 returning *',[request.context.tenantId,request.context.userId,id])
    return rows[0]||reply.code(404).send({error:'notification_not_found'})
  }))
  app.get('/roles',async request=>withTransaction(request.context,async client=>{
    const {rows}=await client.query(`select r.*,coalesce(jsonb_agg(rp.permission_code order by rp.permission_code) filter(where rp.permission_code is not null),'[]') permissions from app.roles r left join app.role_permissions rp on rp.role_id=r.id where r.tenant_id=$1 group by r.id order by r.is_system desc,r.name`,[request.context.tenantId])
    return {items:rows}
  }))
  app.post('/roles',async(request,reply)=>withTransaction(request.context,async client=>{
    const body=parse(roleBody,request.body)
    if(!await canManage(client,request.context,body.restaurantId,body.outletId)) return reply.code(403).send({error:'permission_denied'})
    const known=await client.query('select code from app.permissions where code=any($1::citext[])',[body.permissions])
    if(known.rowCount!==new Set(body.permissions).size) return reply.code(400).send({error:'unknown_permission'})
    const created=await client.query('insert into app.roles(tenant_id,code,name,description,scope) values($1,$2,$3,$4,$5) returning *',[request.context.tenantId,body.code,body.name,body.description,body.scope])
    for(const permission of body.permissions) await client.query('insert into app.role_permissions(role_id,permission_code) values($1,$2)',[created.rows[0].id,permission])
    return reply.code(201).send({...created.rows[0],permissions:body.permissions})
  }))
  app.post('/role-assignments',async(request,reply)=>withTransaction(request.context,async client=>{
    const body=parse(roleAssignmentBody,request.body)
    if(!await canManage(client,request.context,body.restaurantId,body.outletId)) return reply.code(403).send({error:'permission_denied'})
    const role=await client.query('select scope from app.roles where tenant_id=$1 and id=$2',[request.context.tenantId,body.roleId])
    if(!role.rows[0]) return reply.code(404).send({error:'role_not_found'})
    if((role.rows[0].scope==='restaurant'&&!body.restaurantId)||(role.rows[0].scope==='outlet'&&(!body.restaurantId||!body.outletId))) return reply.code(400).send({error:'role_scope_required'})
    if(body.outletId){const scope=await client.query('select 1 from app.outlets where tenant_id=$1 and id=$2 and restaurant_id=$3',[request.context.tenantId,body.outletId,body.restaurantId]);if(!scope.rows[0]) return reply.code(400).send({error:'invalid_role_scope'})}
    const {rows}=await client.query(`insert into app.membership_roles(tenant_id,membership_id,role_id,restaurant_id,outlet_id,granted_by) values($1,$2,$3,$4,$5,$6) on conflict do nothing returning *`,[request.context.tenantId,body.membershipId,body.roleId,body.restaurantId,body.outletId,request.context.userId])
    return reply.code(201).send(rows[0]||{assigned:true})
  }))
}
