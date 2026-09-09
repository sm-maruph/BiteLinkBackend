export async function requireOnlineOutlet(request, reply) {
  const { restaurantSlug, outletSlug } = request.params || {};
  if (!restaurantSlug || !outletSlug) return;
  // Existing order tracking and settlement remain available after expiry.
  if (
    request.params.orderId ||
    (request.method === "GET" && request.routeOptions.url.includes("/orders"))
  )
    return;
  const { rows } = await request.server.db.query(
    `select o.status outlet_status,r.status restaurant_status,
    billing.tenant_access_allowed(o.tenant_id) subscribed
    from app.outlets o join app.restaurants r on r.id=o.restaurant_id and r.tenant_id=o.tenant_id
    where r.slug=$1 and o.slug=$2`,
    [restaurantSlug, outletSlug],
  );
  if (
    rows[0] &&
    (rows[0].outlet_status !== "active" ||
      rows[0].restaurant_status !== "active" ||
      !rows[0].subscribed)
  ) {
    return reply
      .code(403)
      .send({
        error: "outlet_offline",
        message:
          "This outlet is currently offline. Please contact the restaurant.",
      });
  }
}

export function registerApiMetrics(app) {
  app.addHook("onResponse", async (request, reply) => {
    if (!request.routeOptions.url?.startsWith("/api/")) return;
    try {
      await app.db.query(
        `insert into app.api_metrics(bucket,method,route,status,requests,duration_ms)
        values(date_trunc('minute',now()),$1,$2,$3,1,$4)
        on conflict(bucket,method,route,status) do update set requests=app.api_metrics.requests+1,duration_ms=app.api_metrics.duration_ms+excluded.duration_ms`,
        [
          request.method,
          request.routeOptions.url,
          reply.statusCode,
          reply.elapsedTime,
        ],
      );
    } catch (error) {
      request.log.warn(
        { code: error.code },
        "API metrics could not be recorded",
      );
    }
  });
  const retention = setInterval(() => {
    app.db
      .query(
        "delete from app.api_metrics where bucket<now()-interval '30 days'",
      )
      .catch((error) =>
        app.log.warn({ code: error.code }, "Metrics retention failed"),
      );
  }, 3600000);
  retention.unref();
  app.addHook("onClose", async () => clearInterval(retention));
}
