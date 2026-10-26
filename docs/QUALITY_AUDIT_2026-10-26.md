# Claire repository audit — 2026-10-26

## Baseline and verified findings

- Repository: youngjinphys/Claire; starting `main` HEAD `2f6810139fcd51212b7ee1717c0ccb7e0313de26`.
- 26 prior-stage root tests were absent from `main` although test scripts still referenced them. Their original Git tree exists at `b7fdc15`; removal was described as a *temporary* response to suspected secret-scanner false positives, not a confirmed cause.
- No GitHub Actions workflow or recorded run was present at audit start; default `main` branch protection was disabled.
- Claire local AI handlers reported `retryable:true` even for some terminal authorization/configuration failures; one native check route correctly used an explicit retryability allowlist.
- `/api/diagnostics` returned `0.1.0` although the app manifest declared `0.2.11`. The local startup log also used the old agent name.

## Changes and rationale

- Restore the exact historical test subtree; maintain its original immutable course-source fingerprint checks, while replacing a stale `.gitignore` blob hash assertion with explicit privacy-ignoring invariants.
- Add a root `npm test`, least-privilege push/PR GitHub Actions verification and on-client live loopback HTTP regression tests.
- Apply a single allowlist to all AI error `retryable` flags, preserving fail-closed behavior and not initiating automatic retry.
- Read diagnostic product version from `on-client/package.json`; keep `starterVersion` separate for backward compatibility. Use Claire for the startup log, without renaming coupled on-disk protocol files.

## Reproduction (Node.js 24.19.0)

```bash
npm ci --ignore-scripts
npm test
npm run build -- --local
npm --prefix on-client run check
npm --prefix on-client test
```

These commands are unit/mock/loopback checks; they do not deploy or connect to real users, the official judge, CLCO gateway, Supabase data or Windows Native Host. CI status must be checked against the exact new commit SHA; unrun checks must not be called passing.

## Risks and deliberate non-changes

- `aleph.config.json.repoUrl` refers to `youngjinphys/choi-bujang-secret-vault` rather than the current repository. The evaluator registration and real deployment identity require operator verification before changing it.
- Existing `judgeIssuer`, Supabase provisioning/RLS, grade schemas, service endpoints and student rendering/protocol identifiers are preserved. Blindly altering these could invalidate the graded or installed environment.
- Workflow presence does not enforce branch protection: admin settings should require the quality check, restrict force pushes and configure reviews.
- Actual Windows installation, native device approval, AI paid usage, SDP/XDR effects, Vercel deployment, official stage results and all 41 evaluator attacks remain unverified.
- Fixture strings in historical tests are synthetic. Do not add live keys, private records or tokens to test fixtures or logs.

## Exit criteria

Verify changed paths and the new `main` HEAD on GitHub, inspect full CI logs for that SHA, and explicitly distinguish CI success from live operational validation.
