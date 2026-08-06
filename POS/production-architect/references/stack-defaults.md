# Stack defaults and when to deviate

Read this when the user questions a default, when the context pushes against one, or when
you need to justify a choice in the "Technology stack" section.

## Contents

- Backend framework
- API style
- Authentication and authorization
- Frontend
- Datastore
- Background jobs and scheduling
- File storage
- Caching
- Observability
- Hosting and CI/CD
- Cost posture

---

## Backend framework

**Default: NestJS (TypeScript).** Opinionated module/provider structure means five
developers produce a codebase that looks like one developer wrote it — which is the whole
game on a multi-year project. DI makes services testable without HTTP. Shared types with
a TypeScript frontend eliminate a class of integration bugs entirely.

**Default alternative: FastAPI (Python).** Choose it when the work is data-heavy,
ML-adjacent, or the team is Python-native. Pydantic gives validation and OpenAPI from the
same declaration. Weaker structural conventions than NestJS, so agree on a layout early.

Deviate when: the team has deep expertise elsewhere (Django, Rails, Spring, .NET) — team
familiarity beats framework elegance for maintainability; or the workload is genuinely
serverless-event-driven, where a thinner handler suits better.

Avoid: bare Express with no structure. It scales to about one developer and one quarter.

## API style

**Default: REST + OpenAPI generated from code.** Hand-maintained API docs are wrong
within two sprints. Generate the spec from decorators/models, publish it, and generate the
frontend client from it.

Conventions worth fixing early: plural nouns for collections; cursor pagination (offset
pagination breaks under concurrent writes); a single error envelope
(`{error: {code, message, details, requestId}}`) so the frontend has one thing to handle;
version in the URL path (`/api/v1`) — cheap now, impossible to retrofit.

Consider GraphQL only when many clients have genuinely divergent data needs. It moves
complexity from the client to the server (n+1 queries, query cost limiting, caching) —
worth it sometimes, rarely worth it at the start.

## Authentication and authorization

**Default: short-lived JWT access token (15 min) + rotating refresh token (httpOnly,
secure, SameSite cookie).** Access token is stateless and cheap to verify; refresh token
is stored server-side so it can be revoked. Storing access tokens in `localStorage` makes
any XSS a full account takeover — use memory + httpOnly cookie for the refresh.

**RBAC:** roles → permissions → enforcement at one layer (a guard/dependency), not
scattered through handlers. Scattered checks are how endpoints get missed. Model
permissions as strings (`orders:refund`) rather than hardcoding role names in logic, so
new roles don't require code changes.

Consider a managed identity provider (Auth0, Clerk, Cognito, Keycloak) when you need SSO,
SAML, MFA, or social login. Rolling those yourself is a multi-month project with a
security tail. Trade-off: per-MAU cost and vendor coupling at the session layer.

## Frontend

**Default: Next.js App Router + TypeScript strict + Tailwind.** Server components reduce
client bundle; file-based routing is one less thing to invent; strict mode catches the
null-handling bugs that surface in production.

State: server state via TanStack Query (caching, retries, invalidation are solved
problems); client state via built-in hooks or Zustand. Reach for Redux only when you
actually have complex shared client state — most apps don't.

Every screen needs four states designed, not three: loading, empty, error, and success.
Empty and error states are what prototypes skip and users hit first.

Deviate when: the app is a content site (plain React/Vite or Astro is lighter), or the
team has no React experience.

## Datastore

**Default: PostgreSQL.** Transactions, foreign keys, JSONB when you need schema
flexibility, mature replication and PITR, good managed options everywhere. Constraints in
the database are the last line of defence when application code has a bug — and it will.

**SQLite is a legitimate production choice** for single-node, low-concurrency
deployments, embedded/desktop apps, and edge cases like a single-till POS. Say so
explicitly when you choose it, and name the migration trigger (multiple writers, multiple
nodes, or the need for real backups without file-level snapshots).

**Never a spreadsheet as system of record.** See `excel-integration.md`.

MongoDB when documents are genuinely schemaless and relationships are rare — which is
less often than people assume. If you find yourself doing joins in application code, you
wanted Postgres.

ORM: Prisma (TS) or SQLAlchemy (Python). Both keep migrations versioned in the repo. Drop
to raw SQL for complex reporting queries; ORMs generate poor SQL for aggregations, and
that's fine — use both.

## Background jobs and scheduling

Anything slower than ~200ms that isn't needed for the response belongs in a queue: email,
PDF generation, imports, third-party sync. BullMQ (Redis) for Node, Celery or ARQ for
Python, or Postgres-backed (pg-boss, `SELECT ... FOR UPDATE SKIP LOCKED`) if you'd rather
not run Redis for a low volume.

Jobs must be idempotent — they will be retried. Give each a max attempt count and a dead
letter queue you actually alert on; a silent DLQ is a data-loss generator.

## File storage

S3-compatible object storage (S3, R2, Spaces), never the application filesystem — local
files don't survive redeploys or horizontal scaling. Upload direct from the client via
presigned URLs so files don't transit your API. Validate content type by magic bytes, not
by the extension the client claims.

## Caching

Add it when you have measured a problem, not before. Order of preference: correct indexes
first, then HTTP caching headers, then Redis for computed results. Every cache introduces
an invalidation bug; pay that cost only for a demonstrated win, and always set a TTL.

## Observability

Structured JSON logs with a correlation/request ID threaded through every layer. Metrics
for the four signals that predict user pain: latency (p50/p95/p99), traffic, error rate,
saturation. Error tracking (Sentry or equivalent) from day one — it costs nothing at low
volume and turns "a user said it broke" into a stack trace.

Alert on symptoms users feel (error rate, latency, queue depth), not on causes (CPU). An
alert nobody acts on gets muted, and a muted alert is worse than none.

Health endpoints: `/health/live` (process up) and `/health/ready` (dependencies
reachable) — orchestrators need both and they mean different things.

## Hosting and CI/CD

Small/medium: managed platform (Railway, Render, Fly.io, App Runner) + managed Postgres.
The premium over raw VMs is far less than the engineer-hours of running your own.

Larger or compliance-bound: ECS/Fargate or Kubernetes. Kubernetes is a reasonable choice
only when someone owns it — it is a full-time platform commitment, not a deploy target.

Pipeline: lint → typecheck → unit → integration (containerized DB) → build image → deploy
to staging → smoke test → manual gate → production. Migrations run as a separate step
before the new version starts, and must be backward-compatible with the previous version
so rollback works. Expand-then-contract: add the column, deploy code that writes both,
backfill, then drop the old column in a later release.

Secrets from a manager (AWS Secrets Manager, Doppler, platform env vars), validated at
startup so a missing one fails at boot.

## Cost posture

Default to managed services early — engineer time is the expensive resource at small
scale. Revisit when the bill is a meaningful fraction of a salary; that's the honest
threshold for bringing something in-house. State the rough monthly cost of your
recommended stack so the user can make a real decision instead of discovering it later.
