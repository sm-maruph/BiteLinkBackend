# Backend boundaries

HTTP handlers only parse input, call a service, and translate results to HTTP.
Services own workflows and transactions. Repositories own SQL. Provider adapters
own vendor-specific APIs.

## Module map

```text
modules/
  auth/             credentials, sessions, password reset, invitations
  tenants/          provisioning, memberships, entitlements
  restaurants/      profiles, themes, outlets
  menu/             categories, items, modifiers, offers
  tables/           QR identity, guest table sessions
  orders/           placement, snapshots, kitchen workflow
  payments/         manual records, future gateway adapters
  requests/         waiter, bill, water, assistance
  storage/          Supabase and local/file-server providers
  subscriptions/    plans, subscriptions, provider webhooks
  analytics/        read models and scheduled aggregates
  audit/            append-only security and business events
```

Cross-module calls use exported services, never another module's route handler.

## Portability

Application data uses provider-neutral PostgreSQL. Supabase-specific file code
is isolated in `supabase-storage.js`. A production file server implements the
same `put` and `remove` methods. Database rows store object URLs/keys, never
Supabase client objects.
