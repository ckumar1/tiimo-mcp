/**
 * Tiimo private-API client.
 *
 * Reverse-engineered from the Tiimo web app (webapp.tiimoapp.com) against the
 * ASP.NET Core backend at api.tiimoapp.com. There is NO official/public Tiimo
 * API — this rides the same private endpoints the web app uses, for the
 * account-owner's own data. It is therefore BRITTLE: endpoints/shapes can change
 * without notice. Every call fails loudly with the server's problem-detail so a
 * shape drift is obvious and easy to re-map.
 *
 * Two distinct models:
 *   - todo-tasks: the To-do / Work / Travel lists (have isChecked). Full CRUD.
 *   - activities: calendar events (recurring, time-boxed). Completion is
 *     event-sourced via /activityactions (it does NOT mutate the activity).
 *
 * Quirks learned the hard way (see qc-yo6uz):
 *   - CREATE task = POST /todo-tasks is INSERT-ONLY and the backend ASSIGNS ITS
 *     OWN id, IGNORING the taskId we send (verified: the id in the response body
 *     differs from the one posted). It echoes the full created entity, so we
 *     MUST read the id back from the response — returning our locally-generated
 *     id would make every later update/complete/delete 404. Same for lists and
 *     activities. (POSTing the "same" body twice therefore always duplicates.)
 *   - UPDATE/COMPLETE task = PUT /todo-tasks (the COLLECTION, full object in
 *     body). PUT /todo-tasks/{id} and PATCH both 405.
 *   - The backend is EVENTUALLY CONSISTENT (~4-8s). A freshly-created task is
 *     not immediately PUT-updatable (404) or reliably deletable. Do not chain
 *     create -> update -> delete quickly; updateTask() re-reads current state
 *     first and surfaces a clear "not yet visible" error instead of corrupting.
 */

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** NextAuth session endpoint that mints a fresh access token from the session cookie. */
const DEFAULT_SESSION_URL = "https://webapp.tiimoapp.com/api/auth/session";

/**
 * Absolute path to the package `.env` (works for both dist/*.js and tsx src/*.ts).
 * Honours a `TIIMO_ENV_FILE` override — useful for pointing the MCP at a specific
 * env file, and for isolating tests from a developer's real `.env`.
 */
export function envPath(): string {
  if (process.env.TIIMO_ENV_FILE) return process.env.TIIMO_ENV_FILE;
  // dist/client.js -> package root/.env ; src/client.ts (tsx) -> same layout.
  return join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
}

/**
 * Read a single `KEY=value` from the package `.env`, FRESH on every call.
 *
 * Why re-read per call: the Tiimo access token expires every ~5 days and the MCP
 * server is a long-lived subprocess. Reading process.env ONCE at startup meant a
 * refreshed token never took effect without a full host restart — an MCP
 * `reconnect` does not reliably re-launch the process with fresh env, so the
 * server stayed wedged on a stale, expired token (observed 2026-06-11: token
 * valid everywhere on disk, server still 401ing). Re-reading `.env` at request
 * time makes a refresh a one-line edit that the NEXT call picks up — no restart,
 * no reconnect. The auto-refresh path (refreshAccessToken) writes the same file,
 * so a self-healed token is picked up the same way.
 */
export function readEnvValue(key: string, path: string = envPath()): string | undefined {
  try {
    const txt = readFileSync(path, "utf8");
    // Match to end-of-line so values containing '=' / ';' / '%' (cookies) survive.
    const m = txt.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`, "m"));
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, "");
      if (v) return v;
    }
  } catch {
    // no readable .env — value came purely from process.env, which is fine.
  }
  return undefined;
}

function readEnvToken(): string | undefined {
  return readEnvValue("TIIMO_TOKEN");
}

/**
 * Update `KEY=value` entries in the package `.env`, preserving every other line
 * (comments, unrelated keys, ordering). Missing keys are appended. Written
 * atomically (temp file + rename) so a crash mid-write can never leave a
 * half-written .env that bricks auth. Values are written raw (no quoting) to
 * match readEnvValue, which reads to end-of-line — safe because tokens/cookies
 * are single-line and contain no newlines.
 */
export function writeEnvValues(updates: Record<string, string>, path: string = envPath()): void {
  let txt = "";
  try {
    txt = readFileSync(path, "utf8");
  } catch {
    // create fresh
  }
  const remaining = new Map(Object.entries(updates));
  const lines = txt.length ? txt.split(/\r?\n/) : [];
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=/);
    if (m && remaining.has(m[1])) {
      const key = m[1];
      const val = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${val}`;
    }
    return line;
  });
  for (const [key, val] of remaining) out.push(`${key}=${val}`);
  let result = out.join("\n");
  if (!result.endsWith("\n")) result += "\n";
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, result, "utf8");
  renameSync(tmp, path);
}

/**
 * Merge any ROTATED NextAuth session cookies from a response back into the
 * stored cookie header, so the durable credential rolls forward instead of
 * expiring at its original 30-day horizon. Handles chunked cookies
 * (`__Secure-next-auth.session-token.0/.1`, emitted when the encrypted JWT
 * exceeds ~4KB) by treating each chunk as its own entry, and honours cookie
 * CLEARS (Set-Cookie with an epoch expiry / Max-Age=0). Returns the new cookie
 * header, or null if nothing session-related changed. Pure — best-effort: the
 * caller wraps it so a parsing quirk never breaks the (already-succeeded) token
 * refresh.
 */
export function mergeRotatedCookie(
  currentCookie: string,
  setCookies: string[],
): string | null {
  if (!setCookies.length) return null;
  const jar = new Map<string, string>();
  for (const part of currentCookie.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1));
  }
  let changed = false;
  for (const sc of setCookies) {
    const first = sc.split(/;\s*/)[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1);
    if (!/session-token/i.test(name)) continue; // only roll the session cookie(s)
    const cleared = value === "" || /expires=Thu,\s*01\s*Jan\s*1970|max-age=0/i.test(sc);
    if (cleared) {
      if (jar.delete(name)) changed = true;
    } else if (jar.get(name) !== value) {
      jar.set(name, value);
      changed = true;
    }
  }
  if (!changed) return null;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

export interface TiimoConfig {
  token: string;
  profileId: string;
  apiBase?: string;
}

export interface TodoTask {
  profileId: string;
  taskId: string;
  todoTaskListId: string;
  title: string;
  notes: string | null;
  duration: number; // seconds
  iconId: string;
  iconType: string; // e.g. "UnicodeEmoji"
  iconUrl: string | null;
  backgroundColor: string; // hex
  tagIds: string[];
  isChecked: boolean;
  createdAt: string;
  checkedAt: string | null;
  subTasks: unknown[];
  grouping: unknown;
}

export interface TodoTaskList {
  todoTaskListId: string;
  profileId: string;
  title: string;
  description: string | null;
  selectedGrouping: unknown;
  sortOrder: number;
  items: TodoTask[];
}

export type ActivitiesByDate = Record<string, TiimoActivity[]>;

export interface TiimoActivity {
  activityId: string;
  title: string;
  description: string;
  startTime: string;
  endTime: string;
  duration: number;
  isAllDay: boolean;
  isRepeating: boolean;
  recurrenceType: string | null;
  isChecked?: boolean;
  completedAt: string | null;
  iconId: string;
  [k: string]: unknown;
}

export class TiimoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "TiimoError";
  }
}

/** RFC4122 v7 (timestamp-ordered) UUID — matches Tiimo's taskId style. */
export function uuidv7(): string {
  const ts = Date.now();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[0] = Math.floor(ts / 2 ** 40) & 0xff;
  b[1] = Math.floor(ts / 2 ** 32) & 0xff;
  b[2] = Math.floor(ts / 2 ** 24) & 0xff;
  b[3] = Math.floor(ts / 2 ** 16) & 0xff;
  b[4] = Math.floor(ts / 2 ** 8) & 0xff;
  b[5] = ts & 0xff;
  b[6] = 0x70 | (b[6] & 0x0f);
  b[8] = 0x80 | (b[8] & 0x3f);
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h
    .slice(6, 8)
    .join("")}-${h.slice(8, 10).join("")}-${h.slice(10).join("")}`;
}

/** Tiimo writes timestamps without trailing ms/Z, e.g. 2026-06-05T06:20:23. */
function tiimoNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "");
}

export class TiimoClient {
  private readonly base: string;
  private readonly profileId: string;
  /** Construction-time token (process.env.TIIMO_TOKEN); fallback only. */
  private readonly initialToken: string;

  constructor(cfg: TiimoConfig) {
    // Lenient on purpose: the MCP server must start and list its tools even
    // without creds. Missing config surfaces as a clear error when a tool runs.
    this.initialToken = cfg.token;
    this.profileId = cfg.profileId;
    this.base = (cfg.apiBase ?? "https://api.tiimoapp.com/api").replace(/\/$/, "");
  }

  /** Freshest token: package .env (re-read per call) wins over the startup value. */
  private resolveToken(): string {
    return readEnvToken() ?? this.initialToken;
  }

  /** Collapse concurrent 401-triggered refreshes into a single in-flight call. */
  private refreshInFlight: Promise<string | null> | null = null;

  /**
   * Self-heal an expired access token WITHOUT a human token re-grab.
   *
   * Tiimo web auth is NextAuth.js: the OIDC refresh token is held server-side
   * (encrypted in the session cookie, never exposed to the client), so we cannot
   * run the raw `/connect/token` refresh ourselves. Instead we replay the browser's
   * own refresh path: GET the NextAuth session endpoint with the stored session
   * cookie — NextAuth performs the OIDC refresh internally and returns a fresh
   * access token. We persist that token (and any rotated session cookie) to .env.
   *
   * TIIMO_SESSION_COOKIE is a ~30-day rolling credential; capture it once from the
   * browser (see .env.example). Returns the new access token, or null if there is
   * no cookie / the session is dead (→ fall back to the manual capture path).
   */
  private refreshAccessToken(): Promise<string | null> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<string | null> {
    const cookie = readEnvValue("TIIMO_SESSION_COOKIE");
    if (!cookie) return null;
    const url = readEnvValue("TIIMO_SESSION_URL") ?? DEFAULT_SESSION_URL;
    let res: Response;
    try {
      res = await fetch(url, { headers: { cookie, accept: "application/json" } });
    } catch {
      return null; // network error — surface the original 401 to the caller
    }
    if (!res.ok) return null; // session cookie expired/invalid → manual re-capture
    let session: { accessToken?: unknown } | undefined;
    try {
      session = (await res.json()) as { accessToken?: unknown };
    } catch {
      return null;
    }
    const at = session?.accessToken;
    if (typeof at !== "string" || !at) return null; // signed-out session returns {}
    const updates: Record<string, string> = { TIIMO_TOKEN: at };
    try {
      const setCookies =
        typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      const rotated = mergeRotatedCookie(cookie, setCookies);
      if (rotated) updates.TIIMO_SESSION_COOKIE = rotated;
    } catch {
      // rotation is best-effort; the token refresh above already succeeded
    }
    try {
      writeEnvValues(updates);
    } catch {
      // couldn't persist — the caller's retry re-reads .env; if that still holds
      // the old token it fails cleanly rather than looping (retried guard).
    }
    return at;
  }

  private async req(method: string, path: string, body?: unknown, retried = false): Promise<unknown> {
    const token = this.resolveToken();
    if (!token) throw new TiimoError("TIIMO_TOKEN is not set — see .env.example for how to get it.", 0);
    if (!this.profileId) throw new TiimoError("TIIMO_PROFILE_ID is not set — see .env.example.", 0);
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      if (res.status === 401) {
        if (!retried) {
          // 1) The token may have been refreshed in .env mid-session (manual edit
          //    or a concurrent auto-refresh). Re-read once and retry.
          const fresh = readEnvToken();
          if (fresh && fresh !== token) {
            return this.req(method, path, body, true);
          }
          // 2) Auto-refresh via the NextAuth session cookie (no human step).
          const refreshed = await this.refreshAccessToken();
          if (refreshed && refreshed !== token) {
            return this.req(method, path, body, true);
          }
        }
        throw new TiimoError(
          "Tiimo rejected the token (401) and auto-refresh did not recover it. Either TIIMO_SESSION_COOKIE is unset/expired or the session was signed out — re-capture it from webapp.tiimoapp.com (see .env.example) and update the tiimo-mcp .env. The server re-reads .env live, so the next call picks it up — no restart needed.",
          401,
          parsed,
        );
      }
      const pd = parsed as { title?: string; traceId?: string } | undefined;
      throw new TiimoError(
        `Tiimo API ${method} ${path} failed: ${res.status} ${pd?.title ?? ""}${
          pd?.traceId ? ` (traceId ${pd.traceId})` : ""
        }`,
        res.status,
        parsed,
      );
    }
    return parsed;
  }

  private p(path: string): string {
    return `/profiles/${this.profileId}${path}`;
  }

  // ---- Todo lists & tasks --------------------------------------------------

  async listTaskLists(): Promise<TodoTaskList[]> {
    const data = (await this.req("GET", this.p("/todo-task-lists"))) as {
      lists?: TodoTaskList[];
    };
    return data.lists ?? [];
  }

  /** Flattened view of every task across all lists, with the list title attached. */
  async listTasks(): Promise<(TodoTask & { listTitle: string })[]> {
    const lists = await this.listTaskLists();
    return lists.flatMap((l) =>
      (l.items ?? []).map((t) => ({ ...t, listTitle: l.title })),
    );
  }

  private async findTask(taskId: string): Promise<TodoTask | undefined> {
    const lists = await this.listTaskLists();
    return lists.flatMap((l) => l.items ?? []).find((t) => t.taskId === taskId);
  }

  /**
   * Create a task. We send a UUIDv7 for shape-validity, but the server REASSIGNS
   * its own taskId and ignores ours (see file header), so we return the server's
   * echoed entity — never our local copy — to give callers the real, usable id.
   */
  async createTask(input: {
    listId: string;
    title: string;
    notes?: string;
    durationSec?: number;
    icon?: string; // unicode emoji
    backgroundColor?: string;
  }): Promise<TodoTask> {
    const task: TodoTask = {
      profileId: this.profileId,
      taskId: uuidv7(),
      todoTaskListId: input.listId,
      title: input.title,
      notes: input.notes ?? null,
      duration: input.durationSec ?? 0,
      iconId: input.icon ?? "✅",
      iconType: "UnicodeEmoji",
      iconUrl: null,
      backgroundColor: input.backgroundColor ?? "#065F68",
      tagIds: [],
      isChecked: false,
      createdAt: tiimoNow(),
      checkedAt: null,
      subTasks: [],
      grouping: { groupingType: "Manual", groupLabel: "Todo" },
    };
    const created = (await this.req("POST", this.p("/todo-tasks"), task)) as TodoTask | undefined;
    if (created && typeof created === "object" && typeof created.taskId === "string") {
      return created;
    }
    throw new TiimoError(
      "Tiimo create returned no task — it normally echoes the full created task (with the server-assigned id). The create contract may have changed; re-map against the web app.",
      0,
      created,
    );
  }

  /**
   * Update a task by re-reading its current full object and PUTting the merged
   * result to the collection (the only update path that works). Throws a clear
   * error if the task isn't visible yet (eventual consistency) rather than
   * PUTting a partial body (which 400s/corrupts).
   */
  async updateTask(
    taskId: string,
    patch: Partial<
      Pick<TodoTask, "title" | "notes" | "duration" | "iconId" | "backgroundColor" | "isChecked" | "checkedAt">
    >,
  ): Promise<TodoTask> {
    const current = await this.findTask(taskId);
    if (!current) {
      throw new TiimoError(
        `Task ${taskId} not found. If you just created it, Tiimo's backend is eventually consistent (~4-8s) — retry shortly.`,
        404,
      );
    }
    const updated: TodoTask = { ...current, ...patch };
    await this.req("PUT", this.p("/todo-tasks"), updated);
    return updated;
  }

  async completeTask(taskId: string): Promise<TodoTask> {
    return this.updateTask(taskId, { isChecked: true, checkedAt: tiimoNow() });
  }

  async uncompleteTask(taskId: string): Promise<TodoTask> {
    return this.updateTask(taskId, { isChecked: false, checkedAt: null });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.req("DELETE", this.p(`/todo-tasks/${taskId}`));
  }

  /**
   * Create a new to-do list. Same insert-only/server-reassigns-id contract as
   * tasks (POST /todo-task-lists → 200, full list echoed with the server's id).
   * sortOrder defaults to the current list count so the new list appends.
   */
  async createTaskList(input: {
    title: string;
    description?: string;
    selectedGrouping?: string; // e.g. "Priority" | "Manual"
  }): Promise<TodoTaskList> {
    const existing = await this.listTaskLists();
    const list = {
      todoTaskListId: uuidv7(),
      profileId: this.profileId,
      title: input.title,
      description: input.description ?? null,
      selectedGrouping: input.selectedGrouping ?? "Priority",
      sortOrder: existing.length,
      items: [],
    };
    const created = (await this.req("POST", this.p("/todo-task-lists"), list)) as
      | TodoTaskList
      | undefined;
    if (created && typeof created === "object" && typeof created.todoTaskListId === "string") {
      return created;
    }
    throw new TiimoError(
      "Tiimo list-create returned no list — the contract may have changed; re-map against the web app.",
      0,
      created,
    );
  }

  async deleteTaskList(listId: string): Promise<void> {
    await this.req("DELETE", this.p(`/todo-task-lists/${listId}`));
  }

  // ---- Calendar activities -------------------------------------------------

  /** fromDate/toDate are YYYY-MM-DD. Returns a map keyed by date (recurrence pre-expanded). */
  async listActivities(fromDate: string, toDate: string): Promise<ActivitiesByDate> {
    return (await this.req(
      "GET",
      this.p(`/activities?fromDate=${fromDate}&toDate=${toDate}`),
    )) as ActivitiesByDate;
  }

  /**
   * Complete/uncomplete a specific occurrence of an activity. Event-sourced:
   * posts an action record, does NOT mutate the activity. instanceDate is the
   * occurrence date, YYYY-MM-DD (sent as midnight).
   */
  async setActivityAction(
    activityId: string,
    instanceDate: string,
    actionType: "Completed" | "Reset",
  ): Promise<void> {
    await this.req("POST", this.p("/activityactions"), {
      actionTime: tiimoNow(),
      actionType,
      instanceDate: `${instanceDate}T00:00:00`,
      activityId,
    });
  }

  /**
   * Create a ONE-OFF (non-recurring) calendar activity. POST /activities → 201,
   * server-assigns the id (uuidv4) and echoes the full 38-field entity, which we
   * return. startTime is naive "YYYY-MM-DDTHH:MM:SS" and is treated as UTC by the
   * backend (it stores startTimeUtc == startTime, leaves the *Local fields at the
   * 0001-01-01 sentinel, offset 00:00:00) — the same shape the web app persists.
   *
   * Recurrence is intentionally NOT exposed here: every recurring activity rides a
   * `repetition` object whose accepted shape we have not verified for *creation*
   * (only read). Sending repetition:null creates a clean single event (verified).
   * Recurring-create is future work — do not guess the repetition body.
   */
  async createActivity(input: {
    title: string;
    startTime: string; // "YYYY-MM-DDTHH:MM:SS", treated as UTC
    durationSec: number;
    description?: string;
    icon?: string; // unicode emoji
    backgroundColor?: string;
    type?: string; // Tiimo activity type, e.g. "Play"
    timeOfDay?: "Morning" | "Afternoon" | "Evening" | "Night";
  }): Promise<TiimoActivity> {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(input.startTime)) {
      throw new TiimoError(
        `startTime must be naive "YYYY-MM-DDTHH:MM:SS" (got ${input.startTime}).`,
        0,
      );
    }
    const endTime = addSecondsNaive(input.startTime, input.durationSec);
    const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
    const activity = {
      activityId: uuidv7(), // ignored by the server, which assigns its own
      title: input.title,
      description: input.description ?? "",
      type: input.type ?? "Play",
      state: null,
      sortPriority: 1500,
      pausedTime: null,
      startTime: input.startTime,
      endTime,
      duration: input.durationSec,
      startTimeActual: input.startTime,
      endTimeActual: endTime,
      durationActual: input.durationSec,
      durationPaused: 0,
      completedAt: null,
      isAllDay: false,
      iconId: input.icon ?? "📌",
      iconUrl: null,
      iconType: "UnicodeEmoji",
      backgroundColor: input.backgroundColor ?? "#F3F3D1",
      isRepeating: false,
      recurrenceType: null,
      repetition: null,
      tagIds: [],
      checklist: null,
      origin: null,
      calendarId: ZERO_UUID,
      externalEventId: null,
      blockRecurrenceUpdateExternalEvent: false,
      taskEnrichmentId: ZERO_UUID,
      grouping: { groupingType: "TimeOfDay", groupingLabel: input.timeOfDay ?? "Morning" },
      allowEarlyStart: true,
      allowEarlyEnd: true,
      startTimeUtc: input.startTime,
      endTimeUtc: endTime,
      startTimeLocal: "0001-01-01T00:00:00",
      endTimeLocal: "0001-01-01T00:00:00",
      timeUtcOffset: "00:00:00",
    };
    const created = (await this.req("POST", this.p("/activities"), activity)) as
      | TiimoActivity
      | undefined;
    if (created && typeof created === "object" && typeof created.activityId === "string") {
      return created;
    }
    throw new TiimoError(
      "Tiimo activity-create returned no activity — the contract may have changed; re-map against the web app.",
      0,
      created,
    );
  }
}

/** Add seconds to a naive "YYYY-MM-DDTHH:MM:SS" timestamp, returning the same format. */
function addSecondsNaive(naive: string, seconds: number): string {
  const ms = new Date(`${naive}Z`).getTime() + seconds * 1000;
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "");
}
