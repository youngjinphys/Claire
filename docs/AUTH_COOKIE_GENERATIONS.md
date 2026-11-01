# Claire auth cookie generations — serverless response-order protection

## Problem and limits of the browser-only lock

The existing `public/index.html` serializes cooperating same-origin tabs with
`navigator.locks` and a random, nonsecret localStorage marker. This prevents
many client-side races, but *cannot undo an HttpOnly `Set-Cookie` that the browser
accepted from an earlier response delivered late*. Concurrent `Set-Cookie`
responses using the same cookie name are explicitly a race in RFC 6265.

## Design

- `api/auth.js` retains the existing JSON response shapes, HTTP error contract,
  routes, Origin/Fetch Metadata checks, rate guard, and Supabase client-per-request.
- Production mode (`NODE_ENV=production`) defaults to enforcing server-side
  generations. `AUTH_COOKIE_GENERATION_MODE=enforce` explicitly enables on a
  nonproduction test environment. `AUTH_COOKIE_GENERATION_MODE=legacy` is an
  **emergency compatibility rollback**, and restores the old race exposure.
- The private SQL RPC `s12_auth_cookie_generation_next()` uses PostgreSQL
  `nextval`, which atomically allocates increasing numbers across all Vercel
  workers. A generation is reserved **before** contacting the provider so late
  completion cannot claim a newer cookie slot. The DB stores only a global
  sequence, never identities, IP addresses, access/refresh tokens, or passwords.
- Each successful login/session rotation writes an independent HttpOnly cookie
  named `aleph_auth_g_<base36-generation>`. It contains the refresh token and an
  HMAC-SHA256 authentication tag derived with domain separation from the
  server-only Supabase secret key. No generation is trusted from browser input.
- Explicit logout writes an independently named, *signed tombstone* at a
  newer globally allocated generation. A late old login or refresh cookie
  cannot overwrite it; subsequent authentication selects the greatest
  **validly signed** generation and rejects a tombstone.
- A **confirmed invalid signed refresh** only replaces the generation of the
  *input cookie* with a signed tombstone, rather than claiming a fresh global
  logout generation. Another concurrent refresh may have succeeded with a
  newer generation; invalidating that unrelated, valid result would be a false
  logout. A legacy-only invalid refresh still uses a newly allocated generation.
- Invalid/duplicate generation cookies fail closed as `NO_SESSION`. Explicit
  login can remove **bounded, syntactically safe cookie names** even if an
  invalid entry appears before valid ones or the incoming header exceeds the
  16 KiB authentication limit (bounded recovery scan: 64 KiB / 32 names).
  The large header is **never authenticated**; browsers/proxies may reject
  headers before the handler, in which case manual cookie cleanup may be needed.
- Existing clients still send `/api/auth/{login,session,logout}` with the same
  JSON payload and receive the same status/body. The old `aleph_refresh` cookie
  is issued/cleared alongside the new cookies for migration. If any signed
  generation cookies are present, they **always take precedence** over the
  legacy cookie. Thus an old response may overwrite the legacy cookie, but
  cannot change which refresh token the new server accepts.
- Cookie scope stays `HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age<=604800`
  and `Secure` in production; `no-store`/`nosniff`/`no-referrer` remain. Existing
  client-side localStorage remains free of refresh tokens.

### Security and operational caveats

- This is *response-order* protection, not a promise of a global order of user
  intentions across arbitrary uncoordinated clients. The authoritative order is
  the DB admission sequence; existing cooperating browsers additionally serialize
  intentional auth operations. Requests whose DB claims themselves arrive out of
  order are ordered by claim acquisition, not the user's click timestamp.
- A valid old token deliberately replayed in a **different** browser without the
  newer cookie cannot be retroactively revoked by response-order protection.
  Supabase session revocation remains a separate provider control.
- If the signing key is rotated, previously signed cookies fail closed. Before
  changing `SUPABASE_SECRET_KEY`, plan for explicit reauthentication of clients.
- A missing RPC, missing secret or database outage under `enforce`/production
  yields HTTP 503 (`AUTH_GENERATION_UNAVAILABLE`) **without** silently
  falling back to legacy refresh behavior. If parsing succeeded but the
  allocator fails during explicit logout, the server best-effort clears
  **all observed versioned and legacy cookie names**, not just the legacy name,
  and returns 503. No signed, higher tombstone can be created without the
  allocator, so an older response may reintroduce a cookie; the browser must
  remain locked until explicit reauthentication. This is not confirmed remote
  revocation.
- Generations and tombstones share a 7-day TTL, matching the legacy refresh
  cookie's maximum age. The server cleans observed versioned names, without
  emitting duplicate `Set-Cookie` names in a response. Delayed responses may
  reintroduce old slots, but those remain below newer signed generations.
  Browser cookie limits and malformed/duplicate slots cause fail-closed
  behavior, **not** an invented secure session. Name cleanup is bounded and
  cannot repair an HTTP request rejected upstream as oversized.
- Keep this migration and its RPC deployed across all live auth functions before
  enabling `enforce`. A rollback to the old server code loses versioned-cookie
  verification; use a planned reauthentication transition rather than silently
  rolling back.

## Deployment order

1. Confirm the intended Supabase project and back up deployment configuration.
2. Apply `supabase/step12_auth_cookie_generation.sql` to that existing project.
   It is additive and grants execution/sequence usage only to `service_role`.
3. Verify RPC **permission** and sequential string results using an authorized
   server-side service-role context; do **not** call it from a browser or anon key.
4. Ship API implementation. `NODE_ENV=production` enables enforcement by default
   only once this migration exists. Do not deploy ahead of step 2. In a staging
   environment use `AUTH_COOKIE_GENERATION_MODE=enforce` to validate first.
5. Run root `npm test`, client tests, and the actual Chrome CookieJar smoke test.
   Test synthetic delayed login, logout, simultaneous success/failure refresh,
   recovery from bounded stale cookie accumulation, invalid signatures,
   allocator outage cleanup, concurrent worker allocations, and existing client
   JSON/status shapes.
6. Track 503 `AUTH_GENERATION_UNAVAILABLE`, cookie header size, and unexpected
   `NO_SESSION` rates **without logging any cookie or secret value**. During
   rollback explicitly plan client logout/relogin instead of assuming an old
   client accepts signed generations.

## Reproduce locally without contacting Supabase

```bash
npm ci --ignore-scripts
node --test test/auth-cookie-generation.test.mjs test/auth-cookie-generation-pure.test.mjs
npm test
node scripts/auth-cookie-browser-smoke.mjs
```

The browser fixture runs against a loopback HTTP server with *synthetic* emails,
refresh tokens and a fake globally ordered allocator. It exercises a real
Chromium CookieJar and response delays. It does **not** use student credentials
or change the production database, and is not a penetration test.
