# Supabase database connection diagnosis

Audience: BiteLink backend developer  
Date: 26 August 2026

## Finding

The configured PostgreSQL URL is syntactically valid, but its direct database
hostname has an IPv6 (`AAAA`) record and no IPv4 (`A`) record. The local Node.js
process therefore fails during DNS/address resolution before PostgreSQL can
authenticate. This does not indicate a wrong password or failed migration.

Supabase documents that `db.PROJECT_REF.supabase.co:5432` is IPv6 by default.
For a persistent backend on an IPv4-only network, Supabase recommends the Shared
Pooler in **session mode**, using its pooler hostname and port `5432`.

Source: [Connect to your database — Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres)

## Resolution

1. Open the Supabase project dashboard.
2. Select **Connect**.
3. Choose **Session pooler**.
4. Copy the complete URI; do not construct or guess the regional pooler hostname.
5. URL-encode special characters in the rotated password if the copied URI still
   contains a password placeholder.
6. Replace only `DATABASE_URL` in `Backend/.env`.
7. Run `npm.cmd run db:check` again.

The session-pooler username includes the project reference, typically resembling
`postgres.PROJECT_REF`, and its host resembles an AWS regional Supabase pooler.
The direct hostname should no longer appear in `DATABASE_URL`.

Supabase documents session mode on port `5432` and transaction mode on port
`6543`. Session mode is the appropriate development choice here because BiteLink
is a persistent Node backend and uses transaction-local PostgreSQL security
context. [Supavisor FAQ — Supabase](https://supabase.com/docs/guides/troubleshooting/supavisor-faq-YyP5tI)

## Alternative

An IPv4 add-on makes the direct project endpoint reachable over IPv4. It is not
needed for local development when the Shared Pooler is acceptable.

Source: [IPv4 add-on FAQ — Supabase](https://supabase.com/docs/guides/troubleshooting/enabling-ipv4-addon)

## Verification criteria

`npm.cmd run db:check` must report:

- `connected: true`
- `ready: true`
- all required relations present
- both runtime roles present
- the connection user can assume both runtime roles

If connectivity succeeds but `ready` is false, the remaining problem is a
migration or role-grant issue rather than networking.
