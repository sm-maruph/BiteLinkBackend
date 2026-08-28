export async function findLoginUser(db, email) {
  const { rows } = await db.query(
    `select u.id, u.email, u.display_name, u.status, c.password_hash, c.failed_attempts, c.locked_until
       from app.users u join app.user_credentials c on c.user_id=u.id
      where u.email=$1 and u.auth_provider='bitelink'`,
    [email],
  )
  return rows[0]
}

export async function listMemberships(db, userId) {
  const { rows } = await db.query(
    `select t.id, t.name, t.slug, m.status,
            coalesce(jsonb_agg(distinct jsonb_build_object('code',r.code,'scope',r.scope,
              'restaurantId',mr.restaurant_id,'outletId',mr.outlet_id)) filter (where r.id is not null),'[]') roles
       from app.tenant_memberships m join app.tenants t on t.id=m.tenant_id
       left join app.membership_roles mr on mr.tenant_id=m.tenant_id and mr.membership_id=m.id
       left join app.roles r on r.id=mr.role_id
      where m.user_id=$1 and m.status='active' group by t.id,m.status order by t.name`,
    [userId],
  )
  return rows
}
