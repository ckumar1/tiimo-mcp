# tiimo-mcp — handoff (for fresh context)

Bead: **qc-yo6uz**. Full reverse-engineered API map is in that bead's notes (authoritative — read it first). This file is the "what's left" plan.

## State (2026-06-05)

Standalone repo at `~/tools/tiimo-mcp` (its own git repo, NOT in q-core or the gt workspace). Node 25, TypeScript, ESM, `@modelcontextprotocol/sdk`.

**Done & verified:**
- `src/client.ts` — typed Tiimo client. Encodes the VERIFIED endpoints: list lists, list/get/create/update/complete/uncomplete/delete tasks, list activities, complete/reset activity. Fail-loud errors (401 → "re-grab token"). UUIDv7 generator. Eventual-consistency-aware `updateTask` (re-reads before PUT).
- `src/index.ts` — MCP stdio server, 10 tools registered.
- `npm run build` is green; smoke test passes (server initializes + `tools/list` returns all 10 tools).
- The raw API round-trip (create → PUT update → complete → delete) was proven in-browser on Cherub's real account during recon (account fully restored afterward).

## Remaining work (well-scoped)

1. **Live end-to-end test of the built server** — BLOCKED on the token, which the recon agent could not read (the Chrome MCP safety filter redacts it). Cherub must:
   - Grab `TIIMO_TOKEN` + `TIIMO_PROFILE_ID` per `.env.example` (DevTools → Network → api.tiimoapp.com → Authorization header; profileId is in the URL path).
   - `cp .env.example .env`, fill them in.
   - Then run a real round-trip through the server's tools (create_task → wait ~5s for eventual consistency → complete_task → delete_task) and confirm in the Tiimo app. Use a clearly-labeled test task and delete it.

2. **`create_list` and `create_activity` tools** — NOT implemented; their POST bodies were not captured (guessing risks junk — POST-insert duplicated tasks during recon). Capture each by instrumenting `window.fetch`/XHR in the web app and doing one real UI create (a list, and a calendar event), then implement:
   - `create_list`: likely `POST /api/profiles/{pid}/todo-task-lists`.
   - `create_activity`: likely `POST /api/profiles/{pid}/activities` — body is complex (startTime/endTime/duration, UTC+local, `recurrence`/`repetition`, `grouping` by time-of-day). Capture the minimal accepted body.

3. **README.md** — install/config: how to get the token, env vars, the `.mcp.json` / Claude config snippet, the tool surface, and the BIG caveat (private API, ~5-day token, eventually consistent, can break without notice).

4. **Optional later:** replace manual token paste with the OpenIddict refresh-token flow (IdP `auth.tiimoapp.com`, `/connect/token`). Needs client_id + refresh_token captured from the login flow.

## Gotchas (do not relearn the hard way)

- **POST `/todo-tasks` is INSERT-ONLY** — re-POSTing an existing id creates a DUPLICATE. Updates go via **PUT `/todo-tasks`** (the collection, full object in body). `PUT /{id}` and `PATCH` both 405.
- **Eventual consistency ~4-8s.** A new task isn't immediately updatable/deletable. Don't chain mutations fast. `delete` can race a too-fresh `create`.
- **Token lifetime ~5 days.** 401 = expired → re-grab.
- Activities are a separate model; completion is event-sourced via `/activityactions` (Completed/Reset), not by mutating the activity.

## Consumer
Cheryl wires this into the beads→Tiimo daily priority flow once it round-trips. Nudge her when verified.
