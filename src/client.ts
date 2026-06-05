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
 *   - CREATE task = POST /todo-tasks and is INSERT-ONLY. POSTing an existing
 *     taskId creates a DUPLICATE — it is NOT an upsert.
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
   * Create a task. POST is insert-only; we generate a fresh UUIDv7 so we never
   * collide with (and thus duplicate) an existing task.
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
    await this.req("POST", this.p("/todo-tasks"), task);
    return task;
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
}
