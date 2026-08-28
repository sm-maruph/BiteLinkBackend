import { parse,uuid } from '../schemas.js'

async function requirePlatformAdmin(app,request,reply){const {rows}=await app.db.query('select is_platform_admin from app.users where id=$1',[request.identity.userId]);if(!rows[0]?.is_platform_admin){reply.code(403).send({error:'platform_admin_required'});return false}return true}
export async function platformRoutes(app){
  app.get('/outlet-requests',async(request,reply)=>{if(!await requirePlatformAdmin(app,request,reply))return;const {rows}=await app.db.query(`select o.id,o.name,o.slug,o.city,o.address_line,o.created_at,r.name restaurant_name,t.name tenant_name from app.outlets o join app.restaurants r on r.id=o.restaurant_id and r.tenant_id=o.tenant_id join app.tenants t on t.id=o.tenant_id where o.status='setup' order by o.created_at`);return {items:rows}})
  app.patch('/outlet-requests/:id/approve',async(request,reply)=>{if(!await requirePlatformAdmin(app,request,reply))return;const id=parse(uuid,request.params.id);const {rows}=await app.db.query("update app.outlets set status='active' where id=$1 and status='setup' returning *",[id]);return rows[0]||reply.code(404).send({error:'pending_outlet_not_found'})})
  app.patch('/outlet-requests/:id/reject',async(request,reply)=>{if(!await requirePlatformAdmin(app,request,reply))return;const id=parse(uuid,request.params.id);const {rows}=await app.db.query("update app.outlets set status='closed' where id=$1 and status='setup' returning *",[id]);return rows[0]||reply.code(404).send({error:'pending_outlet_not_found'})})
}
