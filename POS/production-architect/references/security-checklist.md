# Security pass

Walk this during the security section of a Tier 3 design, and before shipping anything
that touches money, personal data, or authentication. For each area, state what you did —
"N/A because X" is a valid and useful answer; silence is not.

## Threat-model first, briefly

Before the checklist, answer four questions in a few lines each. They determine which of
the items below actually matter for this system.

1. **What's worth stealing here?** Card data, personal data, business intelligence,
   compute for crypto mining, the ability to issue refunds.
2. **Who might want it?** Opportunistic scanners hitting every host on the internet, a
   disgruntled insider, a competitor, a targeted attacker. Most systems face the first
   two; design for those and don't pretend you're defending against a nation-state.
3. **Where does trust change hands?** Every boundary — browser→API, API→database,
   API→third party, webhook→API — is a place to validate.
4. **What's the worst single-request outcome?** If one crafted request can drain an
   account or dump the user table, that path gets the most attention.

## Authentication

- Passwords hashed with argon2id or bcrypt (cost ≥ 12). Never MD5, SHA-*, or homegrown.
- Minimum length ≥ 12, checked against a breached-password list. No forced rotation and
  no composition rules — both push users toward weaker, more predictable passwords.
- Rate limit and progressively delay login, registration, password reset, and MFA
  verification. Lock or challenge after repeated failures per account *and* per IP.
- Identical response and timing for "unknown user" and "wrong password" — otherwise the
  endpoint is a user enumeration oracle. Same for password reset and signup.
- Reset tokens: single-use, ≤ 1 hour, invalidated on use and on password change, and
  every existing session revoked when the password changes.
- MFA (TOTP at minimum) for admin and any role that can move money.
- Sessions: revocable server-side. A logout that only clears a client-side token is not a
  logout.

## Authorization

- Enforced server-side on every endpoint, in one layer. A hidden UI button is not access
  control.
- Default deny. New endpoints require an explicit permission, so forgetting to annotate
  one fails closed rather than opening it to everyone.
- **Check object ownership, not just object existence.** IDOR — `/orders/12345` returning
  someone else's order because the handler checked "logged in" but not "yours" — is the
  single most common real-world API vulnerability. Scope every query by tenant/owner in
  the repository layer, so it can't be forgotten in a handler.
- Tenancy boundary enforced at the data-access layer, not per-query in business logic.
- Privilege escalation: a user must not be able to grant themselves a role, edit their own
  permissions, or change another user's role without an explicit permission for it.
- Test the negative cases. An integration test that asserts user A gets 403 or 404 on
  user B's resource is worth more than most of your unit tests.

## Input handling

- Validate everything crossing a boundary against a schema (Zod, Pydantic) — body, query,
  params, headers, webhook payloads. Reject unknown fields rather than ignoring them, so
  mass-assignment can't set `isAdmin`.
- Parameterized queries or ORM only. String-concatenated SQL is never acceptable, not even
  for an internal admin tool.
- Bound everything: max body size, max array length, max string length, max page size,
  max upload size, max import rows. Unbounded input is a denial-of-service primitive.
- File uploads: allowlist content types, verify magic bytes, generate your own filename
  (never trust the client's — path traversal), store outside the web root, serve from a
  separate domain or via signed URLs.
- Output encoding for HTML contexts; React escapes by default, so treat any
  `dangerouslySetInnerHTML` as requiring sanitization and a comment explaining why.
- Server-side request forgery: if the app fetches a user-supplied URL, allowlist the
  destination and block private/link-local ranges including redirect targets.

## Data protection

- TLS everywhere, HSTS on, HTTP redirected to HTTPS.
- Encryption at rest for database and backups (managed providers give this; confirm it).
- Classify fields. Encrypt or tokenize the sensitive ones at the application layer where
  database-level encryption isn't enough.
- **Never store raw card data.** Use a processor's hosted fields or tokenization so card
  data never touches your servers — this is the difference between a short SAQ-A
  questionnaire and a full PCI-DSS audit.
- Redact secrets, tokens, card numbers, and passwords from logs and error reports. Add a
  redaction filter to the logger rather than relying on discipline at every call site.
- Have a stated retention policy and a working deletion path (GDPR/CCPA erasure). "We
  never delete anything" is a liability, not a feature.

## Application security

- Security headers: CSP (no `unsafe-inline` — use nonces), `X-Content-Type-Options:
  nosniff`, `Referrer-Policy`, `X-Frame-Options`/`frame-ancestors`, `Permissions-Policy`.
- CORS: explicit origin allowlist. `Access-Control-Allow-Origin: *` with credentials is
  the classic misconfiguration.
- CSRF protection on cookie-authenticated state-changing requests: SameSite=Lax/Strict
  plus a token for anything sensitive.
- Rate limiting globally and per-endpoint, with tighter limits on auth and expensive
  operations.
- Verify webhook signatures with a constant-time comparison, and reject stale timestamps
  to prevent replay.
- No secrets in the client bundle. Anything in `NEXT_PUBLIC_*` is public — treat it as
  printed on a billboard.
- Dependencies: lockfile committed, automated vulnerability scanning in CI, a stated
  cadence for applying updates. Most breaches come through known-vulnerable dependencies,
  not novel exploits.

## Operations

- Secrets from a manager, never in source. If one has ever been committed, rotate it —
  git history is forever.
- Least-privilege database credentials. The application user does not need DDL rights in
  production.
- Audit log for security events — login success and failure, permission changes, data
  exports, refunds, deletions — recording actor, action, target, timestamp, and IP. Store
  it append-only where it matters.
- Alert on: spikes in 401/403, unusual export volume, repeated failed logins, new admin
  role grants.
- Backups tested by actually restoring, on a schedule. An untested backup is a hypothesis.
- A written incident response note: who is called, how you revoke sessions and rotate
  secrets, how you notify affected users. Two paragraphs beats nothing at 3am.

## Before shipping

Run a dependency audit, confirm no secrets in the repo (`gitleaks` or equivalent in CI),
verify security headers on the deployed URL, and manually attempt one IDOR and one
privilege-escalation against a staging account. Those two manual checks catch more real
issues than any scanner.
