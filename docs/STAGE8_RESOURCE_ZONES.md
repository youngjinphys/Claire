# Stage 8 — resource-zone boundary and verified API ownership

This checkpoint uses the original 18-field ALEPH engine contract.
It does **not** contain a verified instructor role or memo owner.

The isolated `src/decider.mjs` checks the server-attested service, subject,
registered device, method, exact canonical resource path, route and empty
query fingerprint. It preserves stage-6 device and stage-7 step-up checks.

| SDP route | Decision for registered, valid request | Final data protection |
| --- | --- | --- |
| GET/PUT /notes/:id (UUID or synthetic demo) | allow (or step_up for compound fixture risk) | API verifies JWT user UUID equals stored owner_id |
| GET /announcements/:id | allow (or step_up when applicable) | API verifies authentication |
| POST/PUT/PATCH/DELETE /announcements and /announcements/:id | deny for **every** subject/device | API separately verifies role/owner when reached outside SDP |
| /notes, /notes/, /notes/export and deeper/noncanonical paths | deny | API note list is scoped by owner_id |

No fixture-only owner whitelist exists in the SDP. A different verified
subject may reach the **individual memo gate**, but may not retrieve or
modify another user's note: `api/notes.js` checks the authenticated user
and persisted `owner_id` before returning data. Client roles, query
parameters, fake device claims, route aliases and inferred instructor
titles never grant a notice-write exception.

The server-side notice API may still require a verified instructor and
saved owner for direct API operations. That verification is distinct from
the **more restrictive SDP notice-write denial**, which remains unconditional.

To verify: `npm run test:zone`, `npm run test:xdr`,
`npm run test:recovery`, and `npm run build -- --local`.
The public course grader result and live named A/B instructor E2E are
separate from the local tests.
