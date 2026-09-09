# Platform control center

The authenticated `/super-admin` portal provides account growth and operational health analytics, API request/error/latency analytics, restaurant and outlet approval queues, restaurant/outlet lifecycle controls, subscription renewals and plan selection, an administrator activity log, subscription invoices/payment review, notifications, incidents, and client tickets/messages. All `/api/platform` endpoints require an active platform administrator.

## Release

1. Apply `BiteLinkQR/database/migrations/019_platform_control.sql` and then `020_platform_operations.sql` once, using the database owner connection, before releasing the backend. It is also registered in `npm run db:migrate-features`.
2. Deploy the Backend service.
3. Build and deploy BiteLinkQR with its production API origin.
4. Sign in as the platform administrator and open `/super-admin`.

The migration has been integration-tested inside a transaction that is rolled back. Running tests does not install the migration or change customer accounts. The release migration adds metrics/audit tables, a subscription access function, and a database trigger that blocks new orders for offline outlets. Apply it during the release window: the trigger also enforces access for the old backend immediately.

## Access and approvals

Subscriptions belong to a tenant account and cover every outlet in that account. An outlet is online only when its status and its restaurant status are active, its tenant is active/trialing, and an active/trialing subscription covers the current time. Trials use the earlier of the trial end and billing period end. There is no grace period for past-due, paused, cancelled, expired, or missing subscriptions.

Expiry is checked on every customer menu request and at database insertion of every order, so it needs no scheduled job and is not bypassed by a browser with a previously loaded menu. Stored outlet status remains unchanged; the portal shows effective online/offline access and the reason. Renewal restores access only to outlets/restaurants that were not manually paused or closed. Existing order tracking and settlement and owner workspace access remain available.

New registrations and additional restaurant requests use draft restaurant status. Existing restaurants retain their status. Approve or reject them in Restaurant requests. Additional outlets retain the existing setup approval workflow. Every platform status change and subscription edit requires a reason and writes an atomic audit record.

## Billing and metrics definitions

Subscription management supports plan selection, status, billing interval, and exact expiry. Enter a reason/payment reference after independently confirming payment. No payment processor or automatic charging is configured. MRR is an estimate based on active monthly and annual plan prices; trials and custom billing are excluded. The platform overview does not query or display restaurant sales or orders.

API charts show the last 24 hours of instrumented HTTP requests, 4xx/5xx counts and average server latency. Collection starts when this backend runs. Only route templates, method, status, aggregated counts and durations are stored; request bodies, tokens, emails, and raw parameter values are not recorded. Buckets are retained for 30 days and pruned hourly. WebSocket message traffic is not included.

The UI lists up to 1,000 restaurants/outlets/subscriptions, 100 API route groups and 200 recent audit entries. Search filters those loaded records. Analytics dates use Asia/Dhaka. Expiry editing uses the administrator device time, then sends an absolute timestamp.

## Verification

`npm test` in Backend includes transaction-isolated integration coverage for platform permission checks, list/analytics queries, approval mutations, expiry blocking (including the order database trigger), renewal, invalid renewal dates, trial expiry, cancellation, manual pause preservation, metrics and audit records. Frontend validation: `npm run build` and `npm run lint`.


## Client operations

The platform Payments screen tracks BiteLink subscription invoices, balances, overdue invoices, submitted payment references, and confirmation/rejection. This is a manual billing ledger, not a payment gateway: it does not charge clients or independently verify bank transfers. Confirm a payment only after checking your payment account. Confirming sufficient payments settles the invoice; subscription expiry changes remain an explicit operation in Subscriptions. Invoices with submitted or confirmed payments cannot be voided. Payment review locks the invoice to prevent concurrent approvals from overpaying it.

Notifications support targeted accounts or all clients, editable drafts, explicit sending, archiving, and per-user read state. Invoice reminders are drafted from an invoice. Send due renewal alerts generates in-app alerts for subscriptions due within seven days or overdue, with a unique key per subscription expiry to prevent duplicate sends. This is administrator-triggered; no scheduler, email, SMS, or push provider is configured.

Incidents support global/account-specific scope, minor/major/critical severity, internal-only or client-visible publication, and a timestamped update history through investigating, identified, monitoring, and resolved.

Help Center now embeds Tickets, Messages, Notifications, Incidents, and (for members with tenant.manage) Payments. Clients can create tickets/conversations, see platform replies, and submit follow-up messages. A client follow-up reopens resolved/closed tickets. Platform replies set waiting_client; administrators can set priority/status and post the solution in the thread. The open thread refreshes every 15 seconds. The restaurant dashboard checks unread notifications and waiting-client conversations every minute. Workspace members share their tenant's support conversations; billing data requires tenant.manage. Every request scopes client access by authenticated membership, never by a client-supplied tenant in the request body.

The new tables have RLS enabled with no direct runtime-role grants. Access is through backend routes using explicit tenant filters. API responses are capped at 200 operations records per list; account selectors load up to 1,000 accounts. Search filters loaded records. There are no attachments or outbound email delivery in this release.

`test/operations.test.js` verifies cross-tenant denial for tickets/messages/invoices, targeted notifications and read state, incident visibility, client/platform replies, invoice settlement, duplicate payment reference rejection, repeated review rejection, and paid-invoice void prevention. All fixture data and schema changes are rolled back.
