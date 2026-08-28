import { randomUUID } from 'node:crypto'
import { config } from '../../config.js'
import { hashPassword, verifyPassword } from './password.js'
import { createAccessToken, hashToken, newOpaqueToken } from './tokens.js'
import { findLoginUser, listMemberships } from './repository.js'

const expiresAt = () => new Date(Date.now() + config.REFRESH_TOKEN_DAYS * 86_400_000)

async function issueSession(db, user, requestInfo, familyId = randomUUID()) {
  const refreshToken = newOpaqueToken()
  await db.query(
    `insert into app.auth_sessions(user_id,refresh_token_hash,family_id,expires_at,ip_address,user_agent)
     values($1,$2,$3,$4,$5,$6)`,
    [user.id, hashToken(refreshToken), familyId, expiresAt(), requestInfo.ip, requestInfo.userAgent],
  )
  return { accessToken: await createAccessToken(user), refreshToken, expiresIn: config.ACCESS_TOKEN_TTL }
}

export async function login(db, input, requestInfo) {
  const user = await findLoginUser(db, input.email)
  if (!user || user.status !== 'active' || (user.locked_until && new Date(user.locked_until) > new Date())) return null
  if (!(await verifyPassword(user.password_hash, input.password))) {
    await db.query(`update app.user_credentials set failed_attempts=failed_attempts+1,
      locked_until=case when failed_attempts+1>=5 then now()+interval '15 minutes' else locked_until end where user_id=$1`, [user.id])
    return null
  }
  await db.query('update app.user_credentials set failed_attempts=0,locked_until=null where user_id=$1', [user.id])
  await db.query('update app.users set last_login_at=now() where id=$1', [user.id])
  return { user: { id: user.id, email: user.email, displayName: user.display_name, mustChangePassword:user.must_change_password, isPlatformAdmin:user.is_platform_admin }, tenants: await listMemberships(db, user.id), ...(await issueSession(db, user, requestInfo)) }
}

export async function refresh(db, rawToken, requestInfo) {
  const tokenHash = hashToken(rawToken)
  await db.query('begin')
  try {
    const { rows } = await db.query(`select s.*,u.email,u.display_name,u.status,u.is_platform_admin,c.must_change_password from app.auth_sessions s join app.users u on u.id=s.user_id join app.user_credentials c on c.user_id=u.id where s.refresh_token_hash=$1 for update`, [tokenHash])
    const session = rows[0]
    if (!session || session.revoked_at || new Date(session.expires_at) <= new Date() || session.status !== 'active') {
      if (session?.family_id) await db.query('update app.auth_sessions set revoked_at=coalesce(revoked_at,now()) where family_id=$1', [session.family_id])
      await db.query('commit')
      return null
    }
    await db.query('update app.auth_sessions set revoked_at=now(),last_used_at=now() where id=$1', [session.id])
    const user = { id: session.user_id, email: session.email, display_name: session.display_name }
    const next = await issueSession(db, user, requestInfo, session.family_id)
    await db.query('update app.auth_sessions set replaced_by=(select id from app.auth_sessions where refresh_token_hash=$1) where id=$2', [hashToken(next.refreshToken), session.id])
    await db.query('commit')
    return { user: { id: user.id, email: user.email, displayName: user.display_name, mustChangePassword:session.must_change_password, isPlatformAdmin:session.is_platform_admin }, tenants: await listMemberships(db, user.id), ...next }
  } catch (error) {
    await db.query('rollback')
    throw error
  }
}

export async function logout(db, rawToken) {
  if (rawToken) await db.query('update app.auth_sessions set revoked_at=coalesce(revoked_at,now()) where refresh_token_hash=$1', [hashToken(rawToken)])
}

export async function changePassword(db,userId,input){
  const {rows}=await db.query('select password_hash from app.user_credentials where user_id=$1',[userId])
  if(!rows[0]||!(await verifyPassword(rows[0].password_hash,input.currentPassword))) return false
  await db.query('update app.user_credentials set password_hash=$2,password_changed_at=now(),must_change_password=false,failed_attempts=0,locked_until=null where user_id=$1',[userId,await hashPassword(input.newPassword)])
  return true
}

async function provisionAccount(db, input, requireEmpty) {
  await db.query('begin')
  try {
    if (requireEmpty) {
      const exists = await db.query('select exists(select 1 from app.user_credentials) value')
      if (exists.rows[0].value) throw Object.assign(new Error('Platform is already bootstrapped'), { statusCode: 409 })
    }
    const passwordHash = await hashPassword(input.password)
    const user = await db.query(`insert into app.users(auth_provider,auth_subject,email,display_name,status) values('bitelink',$1,$2,$3,'active') returning *`, [input.email, input.email, input.displayName])
    await db.query('insert into app.user_credentials(user_id,password_hash) values($1,$2)', [user.rows[0].id, passwordHash])
    const tenant = await db.query(`insert into app.tenants(name,slug,billing_email,status) values($1,$2,$3,'trialing') returning *`, [input.tenantName, input.tenantSlug, input.email])
    await db.query('select app.provision_tenant_roles($1)', [tenant.rows[0].id])
    const membership = await db.query(`insert into app.tenant_memberships(tenant_id,user_id,status,joined_at) values($1,$2,'active',now()) returning *`, [tenant.rows[0].id, user.rows[0].id])
    const ownerRole = await db.query("select id from app.roles where tenant_id=$1 and code='owner'", [tenant.rows[0].id])
    await db.query('insert into app.membership_roles(tenant_id,membership_id,role_id,granted_by) values($1,$2,$3,$4)', [tenant.rows[0].id, membership.rows[0].id, ownerRole.rows[0].id, user.rows[0].id])
    const restaurant = await db.query(`insert into app.restaurants(tenant_id,name,slug,status) values($1,$2,$3,'active') returning *`, [tenant.rows[0].id, input.restaurantName, input.restaurantSlug])
    await db.query(`insert into app.restaurant_profiles(tenant_id,restaurant_id,tagline,description,cover_image_url,phone,email,chef_name)
      values($1,$2,$3,$4,$5,$6,$7,$8)`, [tenant.rows[0].id, restaurant.rows[0].id, input.profile?.tagline||null, input.profile?.description||null, input.profile?.coverImageUrl||null, input.profile?.phone||null, input.profile?.email||null, input.profile?.chefName||null])
    await db.query("insert into app.restaurant_themes(tenant_id,restaurant_id,template_key,theme_key,published_at) values($1,$2,$3,$4,now())", [tenant.rows[0].id, restaurant.rows[0].id,input.templateKey,input.themeKey])
    const outlet = await db.query(`insert into app.outlets(tenant_id,restaurant_id,name,slug,status) values($1,$2,$3,$4,'active') returning *`, [tenant.rows[0].id, restaurant.rows[0].id, input.outletName, input.outletSlug])
    for (const [categoryIndex, categoryInput] of input.categories.entries()) {
      const category = await db.query(`insert into app.menu_categories(tenant_id,restaurant_id,name,slug,description,sort_order)
        values($1,$2,$3,$4,$5,$6) returning id`, [tenant.rows[0].id, restaurant.rows[0].id, categoryInput.name, categoryInput.slug, categoryInput.description||null, categoryIndex+1])
      for (const [itemIndex, item] of categoryInput.items.entries()) {
        await db.query(`insert into app.menu_items(tenant_id,restaurant_id,category_id,name,slug,description,image_url,base_price,preparation_minutes,is_featured,sort_order)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [tenant.rows[0].id, restaurant.rows[0].id, category.rows[0].id, item.name, item.slug, item.description||null, item.imageUrl||null, item.price, item.preparationMinutes, item.featured, itemIndex+1])
      }
    }
    for (const offer of input.offers) {
      await db.query(`insert into app.offers(tenant_id,restaurant_id,outlet_id,name,description,offer_type,discount_value,starts_at,ends_at,is_active)
        values($1,$2,$3,$4,$5,$6,$7,now(),now()+interval '30 days',true)`, [tenant.rows[0].id, restaurant.rows[0].id, outlet.rows[0].id, offer.name, offer.description||null, offer.offerType, offer.discountValue])
    }
    const plan=await db.query("select id from billing.plans where code='starter' and is_active limit 1")
    if(!plan.rows[0]) throw Object.assign(new Error('Starter plan is not configured'),{statusCode:503})
    await db.query(`insert into billing.subscriptions(tenant_id,plan_id,status,billing_interval,seats,trial_ends_at,current_period_start,current_period_end)
      values($1,$2,'trialing','monthly',1,now()+interval '7 days',now(),now()+interval '7 days')`,[tenant.rows[0].id,plan.rows[0].id])
    await db.query('commit')
    return { user: user.rows[0], tenant: tenant.rows[0], restaurant: restaurant.rows[0], outlet: outlet.rows[0] }
  } catch (error) {
    await db.query('rollback')
    throw error
  }
}

export const bootstrap = (db, input) => provisionAccount(db, input, true)
export const registerTenant = (db, input) => provisionAccount(db, input, false)
