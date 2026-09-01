# Production deployment baseline

Run at least two identical backend containers behind a managed HTTPS load balancer. WebSocket support and idle timeouts of at least 60 seconds must be enabled. Instances are stateless; PostgreSQL stores authentication and business state, while `LISTEN/NOTIFY` distributes realtime events across instances.

## Required controls

- Set `NODE_ENV=production`, `COOKIE_SECURE=true`, exact `FRONTEND_ORIGIN` values, and `TRUST_PROXY=true` only when the application is directly behind a trusted proxy.
- Use independently generated values for `ACCESS_TOKEN_SECRET`, `TABLE_QR_SECRET`, and `BOOTSTRAP_TOKEN`. Store them in a secret manager and rotate them through a documented procedure.
- Prefer a database endpoint with a verifiable certificate chain. Install the provider CA when necessary; use `DATABASE_SSL_REJECT_UNAUTHORIZED=false` only as a documented temporary exception.
- Apply migrations before shifting traffic. Never run migrations concurrently from every application replica.
- Put a distributed WAF/rate limit at the load balancer or CDN. Enforce limits by IP and path, plus bot and DDoS protection. Application limits remain a second layer.
- Size `DATABASE_POOL_MAX` so `(replica count × pool max) + operational connections` remains below the database limit. The realtime listener consumes one connection per replica.
- Alert on 5xx rate, p95/p99 latency, database saturation, pool wait time, WebSocket disconnect rate, failed logins, rate-limit responses, and migration failures.
- Back up PostgreSQL and object storage separately. Test point-in-time restoration and full restore before launch and at least quarterly.

## Scaling

Autoscale on concurrent requests, latency, and CPU—not CPU alone. Start with two replicas and a pool of 10 per replica, then tune from measured load tests. The atomic outlet counter prevents order-number contention. Workspace reads are bounded, and realtime events replace aggressive polling.

## Release gate

Run syntax checks, unit/integration tests, dependency audit, frontend lint/build, migration verification, tenant-isolation tests, and load tests in CI. Use a staging database with production-like volumes for query-plan and concurrency validation.
