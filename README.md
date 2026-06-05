# tiimo-mcp

An MCP (Model Context Protocol) server that lets Claude — or any MCP client — **read and update your [Tiimo](https://www.tiimoapp.com/) to-do lists, tasks, and calendar activities**.

Tiimo ships no public API. This rides the same private endpoints the Tiimo web app
uses, scoped to **your own account and data**. That makes it powerful but **brittle**:
endpoints and payload shapes can change without notice. Every call fails loudly with
the server's error so a shape-drift is obvious and easy to re-map.

> Personal-interoperability automation against your own account. Be a good citizen:
> reasonable request rates, no scraping anyone else's data.

## What it can do

| Tool | What it does |
|------|--------------|
| `list_task_lists` | List your to-do lists (To-do / Work / Travel …) with ids + task counts |
| `list_tasks` | List tasks across all lists (open by default; `includeCompleted` for all) |
| `create_task` | Add a task to a list |
| `update_task` | Change a task's title / notes / icon / duration |
| `complete_task` / `uncomplete_task` | Check / uncheck a task |
| `delete_task` | Delete a task |
| `create_list` | Create a new to-do list |
| `list_activities` | List calendar activities in a date range (recurrence pre-expanded) |
| `complete_activity` / `reset_activity` | Mark a calendar activity occurrence done / not-done for a date |
| `create_activity` | Schedule a **one-off** (non-recurring) timed event |

## Setup

```bash
cd ~/tools/tiimo-mcp
npm install
npm run build
cp .env.example .env   # then fill in the two values below
```

### Getting your token + profile id

`TIIMO_TOKEN` is the Bearer access token the web app uses (a JWT,
`iss=auth.tiimoapp.com`, **~5-day lifetime** — re-grab when you get a 401).

Easiest grab (the web app exposes it on a same-origin endpoint):

1. Log in at <https://webapp.tiimoapp.com>.
2. Open DevTools → **Console** and run:
   ```js
   await fetch('/api/auth/session').then(r => r.json()).then(s => s.accessToken)
   ```
   Copy the printed token into `TIIMO_TOKEN` (no `Bearer ` prefix).

Alternatively: DevTools → **Network** → filter `api.tiimoapp.com` → any request →
Headers → copy the `authorization: Bearer <token>` value (the `<token>` part).

`TIIMO_PROFILE_ID` is your Tiimo profile UUID. Either:
- run `curl -s https://api.tiimoapp.com/api/profiles -H "authorization: Bearer $TIIMO_TOKEN"`
  and copy the `profileId`, **or**
- grab the `{profileId}` segment from any `/api/profiles/{profileId}/…` request in the Network tab.

```ini
# .env
TIIMO_TOKEN=eyJ...           # ~5-day JWT
TIIMO_PROFILE_ID=00000000-0000-0000-0000-000000000000
# TIIMO_API_BASE=https://api.tiimoapp.com/api   # optional override
```

## Install into Claude

Add to your MCP config (`~/.claude.json`, or a project `.mcp.json`):

```json
{
  "mcpServers": {
    "tiimo": {
      "command": "node",
      "args": ["/Users/cherub/tools/tiimo-mcp/dist/index.js"],
      "env": {
        "TIIMO_TOKEN": "eyJ...",
        "TIIMO_PROFILE_ID": "00000000-0000-0000-0000-000000000000"
      }
    }
  }
}
```

(Or keep the values in `.env` and load it however your client prefers — the server
reads `process.env`.)

## Caveats — read these

- **Private API, no stability guarantee.** Shapes can change without notice. When
  they do, calls fail loudly with the server's error; re-map against the web app.
- **Token lifetime ~5 days.** A `401` means it expired — re-grab it (see above).
- **Eventually consistent (~4–8s).** A freshly-created task isn't immediately
  updatable or deletable. `update_task` re-reads first and returns a clear
  "not visible yet, retry shortly" error rather than corrupting state — don't
  chain create → update → delete back-to-back.
- **The server assigns its own ids.** `create_task` / `create_list` /
  `create_activity` return the **server-assigned** id (the id you'd pass back into
  update/complete/delete). POSTing the same body twice creates a duplicate — it is
  not an upsert.
- **Activities are event-sourced for completion.** `complete_activity` posts an
  action record for a specific occurrence date; it does not mutate the activity.
- **`create_activity` is one-off only.** Recurring-event creation rides a
  `repetition` object whose create-shape isn't verified yet — deliberately not
  exposed. (Reading/completing recurring activities works fine.)

## Development

```bash
npm run build    # tsc → dist/
npm start        # run the stdio server (needs env)
```

Source: `src/client.ts` (typed Tiimo client, all the reverse-engineered endpoints)
and `src/index.ts` (the MCP stdio server). The full reverse-engineering notes live
in bead **qc-yo6uz**.
