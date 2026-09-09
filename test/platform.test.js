import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { pool } from "../src/db.js";
import { platformRoutes } from "../src/routes/platform.js";
import {
  requireOnlineOutlet,
  registerApiMetrics,
} from "../src/modules/platform-access.js";

test("platform permissions, management, analytics and subscription enforcement", async () => {
  const client = await pool.connect(),
    app = Fastify();
  const nested = {
    query: (sql, args) =>
      client.query(
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
  };
  await client.query("begin");
  try {
    const migration = await readFile(
      new URL(
        "../../BiteLinkQR/database/migrations/019_platform_control.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await client.query(
      migration.replace(/^begin;/, "").replace(/commit;\s*$/, ""),
    );
    const operationsMigration = await readFile(
      new URL(
        "../../BiteLinkQR/database/migrations/020_platform_operations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await client.query(
      operationsMigration.replace(/^begin;/, "").replace(/commit;\s*$/, ""),
    );
    const tenant = randomUUID(),
      restaurant = randomUUID(),
      outlet = randomUUID(),
      admin = randomUUID(),
      member = randomUUID(),
      subscription = randomUUID();
    await client.query(
      "insert into app.users(id,auth_subject,email,display_name,is_platform_admin) values($1::uuid,$1::text,$2,'Test admin',true),($3::uuid,$3::text,$4,'Test member',false)",
      [admin, `${admin}@example.test`, member, `${member}@example.test`],
    );
    await client.query(
      "insert into app.tenants(id,name,slug,status) values($1::uuid,'Platform test',$1::text,'active')",
      [tenant],
    );
    await client.query(
      "insert into app.restaurants(id,tenant_id,name,slug,status) values($1::uuid,$2,'Test restaurant',$1::text,'draft')",
      [restaurant, tenant],
    );
    await client.query(
      "insert into app.outlets(id,tenant_id,restaurant_id,name,slug,status) values($1::uuid,$2,$3,'Test outlet',$1::text,'setup')",
      [outlet, tenant, restaurant],
    );
    const plan = (await client.query("select id from billing.plans limit 1"))
      .rows[0].id;
    await client.query(
      "insert into billing.subscriptions(id,tenant_id,plan_id,status,current_period_start,current_period_end) values($1,$2,$3,'active',now()-interval '2 days',now()+interval '1 day')",
      [subscription, tenant, plan],
    );
    app.decorate("db", {
      query: (...args) => client.query(...args),
      connect: async () => nested,
    });
    registerApiMetrics(app);
    await app.register(
      async (api) => {
        api.addHook("preHandler", async (request) => {
          request.identity = {
            userId: request.headers["x-test-user"] || member,
          };
        });
        await api.register(platformRoutes);
      },
      { prefix: "/api/platform" },
    );
    await app.register(
      async (api) => {
        api.addHook("preHandler", requireOnlineOutlet);
        api.get(
          "/restaurants/:restaurantSlug/outlets/:outletSlug",
          async () => ({ online: true }),
        );
      },
      { prefix: "/api/public" },
    );
    const call = (url, method = "GET", payload, user = admin) =>
      app.inject({ url, method, payload, headers: { "x-test-user": user } });
    assert.equal(
      (await call("/api/platform/overview", "GET", undefined, member))
        .statusCode,
      403,
    );
    for (const resource of [
      "overview",
      "restaurants",
      "outlets",
      "subscriptions",
      "plans",
      "api-analytics",
      "audit",
      "outlet-requests",
    ]) {
      const response = await call(`/api/platform/${resource}`);
      assert.equal(response.statusCode, 200, `${resource}: ${response.body}`);
    }
    const publicUrl = `/api/public/restaurants/${restaurant}/outlets/${outlet}`;
    assert.equal((await call(publicUrl)).statusCode, 403);
    for (const [resource, id] of [
      ["restaurants", restaurant],
      ["outlets", outlet],
    ]) {
      const response = await call(`/api/platform/${resource}/${id}`, "PATCH", {
        status: "active",
        reason: "Test approval",
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.equal((await call(publicUrl)).statusCode, 200);
    await client.query(
      "update billing.subscriptions set current_period_end=now()-interval '1 hour' where id=$1",
      [subscription],
    );
    assert.equal((await call(publicUrl)).statusCode, 403);
    await client.query("savepoint blocked_order");
    await assert.rejects(
      client.query(
        "insert into app.orders(tenant_id,restaurant_id,outlet_id) values($1,$2,$3)",
        [tenant, restaurant, outlet],
      ),
      /outlet_offline/,
    );
    await client.query("rollback to savepoint blocked_order");
    const body = {
      planId: plan,
      status: "active",
      billingInterval: "monthly",
      endsAt: new Date(Date.now() + 86400000 * 30).toISOString(),
      reason: "Test confirmed renewal",
    };
    const renewed = await call(
      `/api/platform/subscriptions/${subscription}`,
      "PATCH",
      body,
    );
    assert.equal(renewed.statusCode, 200, renewed.body);
    assert.equal((await call(publicUrl)).statusCode, 200);
    assert.equal(
      (
        await call(`/api/platform/subscriptions/${subscription}`, "PATCH", {
          ...body,
          endsAt: "2020-01-01T00:00:00.000Z",
        })
      ).statusCode,
      400,
    );
    await call(`/api/platform/outlets/${outlet}`, "PATCH", {
      status: "paused",
      reason: "Manual pause",
    });
    await call(`/api/platform/subscriptions/${subscription}`, "PATCH", body);
    assert.equal(
      (await call(publicUrl)).statusCode,
      403,
      "renewal must not undo manual pause",
    );
    await client.query(
      "update billing.subscriptions set status='trialing',trial_ends_at=now()-interval '1 hour' where id=$1",
      [subscription],
    );
    assert.equal(
      (
        await client.query("select billing.tenant_access_allowed($1) allowed", [
          tenant,
        ])
      ).rows[0].allowed,
      false,
    );
    await client.query(
      "update billing.subscriptions set status='cancelled' where id=$1",
      [subscription],
    );
    assert.equal(
      (
        await client.query("select billing.tenant_access_allowed($1) allowed", [
          tenant,
        ])
      ).rows[0].allowed,
      false,
    );
    assert.ok(
      (
        await client.query(
          "select count(*)::int n from app.platform_audit where actor_id=$1",
          [admin],
        )
      ).rows[0].n >= 5,
    );
    assert.ok(
      (await call("/api/platform/api-analytics")).json().items.length > 0,
    );
  } finally {
    await app.close();
    await client.query("rollback");
    client.release();
    await pool.end();
  }
});
