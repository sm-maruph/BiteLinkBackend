import { z } from "zod";
import { parse, uuid } from "../schemas.js";
const text = z.string().trim().min(1).max(10000);
const title = z.string().trim().min(3).max(180);
const status = z.enum([
  "open",
  "in_progress",
  "waiting_client",
  "resolved",
  "closed",
]);
const incidentStatus = z.enum([
  "investigating",
  "identified",
  "monitoring",
  "resolved",
]);
const amount = z
  .number()
  .positive()
  .max(9999999999)
  .refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.0001,
    "Use at most two decimal places",
  );
const fail = (message, statusCode = 400) => {
  throw Object.assign(new Error(message), { statusCode });
};
export async function operationsRoutes(app, { platform = false } = {}) {
  const tx = async (fn) => {
    const db = await app.db.connect();
    try {
      await db.query("begin");
      const value = await fn(db);
      await db.query("commit");
      return value;
    } catch (error) {
      await db.query("rollback");
      throw error;
    } finally {
      db.release();
    }
  };
  const audit = (db, r, action, id, details) =>
    db.query(
      "insert into app.platform_audit(actor_id,action,target_id,details) values($1,$2,$3,$4)",
      [r.identity.userId, action, id, details],
    );
  const tenant = (r) => (platform ? null : r.context.tenantId);
  const ownedTicket = async (db, r, id, lock = false) => {
    const { rows } = await db.query(
      `select * from app.support_tickets where id=$1 and ($2::uuid is null or tenant_id=$2) ${lock ? "for update" : ""}`,
      [id, tenant(r)],
    );
    if (!rows[0]) fail("ticket_not_found", 404);
    return rows[0];
  };
  const billingAccess = async (r) => {
    if (platform) return;
    const { rows } = await app.db.query(
      `select 1 from app.tenant_memberships m join app.membership_roles mr on mr.membership_id=m.id and mr.tenant_id=m.tenant_id
   join app.role_permissions rp on rp.role_id=mr.role_id where m.user_id=$1 and m.tenant_id=$2 and m.status='active' and rp.permission_code='tenant.manage' limit 1`,
      [r.identity.userId, tenant(r)],
    );
    if (!rows[0]) fail("billing_permission_required", 403);
  };
  app.get("/tickets", async (r) => ({
    items: (
      await app.db.query(
        `select s.*,t.name tenant_name,u.display_name creator_name,
  (select count(*)::int from app.support_messages m where m.ticket_id=s.id) message_count,
  (select body from app.support_messages m where m.ticket_id=s.id order by created_at desc limit 1) last_message
  from app.support_tickets s join app.tenants t on t.id=s.tenant_id join app.users u on u.id=s.created_by
  where ($1::uuid is null or s.tenant_id=$1) order by s.updated_at desc limit 200`,
        [tenant(r)],
      )
    ).rows,
  }));
  app.get("/tickets/:id", async (r) => {
    const id = parse(uuid, r.params.id),
      ticket = await ownedTicket(app.db, r, id);
    const messages = await app.db.query(
      `select m.*,u.display_name sender_name from app.support_messages m join app.users u on u.id=m.sender_id where ticket_id=$1 order by m.created_at,m.id`,
      [id],
    );
    return { ticket, messages: messages.rows };
  });
  app.post("/tickets", async (r) => {
    const body = parse(
      z.object({
        tenantId: platform ? uuid : z.undefined().optional(),
        subject: title,
        body: text,
        kind: z.enum(["ticket", "message"]).default("ticket"),
        priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
      }),
      r.body,
    );
    return tx(async (db) => {
      const { rows } = await db.query(
        "insert into app.support_tickets(tenant_id,created_by,subject,kind,priority) values($1,$2,$3,$4,$5) returning *",
        [
          platform ? body.tenantId : tenant(r),
          r.identity.userId,
          body.subject,
          body.kind,
          body.priority,
        ],
      );
      await db.query(
        "insert into app.support_messages(ticket_id,sender_id,from_platform,body) values($1,$2,$3,$4)",
        [rows[0].id, r.identity.userId, platform, body.body],
      );
      if (platform)
        await audit(db, r, "support.create", rows[0].id, {
          subject: body.subject,
        });
      return rows[0];
    });
  });
  app.post("/tickets/:id/messages", async (r) => {
    const id = parse(uuid, r.params.id),
      body = parse(z.object({ body: text }), r.body);
    return tx(async (db) => {
      const ticket = await ownedTicket(db, r, id, true);
      const { rows } = await db.query(
        "insert into app.support_messages(ticket_id,sender_id,from_platform,body) values($1,$2,$3,$4) returning *",
        [id, r.identity.userId, platform, body.body],
      );
      await db.query(
        "update app.support_tickets set status=$2,updated_at=now() where id=$1",
        [
          id,
          platform
            ? "waiting_client"
            : ["waiting_client", "resolved", "closed"].includes(ticket.status)
              ? "open"
              : ticket.status,
        ],
      );
      if (platform)
        await audit(db, r, "support.reply", id, { messageId: rows[0].id });
      return rows[0];
    });
  });
  if (platform)
    app.patch("/tickets/:id", async (r) => {
      const id = parse(uuid, r.params.id),
        body = parse(
          z.object({
            status,
            priority: z.enum(["low", "normal", "high", "urgent"]),
            reason: title,
          }),
          r.body,
        );
      return tx(async (db) => {
        await ownedTicket(db, r, id, true);
        const { rows } = await db.query(
          "update app.support_tickets set status=$2,priority=$3,updated_at=now() where id=$1 returning *",
          [id, body.status, body.priority],
        );
        await audit(db, r, "support.status", id, body);
        return rows[0];
      });
    });
  app.get("/notifications", async (r) => ({
    items: (
      await app.db.query(
        `select n.*,t.name tenant_name,rd.read_at from app.platform_notifications n
  left join app.tenants t on t.id=n.tenant_id left join app.notification_reads rd on rd.notification_id=n.id and rd.user_id=$2
  where ($3::boolean or (n.status='sent' and (n.tenant_id is null or n.tenant_id=$1))) order by n.created_at desc limit 200`,
        [tenant(r), r.identity.userId, platform],
      )
    ).rows,
  }));
  app.post("/notifications/:id/read", async (r) => {
    const id = parse(uuid, r.params.id);
    const { rows } = await app.db.query(
      `insert into app.notification_reads(notification_id,user_id) select id,$2 from app.platform_notifications where id=$1 and status='sent' and ($4::boolean or tenant_id is null or tenant_id=$3) on conflict do nothing returning notification_id`,
      [id, r.identity.userId, tenant(r), platform],
    );
    return { read: rows.length > 0 };
  });
  app.get("/incidents", async (r) => ({
    items: (
      await app.db.query(
        `select i.*,t.name tenant_name,coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'body',u.body,'status',u.status,'created_at',u.created_at) order by u.created_at desc) from app.incident_updates u where u.incident_id=i.id),'[]') updates
  from app.platform_incidents i left join app.tenants t on t.id=i.tenant_id where ($2::boolean or (i.customer_visible and (i.tenant_id is null or i.tenant_id=$1))) order by i.updated_at desc limit 200`,
        [tenant(r), platform],
      )
    ).rows,
  }));
  app.get("/invoices", async (r) => {
    await billingAccess(r);
    return {
      items: (
        await app.db.query(
          `select i.*,t.name tenant_name,t.billing_email,
   coalesce((select sum(p.amount) from billing.platform_payments p where p.invoice_id=i.id and p.status='confirmed'),0) paid_amount
   from billing.platform_invoices i join app.tenants t on t.id=i.tenant_id where ($1::uuid is null or i.tenant_id=$1) order by i.created_at desc limit 200`,
          [tenant(r)],
        )
      ).rows,
    };
  });
  app.get("/payments", async (r) => {
    await billingAccess(r);
    return {
      items: (
        await app.db.query(
          `select p.*,i.tenant_id,i.currency,i.description,t.name tenant_name from billing.platform_payments p join billing.platform_invoices i on i.id=p.invoice_id join app.tenants t on t.id=i.tenant_id
  where ($1::uuid is null or i.tenant_id=$1) order by p.created_at desc limit 200`,
          [tenant(r)],
        )
      ).rows,
    };
  });
  app.post("/invoices/:id/payments", async (r) => {
    await billingAccess(r);
    const id = parse(uuid, r.params.id),
      body = parse(
        z.object({
          amount,
          reference: z.string().trim().min(3).max(180),
          method: z.enum(["bank_transfer", "mobile_banking", "cash", "other"]),
        }),
        r.body,
      );
    return tx(async (db) => {
      const { rows } = await db.query(
        "select * from billing.platform_invoices where id=$1 and ($2::uuid is null or tenant_id=$2) for update",
        [id, tenant(r)],
      );
      if (!rows[0]) fail("invoice_not_found", 404);
      if (rows[0].status !== "open") fail("invoice_not_open", 409);
      const paid = await db.query(
        "select coalesce(sum(amount),0) amount from billing.platform_payments where invoice_id=$1 and status='confirmed'",
        [id],
      );
      if (
        Math.round(body.amount * 100) >
        Math.round((Number(rows[0].amount) - Number(paid.rows[0].amount)) * 100)
      )
        fail("payment_exceeds_balance", 409);
      const duplicate = await db.query(
        "select id from billing.platform_payments where invoice_id=$1 and reference=$2 and status<>'rejected'",
        [id, body.reference],
      );
      if (duplicate.rows[0]) fail("payment_reference_already_submitted", 409);
      return (
        await db.query(
          "insert into billing.platform_payments(invoice_id,amount,reference,method,submitted_by) values($1,$2,$3,$4,$5) returning *",
          [id, body.amount, body.reference, body.method, r.identity.userId],
        )
      ).rows[0];
    });
  });
  if (!platform) return;
  app.get("/accounts", async () => ({
    items: (
      await app.db.query(
        "select id,name,billing_email,status from app.tenants order by name limit 1000",
      )
    ).rows,
  }));
  app.post("/invoices", async (r) => {
    const body = parse(
      z.object({
        tenantId: uuid,
        description: title,
        amount,
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/)
          .default("BDT"),
        dueAt: z.string().datetime({ offset: true }),
      }),
      r.body,
    );
    return tx(async (db) => {
      const { rows } = await db.query(
        "insert into billing.platform_invoices(tenant_id,description,amount,currency,due_at,created_by) values($1,$2,$3,$4,$5,$6) returning *",
        [
          body.tenantId,
          body.description,
          body.amount,
          body.currency,
          body.dueAt,
          r.identity.userId,
        ],
      );
      await audit(db, r, "invoice.create", rows[0].id, body);
      return rows[0];
    });
  });
  app.patch("/invoices/:id", async (r) => {
    const id = parse(uuid, r.params.id),
      body = parse(z.object({ reason: title }), r.body);
    return tx(async (db) => {
      const { rows } = await db.query(
        "select * from billing.platform_invoices where id=$1 for update",
        [id],
      );
      if (!rows[0]) fail("invoice_not_found", 404);
      const paid = await db.query(
        "select 1 from billing.platform_payments where invoice_id=$1 and status in ('submitted','confirmed') limit 1",
        [id],
      );
      if (paid.rows[0]) fail("review_or_resolve_payments_before_voiding", 409);
      await db.query(
        "update billing.platform_invoices set status='void' where id=$1",
        [id],
      );
      await audit(db, r, "invoice.void", id, body);
      return { id, status: "void" };
    });
  });
  app.patch("/payments/:id", async (r) => {
    const id = parse(uuid, r.params.id),
      body = parse(
        z.object({ status: z.enum(["confirmed", "rejected"]), reason: title }),
        r.body,
      );
    return tx(async (db) => {
      const payment = (
        await db.query(
          "select invoice_id from billing.platform_payments where id=$1",
          [id],
        )
      ).rows[0];
      if (!payment) fail("payment_not_found", 404);
      const invoice = (
        await db.query(
          "select * from billing.platform_invoices where id=$1 for update",
          [payment.invoice_id],
        )
      ).rows[0];
      const current = (
        await db.query(
          "select * from billing.platform_payments where id=$1 for update",
          [id],
        )
      ).rows[0];
      if (current.status !== "submitted") fail("payment_already_reviewed", 409);
      if (body.status === "confirmed") {
        if (invoice.status !== "open") fail("invoice_not_open", 409);
        const paid = (
          await db.query(
            "select coalesce(sum(amount),0) amount from billing.platform_payments where invoice_id=$1 and status='confirmed'",
            [invoice.id],
          )
        ).rows[0];
        if (
          Math.round((Number(paid.amount) + Number(current.amount)) * 100) >
          Math.round(Number(invoice.amount) * 100)
        )
          fail("payment_exceeds_balance", 409);
      }
      const { rows } = await db.query(
        "update billing.platform_payments set status=$2,review_note=$3,reviewed_by=$4,reviewed_at=now() where id=$1 returning *",
        [id, body.status, body.reason, r.identity.userId],
      );
      await db.query(
        "update billing.platform_invoices set status='paid' where id=$1 and amount<=(select coalesce(sum(amount),0) from billing.platform_payments where invoice_id=$1 and status='confirmed')",
        [invoice.id],
      );
      await audit(db, r, "payment.review", id, body);
      return rows[0];
    });
  });
  app.post("/notifications", async (r) => {
    const body = parse(
      z.object({
        tenantId: uuid.nullable().default(null),
        title,
        body: text,
        type: z.enum(["announcement", "payment_reminder", "renewal_alert"]),
      }),
      r.body,
    );
    return tx(async (db) => {
      const { rows } = await db.query(
        "insert into app.platform_notifications(tenant_id,title,body,type,created_by) values($1,$2,$3,$4,$5) returning *",
        [body.tenantId, body.title, body.body, body.type, r.identity.userId],
      );
      await audit(db, r, "notification.create", rows[0].id, {
        title: body.title,
      });
      return rows[0];
    });
  });
  app.patch("/notifications/:id", async (r) => {
    const id = parse(uuid, r.params.id),
      body = parse(
        z.union([
          z.object({ status: z.enum(["sent", "archived"]) }),
          z.object({
            tenantId: uuid.nullable(),
            title,
            body: text,
            type: z.enum(["announcement", "payment_reminder", "renewal_alert"]),
          }),
        ]),
        r.body,
      );
    if ("title" in body)
      return tx(async (db) => {
        const { rows } = await db.query(
          "update app.platform_notifications set tenant_id=$2,title=$3,body=$4,type=$5 where id=$1 and status='draft' returning *",
          [id, body.tenantId, body.title, body.body, body.type],
        );
        if (!rows[0]) fail("only_drafts_can_be_edited", 409);
        await audit(db, r, "notification.edit", id, { title: body.title });
        return rows[0];
      });
    return tx(async (db) => {
      const { rows } = await db.query(
        "update app.platform_notifications set status=$2,sent_at=case when $2='sent' then now() else sent_at end where id=$1 and (status='draft' or ($2='archived' and status='sent')) returning *",
        [id, body.status],
      );
      if (!rows[0]) fail("notification_not_available", 409);
      await audit(db, r, "notification." + body.status, id, {});
      return rows[0];
    });
  });
  app.post("/notifications/generate-renewals", async (r) =>
    tx(async (db) => {
      const { rows } = await db.query(
        `insert into app.platform_notifications(tenant_id,title,body,type,status,created_by,sent_at,dedupe_key)
   select s.tenant_id,'Subscription renewal reminder','Your '||p.name||' subscription ends on '||to_char(least(s.current_period_end,case when s.status='trialing' then s.trial_ends_at else s.current_period_end end) at time zone 'Asia/Dhaka','DD Mon YYYY HH24:MI')||' (Bangladesh time). Please contact BiteLink to renew.','renewal_alert','sent',$1,now(),
   'renewal:'||s.id::text||':'||s.current_period_end::text||':'||coalesce(s.trial_ends_at::text,'')
   from billing.subscriptions s join billing.plans p on p.id=s.plan_id
   where s.status in ('active','trialing','past_due') and least(s.current_period_end,case when s.status='trialing' then s.trial_ends_at else s.current_period_end end)<=now()+interval '7 days'
   on conflict(dedupe_key) do nothing returning id`,
        [r.identity.userId],
      );
      for (const row of rows)
        await audit(db, r, "notification.renewal", row.id, {});
      return { created: rows.length };
    }),
  );
  app.post("/incidents", async (r) => {
    const body = parse(
      z.object({
        tenantId: uuid.nullable().default(null),
        title,
        body: text,
        severity: z.enum(["minor", "major", "critical"]),
        customerVisible: z.boolean().default(true),
      }),
      r.body,
    );
    return tx(async (db) => {
      const { rows } = await db.query(
        "insert into app.platform_incidents(tenant_id,title,severity,customer_visible,created_by) values($1,$2,$3,$4,$5) returning *",
        [
          body.tenantId,
          body.title,
          body.severity,
          body.customerVisible,
          r.identity.userId,
        ],
      );
      await db.query(
        "insert into app.incident_updates(incident_id,body,status,created_by) values($1,$2,'investigating',$3)",
        [rows[0].id, body.body, r.identity.userId],
      );
      await audit(db, r, "incident.create", rows[0].id, {
        title: body.title,
        severity: body.severity,
      });
      return rows[0];
    });
  });
  app.patch("/incidents/:id", async (r) => {
    const id = parse(uuid, r.params.id),
      body = parse(z.object({ status: incidentStatus, body: text }), r.body);
    return tx(async (db) => {
      const { rows } = await db.query(
        "update app.platform_incidents set status=$2,updated_at=now() where id=$1 returning *",
        [id, body.status],
      );
      if (!rows[0]) fail("incident_not_found", 404);
      await db.query(
        "insert into app.incident_updates(incident_id,body,status,created_by) values($1,$2,$3,$4)",
        [id, body.body, body.status, r.identity.userId],
      );
      await audit(db, r, "incident.update", id, body);
      return rows[0];
    });
  });
}
