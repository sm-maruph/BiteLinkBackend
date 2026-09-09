import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool } from "../src/db.js";
import { platformRoutes } from "../src/routes/platform.js";
import { operationsRoutes } from "../src/routes/operations.js";
import { resolveTenantContext } from "../src/modules/auth/middleware.js";

test("client support, notifications, incidents and invoice verification remain tenant isolated", async () => {
  const db = await pool.connect(),
    app = Fastify();
  await db.query("begin");
  try {
    for (const file of [
      "019_platform_control.sql",
      "020_platform_operations.sql",
    ]) {
      const sql = await readFile(
        new URL(
          `../../BiteLinkQR/database/migrations/${file}`,
          import.meta.url,
        ),
        "utf8",
      );
      await db.query(sql.replace(/^begin;/, "").replace(/commit;\s*$/, ""));
    }
    const admin = randomUUID(),
      clientA = randomUUID(),
      clientB = randomUUID(),
      tenantA = randomUUID(),
      tenantB = randomUUID();
    for (const [id, isAdmin] of [
      [admin, true],
      [clientA, false],
      [clientB, false],
    ])
      await db.query(
        "insert into app.users(id,auth_subject,email,display_name,is_platform_admin) values($1::uuid,$1::text,$2,'Operations test',$3)",
        [id, `${id}@example.test`, isAdmin],
      );
    for (const [tenant, user] of [
      [tenantA, clientA],
      [tenantB, clientB],
    ]) {
      await db.query(
        "insert into app.tenants(id,name,slug,status) values($1::uuid,'Operations fixture',$1::text,'active')",
        [tenant],
      );
      await db.query("select app.provision_tenant_roles($1)", [tenant]);
      const membership = (
        await db.query(
          "insert into app.tenant_memberships(tenant_id,user_id,status) values($1,$2,'active') returning id",
          [tenant, user],
        )
      ).rows[0];
      const role = (
        await db.query(
          "select id from app.roles where tenant_id=$1 and code='owner'",
          [tenant],
        )
      ).rows[0];
      await db.query(
        "insert into app.membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)",
        [tenant, membership.id, role.id],
      );
    }
    app.decorate("db", {
      query: (...args) => db.query(...args),
      connect: async () => ({
        query: (sql, args) =>
          db.query(
            sql === "begin"
              ? "savepoint mutation"
              : sql === "commit"
                ? "release savepoint mutation"
                : sql === "rollback"
                  ? "rollback to savepoint mutation"
                  : sql,
            args,
          ),
        release: () => {},
      }),
    });
    app.addHook("preHandler", async (r) => {
      r.identity = { userId: r.headers["x-test-user"] || clientA };
    });
    await app.register(platformRoutes, { prefix: "/api/platform" });
    await app.register(
      async (child) => {
        child.addHook("preHandler", resolveTenantContext);
        await child.register(operationsRoutes);
      },
      { prefix: "/api/v1/support" },
    );
    const call = async (
      path,
      method = "GET",
      body,
      user = admin,
      tenant = tenantA,
    ) =>
      app.inject({
        url: path,
        method,
        payload: body,
        headers: { "x-test-user": user, "x-tenant-id": tenant },
      });
    const client = (
      path,
      method = "GET",
      body,
      user = clientA,
      tenant = tenantA,
    ) => call("/api/v1/support/" + path, method, body, user, tenant);
    const platform = (path, method = "GET", body) =>
      call("/api/platform/" + path, method, body);
    const good = async (response, code = 200) => {
      assert.equal(response.statusCode, code, response.body);
      return response.json();
    };
    assert.equal(
      (await call("/api/platform/accounts", "GET", undefined, clientA))
        .statusCode,
      403,
    );
    assert.equal(
      (await client("tickets", "GET", undefined, clientA, tenantB)).statusCode,
      403,
    );
    const ticket = await good(
      await client("tickets", "POST", {
        subject: "Need renewal assistance",
        body: "Please check my subscription.",
        kind: "ticket",
        priority: "high",
      }),
    );
    assert.equal(
      (await client(`tickets/${ticket.id}`, "GET", undefined, clientB, tenantB))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await client(
          `tickets/${ticket.id}/messages`,
          "POST",
          { body: "Cross tenant attack" },
          clientB,
          tenantB,
        )
      ).statusCode,
      404,
    );
    await good(
      await platform(`tickets/${ticket.id}/messages`, "POST", {
        body: "Here is the solution: submit your payment reference.",
      }),
    );
    let conversation = await good(await client(`tickets/${ticket.id}`));
    assert.equal(conversation.messages.length, 2);
    assert.equal(conversation.ticket.status, "waiting_client");
    assert.equal(conversation.messages[1].from_platform, true);
    await good(
      await platform(`tickets/${ticket.id}`, "PATCH", {
        status: "resolved",
        priority: "normal",
        reason: "Solution supplied",
      }),
    );
    await good(
      await client(`tickets/${ticket.id}/messages`, "POST", {
        body: "I have a follow-up question.",
      }),
    );
    conversation = await good(await client(`tickets/${ticket.id}`));
    assert.equal(conversation.ticket.status, "open");
    const note = await good(
      await platform("notifications", "POST", {
        tenantId: tenantA,
        title: "Payment reminder",
        body: "Please renew your subscription.",
        type: "payment_reminder",
      }),
    );
    assert.equal(
      (await good(await client("notifications"))).items.some(
        (n) => n.id === note.id,
      ),
      false,
    );
    await good(
      await platform(`notifications/${note.id}`, "PATCH", { status: "sent" }),
    );
    assert.equal(
      (await good(await client("notifications"))).items.some(
        (n) => n.id === note.id,
      ),
      true,
    );
    assert.equal(
      (
        await good(
          await client("notifications", "GET", undefined, clientB, tenantB),
        )
      ).items.some((n) => n.id === note.id),
      false,
    );
    await good(await client(`notifications/${note.id}/read`, "POST", {}));
    assert.ok(
      (await good(await client("notifications"))).items.find(
        (n) => n.id === note.id,
      ).read_at,
    );
    assert.equal(
      (await platform(`notifications/${note.id}`, "PATCH", { status: "sent" }))
        .statusCode,
      409,
    );
    const incident = await good(
      await platform("incidents", "POST", {
        tenantId: tenantA,
        title: "API latency investigation",
        body: "We are investigating increased latency.",
        severity: "minor",
        customerVisible: true,
      }),
    );
    await good(
      await platform(`incidents/${incident.id}`, "PATCH", {
        status: "resolved",
        body: "Latency is back to normal.",
      }),
    );
    const incidents = await good(await client("incidents"));
    assert.equal(
      incidents.items.find((i) => i.id === incident.id).updates.length,
      2,
    );
    assert.equal(
      (
        await good(
          await client("incidents", "GET", undefined, clientB, tenantB),
        )
      ).items.some((i) => i.id === incident.id),
      false,
    );
    const internal = await good(
      await platform("incidents", "POST", {
        title: "Internal maintenance",
        body: "Internal note.",
        severity: "minor",
        customerVisible: false,
      }),
    );
    assert.equal(
      (await good(await client("incidents"))).items.some(
        (i) => i.id === internal.id,
      ),
      false,
    );
    const invoice = await good(
      await platform("invoices", "POST", {
        tenantId: tenantA,
        description: "Monthly subscription",
        amount: 100,
        currency: "BDT",
        dueAt: new Date().toISOString(),
      }),
    );
    assert.equal(
      (
        await good(await client("invoices", "GET", undefined, clientB, tenantB))
      ).items.some((i) => i.id === invoice.id),
      false,
    );
    assert.equal(
      (
        await client(
          `invoices/${invoice.id}/payments`,
          "POST",
          { amount: 100, reference: "OTHER-CLIENT", method: "bank_transfer" },
          clientB,
          tenantB,
        )
      ).statusCode,
      404,
    );
    const payment = await good(
      await client(`invoices/${invoice.id}/payments`, "POST", {
        amount: 100,
        reference: "TEST-REF-001",
        method: "bank_transfer",
      }),
    );
    assert.equal(
      (await good(await client("invoices"))).items.find(
        (i) => i.id === invoice.id,
      ).status,
      "open",
    );
    assert.equal(
      (
        await client(`invoices/${invoice.id}/payments`, "POST", {
          amount: 100,
          reference: "TEST-REF-001",
          method: "bank_transfer",
        })
      ).statusCode,
      409,
    );
    await good(
      await platform(`payments/${payment.id}`, "PATCH", {
        status: "confirmed",
        reason: "Verified payment receipt",
      }),
    );
    assert.equal(
      (await good(await client("invoices"))).items.find(
        (i) => i.id === invoice.id,
      ).status,
      "paid",
    );
    assert.equal(
      (
        await platform(`payments/${payment.id}`, "PATCH", {
          status: "confirmed",
          reason: "Repeat verification",
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await platform(`invoices/${invoice.id}`, "PATCH", {
          reason: "Cannot void a paid invoice",
        })
      ).statusCode,
      409,
    );
    const draft = await good(await platform('notifications','POST',{tenantId:tenantA,title:'Draft notice',body:'Original body',type:'announcement'}));
    await good(await platform(`notifications/${draft.id}`,'PATCH',{tenantId:tenantA,title:'Edited notice',body:'Updated body',type:'announcement'}));
    assert.equal((await good(await platform('notifications'))).items.find(n=>n.id===draft.id).body,'Updated body');
    const plan=(await db.query('select id from billing.plans limit 1')).rows[0].id;
    await db.query("insert into billing.subscriptions(tenant_id,plan_id,status,current_period_start,current_period_end) values($1,$2,'active',now(),now()+interval '2 days')",[tenantA,plan]);
    const firstAlerts=await good(await platform('notifications/generate-renewals','POST',{}));
    assert.ok(firstAlerts.created>=1);
    assert.equal((await good(await platform('notifications/generate-renewals','POST',{}))).created,0);
    await good(await platform('api-analytics/details?method=GET&route=%2Fapi%2Fplatform%2Foverview'));
    const partialInvoice=await good(await platform('invoices','POST',{tenantId:tenantA,description:'Partial payment test',amount:100,currency:'BDT',dueAt:new Date().toISOString()}));
    const p1=await good(await client(`invoices/${partialInvoice.id}/payments`,'POST',{amount:70,reference:'PARTIAL-A',method:'bank_transfer'}));
    const p2=await good(await client(`invoices/${partialInvoice.id}/payments`,'POST',{amount:50,reference:'PARTIAL-B',method:'bank_transfer'}));
    await good(await platform(`payments/${p1.id}`,'PATCH',{status:'confirmed',reason:'First receipt verified'}));
    assert.equal((await platform(`payments/${p2.id}`,'PATCH',{status:'confirmed',reason:'Should exceed remaining balance'})).statusCode,409);
    assert.equal((await good(await client('invoices'))).items.find(i=>i.id===partialInvoice.id).status,'open');
    assert.ok(
      (await good(await platform("audit"))).items.some(
        (a) => a.target_id === payment.id && a.action === "payment.review",
      ),
    );
  } finally {
    await app.close();
    await db.query("rollback");
    db.release();
    await pool.end();
  }
});
