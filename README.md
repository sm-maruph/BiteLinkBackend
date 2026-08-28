# BiteLink Backend

BiteLink's backend is the only trusted application layer. Supabase currently
hosts PostgreSQL and object files; it does not own business logic or user
authentication, and the browser never receives database or storage-admin keys.

## Architecture

```text
Frontend -> REST API -> feature service -> repository -> PostgreSQL
                              |
                              +-> storage interface -> Supabase Storage (now)
                                                   -> local/file server (later)
```

Feature modules live under `src/modules`. A module owns its schemas, routes,
service functions, and repository functions. Shared database transactions,
configuration, validation, logging, and errors stay at `src/`.

Implemented foundations include BiteLink authentication, tenant-aware RLS,
public catalog, menu operations, transactional orders, and provider-based file
storage. Payments remain provider-neutral until a gateway is selected.

## Database setup

Run the frontend database migrations as complete files in order:

1. `001_initial_schema.sql`
2. `002_security_and_rbac.sql`
3. `003_api_runtime_roles.sql`
4. `004_manual_auth_and_sessions.sql`

Migration 003 creates restricted roles assumed inside requests. The connection
URL belongs only in `Backend/.env`; never put it in a `VITE_*` variable.

## Environment

Copy `.env.example` to `.env`. Generate independent random values for
`ACCESS_TOKEN_SECRET` and `BOOTSTRAP_TOKEN`, each at least 32 characters.

For Supabase Storage configure `STORAGE_PROVIDER=supabase`, bucket
`BiteLinkQR`, `SUPABASE_URL`, and a rotated `SUPABASE_SERVICE_ROLE_KEY`.
The service-role key is server-only.

## First owner

The one-time `POST /api/auth/bootstrap` endpoint creates the first BiteLink
user, password credential, tenant, owner role, restaurant, profile, published
theme, and outlet atomically. Send `X-Bootstrap-Token`. Once a tenant exists,
the endpoint refuses further use.

Authentication endpoints:

- `POST /api/auth/bootstrap`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`

Passwords use Argon2id. Refresh tokens use an HTTP-only same-site cookie and
rotate after every use. Access tokens are short-lived and sent as
`Authorization: Bearer ...`; tenant APIs also require `X-Tenant-Id`.

## Development

```powershell
npm.cmd install
npm.cmd run dev
```

The frontend dev server proxies `/api` to `http://127.0.0.1:4000`.

## Production rules

- Set `COOKIE_SECURE=true` and use HTTPS.
- Rotate database, storage, JWT, and bootstrap secrets independently.
- Back up PostgreSQL and object files separately.
- Run migrations through CI with a dedicated migration identity.
- Add email and payment providers through adapters, not vendor calls in routes.
