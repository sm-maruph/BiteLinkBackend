import { operationsRoutes } from "./operations.js";
import { z } from "zod";
import { parse, uuid } from "../schemas.js";

export async function platformRoutes(app) {
  app.addHook("preHandler", async (request, reply) => {
    const { rows } = await app.db.query(
      "select id from app.users where id=$1 and is_platform_admin and status='active'",
      [request.identity.userId],
    );
    if (!rows[0])
      return reply.code(403).send({ error: "platform_admin_required" });
  });
  await app.register(operationsRoutes, { platform: true });
  const audit = async (client, request, action, id, details) =>
    client.query(
      "insert into app.platform_audit(actor_id,action,target_id,details) values($1,$2,$3,$4)",
      [request.identity.userId, action, id, details],
    );
  const transaction = async (work) => {
    const client = await app.db.connect();
    try {
      await client.query("begin");
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  };
  app.get("/overview", async () => {
    const [totals, trend, subscriptions, api] = await Promise.all([
      app.db
        .query(`select (select count(*)::int from app.restaurants) restaurants,
        (select count(*)::int from app.restaurants where status='draft') restaurant_requests,
        (select count(*)::int from app.outlets where status='setup') outlet_requests,
        (select count(*)::int from app.outlets o join app.restaurants r on r.id=o.restaurant_id where o.status='active' and r.status='active' and billing.tenant_access_allowed(o.tenant_id)) online_outlets,
        (select count(*)::int from app.users) users,
        (select count(*)::int from billing.subscriptions where status in ('active','trialing') and billing.tenant_access_allowed(tenant_id)) current_subscriptions,
        (select count(*)::int from billing.subscriptions where status in ('active','trialing','past_due') and least(current_period_end,case when status='trialing' then trial_ends_at else current_period_end end)<=now()+interval '7 days') renewals_due,
        (select count(*)::int from app.support_tickets where status not in ('resolved','closed')) open_tickets,
        (select count(*)::int from app.platform_incidents where status<>'resolved') open_incidents,
        (select count(*)::int from billing.platform_payments where status='submitted') payments_pending`),
      app.db
        .query(`select to_char(d,'YYYY-MM-DD') date,count(t.id)::int accounts
        from generate_series((now() at time zone 'Asia/Dhaka')::date-29,(now() at time zone 'Asia/Dhaka')::date,interval '1 day') d
        left join app.tenants t on (t.created_at at time zone 'Asia/Dhaka')::date=d::date group by d order by d`),
      app.db.query(`select p.currency,count(*)::int subscriptions,
        coalesce(sum(case when s.billing_interval='monthly' then p.monthly_price when s.billing_interval='yearly' then p.yearly_price/12 else 0 end) filter(where s.status='active' and s.current_period_start<=now() and s.current_period_end>now()),0) mrr
        from billing.subscriptions s join billing.plans p on p.id=s.plan_id group by p.currency`),
      app.db
        .query(`select coalesce(sum(requests),0) requests,coalesce(sum(requests) filter(where status>=400),0) errors,
        coalesce(sum(duration_ms)/nullif(sum(requests),0),0) average_ms from app.api_metrics where bucket>=now()-interval '24 hours'`),
    ]);
    return {
      totals: totals.rows[0],
      trend: trend.rows,
      recurring: subscriptions.rows,
      api: api.rows[0],
      generatedAt: new Date().toISOString(),
    };
  });
  app.get("/restaurants", async () => ({
    items: (
      await app.db
        .query(`select r.id,r.tenant_id,r.name,r.slug,r.status,r.created_at,t.name tenant_name,t.billing_email,
    count(o.id)::int outlets from app.restaurants r join app.tenants t on t.id=r.tenant_id left join app.outlets o on o.restaurant_id=r.id
    group by r.id,t.id order by r.created_at desc limit 1000`)
    ).rows,
  }));
  app.get("/outlets", async () => ({
    items: (
      await app.db
        .query(`select o.id,o.tenant_id,o.restaurant_id,o.name,o.slug,o.status,o.city,o.address_line,o.phone,o.created_at,r.name restaurant_name,
    r.status restaurant_status,billing.tenant_access_allowed(o.tenant_id) subscription_valid,
    o.status='active' and r.status='active' and billing.tenant_access_allowed(o.tenant_id) online
    from app.outlets o join app.restaurants r on r.id=o.restaurant_id order by o.created_at desc limit 1000`)
    ).rows,
  }));
  app.get("/outlet-requests", async () => ({
    items: (
      await app.db.query(
        `select o.id,o.name,o.created_at,r.name restaurant_name from app.outlets o join app.restaurants r on r.id=o.restaurant_id where o.status='setup' order by o.created_at`,
      )
    ).rows,
  }));
  for (const [resource, states] of [
    ["restaurants", ["draft", "active", "paused", "archived"]],
    ["outlets", ["setup", "active", "paused", "closed"]],
  ]) {
    app.patch(`/${resource}/:id`, async (request, reply) => {
      const id = parse(uuid, request.params.id),
        body = parse(
          z.object({
            status: z.enum(states),
            reason: z.string().trim().min(3).max(500),
          }),
          request.body,
        );
      return transaction(async (client) => {
        const before = await client.query(
          `select status from app.${resource} where id=$1 for update`,
          [id],
        );
        if (!before.rows[0])
          return reply.code(404).send({ error: "record_not_found" });
        const { rows } = await client.query(
          `update app.${resource} set status=$2 where id=$1 returning id,status`,
          [id, body.status],
        );
        await audit(client, request, `${resource}.status`, id, {
          from: before.rows[0].status,
          ...body,
        });
        return rows[0];
      });
    });
  }
  app.get("/subscriptions", async () => ({
    items: (
      await app.db
        .query(`select s.*,t.name tenant_name,t.billing_email,p.name plan_name,p.currency,p.monthly_price,p.yearly_price,
    billing.tenant_access_allowed(s.tenant_id) access_allowed,
    case when s.status in ('active','trialing') and (s.current_period_end<=now() or (s.status='trialing' and s.trial_ends_at<=now())) then 'expired' else s.status end effective_status
    from billing.subscriptions s join app.tenants t on t.id=s.tenant_id join billing.plans p on p.id=s.plan_id order by s.created_at desc limit 1000`)
    ).rows,
  }));
  app.get("/plans", async () => ({
    items: (
      await app.db.query("select * from billing.plans order by monthly_price")
    ).rows,
  }));
  app.patch("/subscriptions/:id", async (request, reply) => {
    const id = parse(uuid, request.params.id);
    const body = parse(
      z.object({
        planId: uuid,
        status: z.enum([
          "trialing",
          "active",
          "past_due",
          "paused",
          "cancelled",
          "expired",
        ]),
        billingInterval: z.enum(["monthly", "yearly", "custom"]),
        endsAt: z.string().datetime({ offset: true }),
        reason: z.string().trim().min(3).max(500),
      }),
      request.body,
    );
    if (
      ["active", "trialing"].includes(body.status) &&
      new Date(body.endsAt) <= new Date()
    )
      return reply.code(400).send({ error: "future_expiry_required" });
    return transaction(async (client) => {
      const before = await client.query(
        "select * from billing.subscriptions where id=$1 for update",
        [id],
      );
      if (!before.rows[0])
        return reply.code(404).send({ error: "subscription_not_found" });
      if (
        new Date(body.endsAt) <= new Date(before.rows[0].current_period_start)
      )
        return reply
          .code(400)
          .send({ error: "expiry_must_follow_period_start" });
      const { rows } = await client.query(
        `update billing.subscriptions set plan_id=$2,status=$3,billing_interval=$4,current_period_end=$5,
        trial_ends_at=case when $3='trialing' then $5::timestamptz else trial_ends_at end,
        cancelled_at=case when $3='cancelled' then now() else null end,cancel_at_period_end=false where id=$1 returning *`,
        [id, body.planId, body.status, body.billingInterval, body.endsAt],
      );
      await client.query(
        "insert into billing.subscription_events(tenant_id,subscription_id,event_type,payload) values($1,$2,$3,$4)",
        [
          rows[0].tenant_id,
          id,
          "platform_update",
          { actorId: request.identity.userId, ...body },
        ],
      );
      await audit(client, request, "subscription.update", id, {
        before: {
          status: before.rows[0].status,
          endsAt: before.rows[0].current_period_end,
          planId: before.rows[0].plan_id,
        },
        ...body,
      });
      return rows[0];
    });
  });
  app.get("/api-analytics", async () => {
    const [routes, trend] = await Promise.all([
      app.db
        .query(`select method,route,sum(requests)::int requests,coalesce(sum(requests) filter(where status>=400),0)::int errors,
        coalesce(sum(requests) filter(where status>=500),0)::int server_errors,round((sum(duration_ms)/nullif(sum(requests),0))::numeric,1) average_ms
        from app.api_metrics where bucket>=now()-interval '24 hours' group by method,route order by requests desc limit 100`),
      app.db
        .query(`select date_trunc('hour',bucket) as hour,sum(requests)::int requests,coalesce(sum(requests) filter(where status>=400),0)::int errors
        from app.api_metrics where bucket>=now()-interval '24 hours' group by 1 order by 1`),
    ]);
    return { items: routes.rows, trend: trend.rows, retentionDays: 30 };
  });
  app.get("/api-analytics/details", async (request) => {
    const input = parse(
      z.object({
        route: z.string().min(1).max(500),
        method: z.string().min(1).max(20),
      }),
      request.query,
    );
    const [statuses, hours] = await Promise.all([
      app.db.query(
        `select status,sum(requests)::int requests,round((sum(duration_ms)/nullif(sum(requests),0))::numeric,1) average_ms,max(bucket) last_seen from app.api_metrics where route=$1 and method=$2 and bucket>=now()-interval '24 hours' group by status order by status`,
        [input.route, input.method],
      ),
      app.db.query(
        `select date_trunc('hour',bucket) as hour,sum(requests)::int requests,coalesce(sum(requests) filter(where status>=400),0)::int errors,round((sum(duration_ms)/nullif(sum(requests),0))::numeric,1) average_ms from app.api_metrics where route=$1 and method=$2 and bucket>=now()-interval '24 hours' group by 1 order by 1`,
        [input.route, input.method],
      ),
    ]);
    return {
      window: "Last 24 hours",
      statuses: statuses.rows,
      hours: hours.rows,
    };
  });
  app.get("/audit", async () => ({
    items: (
      await app.db.query(
        `select a.*,u.email actor_email from app.platform_audit a left join app.users u on u.id=a.actor_id order by a.created_at desc limit 200`,
      )
    ).rows,
  }));
}
