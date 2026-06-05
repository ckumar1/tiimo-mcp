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
  private readonly token: string;

  constructor(cfg: TiimoConfig) {
    // Lenient on purpose: the MCP server must start and list its tools even
    // without creds. Missing config surfaces as a clear error when a tool runs.
    this.token = cfg.token;
    this.profileId = cfg.profileId;
    this.base = (cfg.apiBase ?? "https://api.tiimoapp.com/api").replace(/\/$/, "");
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.token) throw new TiimoError("TIIMO_TOKEN is not set — see .env.example for how to get it.", 0);
    if (!this.profileId) throw new TiimoError("TIIMO_PROFILE_ID is not set — see .env.example.", 0);
    const url = `${this.base}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
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
        throw new TiimoError(
          "Tiimo rejected the token (401). It likely expired (~5-day lifetime) — re-grab TIIMO_TOKEN from the web app's DevTools Network tab.",
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
