import test from 'node:test'
import assert from 'node:assert/strict'
import { pool, withTransaction } from '../src/db.js'

test('RLS prevents a member from selecting another tenant orders',async t=>{
  t.after(()=>pool.end())
  const memberships=await pool.query("select user_id,tenant_id from app.tenant_memberships where status='active' order by created_at limit 20")
  const own=memberships.rows[0]
  const other=memberships.rows.find(row=>row.tenant_id!==own?.tenant_id)
  if(!own||!other)return t.skip('requires at least two tenants')
  const result=await withTransaction({userId:own.user_id,tenantId:own.tenant_id},client=>client.query('select tenant_id from app.orders where tenant_id=$1 limit 1',[other.tenant_id]))
  assert.equal(result.rowCount,0)
})
