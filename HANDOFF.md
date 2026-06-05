# tiimo-mcp — handoff (for fresh context)

Bead: **qc-yo6uz**. Full reverse-engineered API map is in that bead's notes (authoritative — read it first). This file is the "what's left" plan.

## State (2026-06-05, session 2 — COMPLETE)

Standalone repo at `~/tools/tiimo-mcp` (its own git repo, NOT in q-core or the gt workspace). Node 25, TypeScript, ESM, `@modelcontextprotocol/sdk`.

**Done & verified against Cherub's REAL account (in-page, via the app's own auth — token never extracted):**
- `src/client.ts` — typed Tiimo client. All endpoints VERIFIED live.
- `src/index.ts` — MCP stdio server, **12 tools** (added `create_list`, `create_activity`).
- `npm run build` green; smoke test passes (`tools/list` → 12 tools).
- **Full task round-trip PROVEN end-to-end** on the real account: create → (wait ~6s) → complete (PUT) → delete, with cleanup confirmed (0 leftovers).
- **`create_list` verified**: `POST /todo-task-lists` → 200, server-assigned id; DELETE → 204.
- **`create_activity` verified**: `POST /activities` → 201, server-assigned uuidv4 id; one-off (`repetition:null`) accepted; DELETE → 204. Tested on a far-past date (no device notification), cleaned up.

### 🐛 BUG FOUND & FIXED (the important one)
The backend **ignores the client-supplied `taskId` (and list/activity id) and assigns its own**, echoing the full created entity in the response. The old `createTask` returned the *local* id → every later update/complete/delete on a freshly-created task would have 404'd. Fixed: all three `create*` methods now **return the server's echoed entity**. The recon's "in-browser round-trip" masked this (it didn't chain create→update by the returned id).

## Remaining work (optional / future)

1. **Run the installed server with a real token** — the contract is fully proven, but the actual `node dist/index.js` process reading `.env` still wants a smoke run. Cherub: `cp .env.example .env`, grab the token via the README's `/api/auth/session` one-liner (profile id from `GET /api/profiles`), then exercise a tool. Pure plumbing — the API behavior is verified.
2. **Recurring `create_activity`** — only one-off creation is verified; the `repetition` create-shape is unverified (read-only so far). Deliberately not exposed. Capture a real recurring-create body before implementing.
3. **Optional:** replace manual token paste with the OpenIddict refresh-token flow (IdP `auth.tiimoapp.com`, `/connect/token`). Needs client_id + refresh_token from the login flow.

## Gotchas (do not relearn the hard way)

- **POST `/todo-tasks` is INSERT-ONLY** — re-POSTing an existing id creates a DUPLICATE. Updates go via **PUT `/todo-tasks`** (the collection, full object in body). `PUT /{id}` and `PATCH` both 405.
- **Eventual consistency ~4-8s.** A new task isn't immediately updatable/deletable. Don't chain mutations fast. `delete` can race a too-fresh `create`.
- **Token lifetime ~5 days.** 401 = expired → re-grab.
- Activities are a separate model; completion is event-sourced via `/activityactions` (Completed/Reset), not by mutating the activity.

## Consumer
Cheryl wires this into the beads→Tiimo daily priority flow once it round-trips. Nudge her when verified.
