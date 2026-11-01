# Claire `main` 15-commit audit — 2026-11-01

## Scope and evidence

Reviewed the **15 commits ending at `1d8710b7c7ab15e11fa15b43cf568319758bc9fa`**, their changed-file patches, current auth implementation, the existing CI, and synthetic test contracts. The initial HEAD CI completed successfully (run [41288982583](https://github.com/youngjinphys/Claire/actions/runs/41288982583)). Passing fixtures is **not** proof of live login behavior or full security certification.

Read-only verification against the existing Supabase project associated with the Claire defense app found `s12_auth_cookie_generation_seq` and `s12_auth_cookie_generation_next()` present. The RPC is `SECURITY INVOKER`; the sequence and RPC are not executable/usable by `anon` or `authenticated`, and the required `service_role` privileges exist. **No live RPC allocation, real credential sign-in, database mutation, deployment, or attack simulation was performed.** Production environment variables and the actual deployed version are separate verification steps.

## Per-commit assessment (newest first)

| # | Commit | Purpose | Audit verdict and caveat |
|---|---|---|---|
| 1 | [`1d8710b`](https://github.com/youngjinphys/Claire/commit/1d8710b7c7ab15e11fa15b43cf568319758bc9fa) | Server-side signed HttpOnly generation names, global SQL ordinal, logout tombstone | **Correct response-order principle, incomplete edge handling.** Found oversized/early-invalid cookie recovery failure, false logout from a rejected stale refresh, and incomplete local cookie cleanup on allocator failure. Addressed with new bounded cleanup and input-generation invalidation tests. |
| 2 | [`686f585`](https://github.com/youngjinphys/Claire/commit/686f5856ed7ce94674f9f1fe82a9dce87a5bb574) | Authentication/browser coordination, device/notes race protection, UI failure boundaries | Per-request Supabase client and fail-closed uncertain states are defensible. Browser storage locks cannot alone order HttpOnly response arrivals; original README assertion is outdated after #1 and corrected. End-to-end real WebAuthn/provider behavior remains unverified. |
| 3 | [`358cc98`](https://github.com/youngjinphys/Claire/commit/358cc980b43081647588a7549b49058d8f2efbe6) | Narrow-view navigation CSS and QA | Appropriate viewport-specific correction; not a security fix. |
| 4 | [`a165ec6`](https://github.com/youngjinphys/Claire/commit/a165ec6e48f7029382c2cc00ede20959c1e86915) | Composited animation and table/render tuning | DOM-change reduction is plausible; “GPU optimization” is **not established as universally faster** without device-specific frame-time/memory measurements. Keep accessibility/reduced-motion behavior. |
| 5 | [`f1cdb9d`](https://github.com/youngjinphys/Claire/commit/f1cdb9d0b747aa22636a98f2aa738e5cf561c8cd) | Observatory time/source checks and manual recovery | Risk-reducing correctness work, but unrelated to auth cookie response order. |
| 6 | [`4862757`](https://github.com/youngjinphys/Claire/commit/486275713811a6a641ae606c871fa75a148bdc9c) | UFW unprivileged errors and dashboard UI | Non-root/read-only direction is sound. Parsing permission denials from tool stderr is heuristic; a generic error must remain “unavailable,” never inferred “firewall safe.” |
| 7 | [`73ac0c1`](https://github.com/youngjinphys/Claire/commit/73ac0c183cd80d7c770c7de3f4f88bf7dfcd80cf) | Partial Windows/macOS/Linux host evidence and QA | Preserving partial failures instead of converting to zero is correct; Windows event counts are **not attack detections**. |
| 8 | [`6f05d27`](https://github.com/youngjinphys/Claire/commit/6f05d272882df4830c1e60beb47493fbdafd060e) | Single-server dashboard navigation, source attribution and browser layouts | Sound reuse of student collector, not two independent services. The reported CI verifies synthetic data and browser layout, not users’ machines. |
| 9 | [`ee454ff`](https://github.com/youngjinphys/Claire/commit/ee454ff439aea14e48ec9efce49bef7b2fa2bc0a) | UI animations, form attributes, render churn | Largely presentation; do not assume animation implies measured performance or complete accessibility. |
| 10 | [`87b8e05`](https://github.com/youngjinphys/Claire/commit/87b8e05d4d8625609bf5289357719a1242bc234c) | Unifies host-report and resource observatory | Reuse instead of independent sensors/server is a suitable architectural choice; explicit host report selection remains a useful permission/privacy boundary. |
| 11 | [`a9498db`](https://github.com/youngjinphys/Claire/commit/a9498dbdeaa957f6f95327a91366fa656e26f8bc) | Corrects a commit-specific changed-file manifest | Valid for the grading contract; cannot treat a manifest as a general release record. |
| 12 | [`e5f5f04`](https://github.com/youngjinphys/Claire/commit/e5f5f0481f477cb2efe737ad7b334fb77f1a6bac) | Manifest-only commit compatibility with exact Git diff | Narrow compatibility change, retained strict sorted-path/actual-diff equality. |
| 13 | [`b2c045d`](https://github.com/youngjinphys/Claire/commit/b2c045d28ff91b32e219c97ddac883b26d5368e7) | Static icon request handling | Limited routing correctness change; no general auth impact. |
| 14 | [`50d869e`](https://github.com/youngjinphys/Claire/commit/50d869eb77afaa8db6b608f8a8a8c8283528a60c) | Minimized host evidence export | Explicit user action and provenance are appropriate; the presence of internal IP/DNS data means exported files still require local privacy handling. |
| 15 | [`77d7451`](https://github.com/youngjinphys/Claire/commit/77d745134947e97c922d5ada32f8ebba564525d6) | Student host-card order, manual selection, failure labeling | Appropriate: avoids invented measurements and accidental OS writes. Does not authenticate manually imported files as originating on the same physical PC. |

These are **differentiated judgments**, not 15 claimed vulnerabilities. Display adjustments, evidence handling, packaging metadata, and browser-auth correctness have distinct risk profiles.

## Independently reproduced auth defects and selected remediation

1. **Bounded cookie-header recovery.** Each signed cookie name is unique, so many out-of-order responses can accumulate multiple valid cookies. If the header exceeds the existing 16 KiB *authentication* cap, the parser rejected the request but found no names to clear. An explicit login then wrote another cookie without removing the old ones. The fix keeps the authentication cap and fails closed, while allowing bounded, name-only cleanup (64 KiB maximum inspected, at most 32 safe names) on a deliberate new login. Very large requests can still be rejected upstream before app code; manual browser cookie cleanup may be required.
2. **False logout after competing refreshes.** A failed refresh of signed generation `g` previously allocated a new global tombstone `g+n`. A concurrent successful rotation might have published `g+1`, which then lost to that *unrelated failed refresh*. The fix marks **only input generation `g`** as invalid, while preserving newer legitimate rotations. Explicit logout retains its globally newer tombstone; legacy-only invalid refresh continues using the allocated generation. It also avoids sending two `Set-Cookie` fields with an identical name in one response.
3. **Allocator outage during logout.** On an allocation failure, only legacy `aleph_refresh` was deleted, leaving observed valid signed cookies in the browser. The fix best-effort clears all observed signed and legacy names while returning 503. It **cannot guarantee** protection against a delayed response that reintroduces an old signed cookie when the allocator is offline. Fail-closed client behavior and explicit reauthentication remain necessary.
4. **Stale explanatory text.** README still claimed that there was no server-side generation implementation. Updated the wording to describe the actual optional/production-enforced feature, exact compatibility boundaries, and remaining caveats.

## Risks not incorrectly treated as resolved

- Cookie eviction, browser/proxy header limits, malicious Domain cookie tossing and delayed responses during a total allocator outage are **not fully solved** by stateless, signed generations. A stronger guarantee against arbitrary delayed response delivery requires durable per-client session state, revocation control and deliberate migration. This patch does not invent such infrastructure or modify existing user data.
- A 7-day signed tombstone and a Supabase logout provider result do not prove that all already-issued access tokens ceased being usable immediately. Protected operations must still enforce their own authorization policy.
- An old browser client may still issue/receive legacy JSON/cookie shapes. Generation selection occurs server-side; the explicit `legacy` rollback mode remains race-prone.
- A successful synthetic Chrome CookieJar fixture or local unit suite does not prove live deployment configuration, client storage availability, OS privileges, MFA behavior, or actual provider-side token revocation.

## Reproducibility

```sh
npm ci --ignore-scripts
node --test test/auth-cookie-hardening.test.mjs test/auth-cookie-generation-pure.test.mjs test/auth-cookie-generation.test.mjs
npm test
npm --prefix on-client run check
npm --prefix on-client test
node scripts/auth-cookie-browser-smoke.mjs
```

The browser test uses an actual Chromium CookieJar with **synthetic Supabase responses** and no real credentials. No new branch, packaging, Vercel deployment, production database write, or intrusion test is needed for this audit.
