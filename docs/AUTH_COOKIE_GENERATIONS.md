# Claire auth cookie generations — serverless response-order protection

## Problem and limits of the browser-only lock

The existing `public/index.html` serializes cooperating same-origin tabs with
`navigator.locks` and a random, nonsecret localStorage marker. This prevents
many client-side races, but *cannot undo an HttpOnly `Set-Cookie` that the browser
accepted from an earlier response delivered late*. Concurrent `Set-Cookie`
responses using the same cookie name are explicitly a race in RFC 6265.

A credential request has separate UI and header-transport lifetimes. The UI
can leave its waiting state at the deadline while retaining an unconfirmed
login/logout marker. If a transport ignores cancellation before response headers,
the cooperating-tab lock remains held until that transport settles, because a
late `Set-Cookie` can still arrive. Body processing is bounded once headers arrive.
This lock does not block independent read-only controls; a timeout never claims
that the provider revoked or did not create a session.

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
  named `aleph_auth_g_<base36-generation>`. It contains the refresh token and a
  v2 HMAC-SHA256 authentication tag derived with domain separation from the
  server-only Supabase secret key. The signed issue time is captured before the
  allocator and provider work. Credential acceptance expires seven days from
  that reservation, regardless of when the browser receives the response. The
  write capability is private to its handler; no generation or issue time is
  trusted from browser input.
- Explicit logout writes an independently named, *signed tombstone* at a
  newer globally allocated generation. A late old login or refresh cookie
  cannot overwrite it; subsequent authentication selects the greatest
  **validly signed** generation and rejects a tombstone.
- A **confirmed invalid signed refresh** only replaces the generation of the
  *input cookie*, retaining its signed issue time, with a signed tombstone, rather than claiming a fresh global
  logout generation. Another concurrent refresh may have succeeded with a
  newer generation; invalidating that unrelated, valid result would be a false
  logout. Legacy-only cookies do not enter the enforce-mode refresh path.
- Invalid/duplicate generation cookies fail closed as `NO_SESSION`. Explicit
  login can remove **bounded, syntactically safe cookie names** even if an
  invalid entry appears before valid ones or the incoming header exceeds the
  authentication limit of 16,000 ASCII bytes (15.625 KiB). Name-only recovery
  scans at most 65,536 ASCII bytes (64 KiB) and collects at most 32 names.
  The large header is **never authenticated**; browsers/proxies may reject
  headers before the handler, in which case manual cookie cleanup may be needed.
- Existing clients still send `/api/auth/{login,session,logout}` with the same
  JSON payload and receive the same status/body. In enforce mode, bare
  `aleph_refresh` and the old v1 signed format require explicit login. A new
  successful login clears observed old slots and the raw legacy cookie. Enforce
  mode never emits a raw legacy refresh credential or falls back to one when
  signed cookies disappear. The explicit `legacy` rollback mode remains separate.
- Cookie scope stays `HttpOnly; SameSite=Strict; Path=/api/auth` and `Secure` in
  production; `no-store`/`nosniff`/`no-referrer` remain. Ordering cookies use an
  eight-day browser retention period; signed credential acceptance lasts seven
  days. Existing client-side localStorage remains free of refresh tokens.

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
- Every signed slot, including tombstones and expired credentials, retains
  ordering evidence for eight days from browser receipt. Credential acceptance
  is bounded independently by its authenticated seven-day reservation window.
  The greatest signed generation is selected first; an expired or revoked winner
  never falls back to an older credential. Browser delivery delay therefore
  cannot renew the old credential's acceptance window after a newer slot expires.
- The supported server clock skew is at most 30 seconds; the extra retention day
  covers this margin. A credential issued more than 30 seconds in the verifier's
  future is rejected. Publication also checks wall time against elapsed monotonic
  time, rejecting an expired reservation or a large clock discontinuity. Arbitrary
  clock corruption, deliberate removal/eviction of only the newest cookie, and
  provider-wide revocation are outside this response-order guarantee. No new DB
  reservation protocol or deployment is implied; the existing sequence RPC is
  unchanged.
- The server cleans observed versioned names without emitting duplicate
  `Set-Cookie` names in a response. Browser/proxy header limits still apply, and
  name cleanup cannot repair a request rejected upstream as oversized.
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
5. Deploy the v2 verifier across live auth workers together and require explicit
   login for old cookies. Avoid mixing v1 and v2 workers or silently enabling a
   legacy fallback. This repository change does not deploy those workers.
6. Run root `npm test`, client tests, and the actual Chrome CookieJar smoke test.
   Test synthetic delayed login, logout, simultaneous success/failure refresh,
   recovery from bounded stale cookie accumulation, invalid signatures,
   allocator outage cleanup, concurrent worker allocations, and existing client
   JSON/status shapes. The expiry-aware fixture additionally ages cookies by
   receipt time and checks delayed login/refresh, signed-time tampering, stale
   protocol rejection, expired reservations, and bounded cross-worker skew.
7. Track 503 `AUTH_GENERATION_UNAVAILABLE`, cookie header size, and unexpected
   `NO_SESSION` rates **without logging any cookie or secret value**. During
   rollback explicitly plan client logout/relogin instead of assuming an old
   client accepts signed generations.

## Reproduce locally without contacting Supabase

```bash
npm ci --ignore-scripts
node --test test/auth-cookie-generation.test.mjs test/auth-cookie-generation-pure.test.mjs test/auth-cookie-expiry.test.mjs
npm test
node scripts/auth-cookie-browser-smoke.mjs
```

The browser fixture runs against a loopback HTTP server with *synthetic* emails,
refresh tokens and a fake globally ordered allocator. It exercises a real
Chromium CookieJar and response delays. It does **not** use student credentials
or change the production database, and is not a penetration test.

Cookie receipt-time expiry semantics: [RFC 6265, section 5.2.2](https://www.rfc-editor.org/rfc/rfc6265.html#section-5.2.2). The browser expiry model is tested separately from the signed server acceptance deadline.
