#!/usr/bin/env node
/**
 * Tiimo MCP server (stdio).
 *
 * Exposes Cherub's Tiimo todo lists, tasks, and calendar activities to MCP
 * clients (Claude Code/Desktop). Personal-use, single-account, rides Tiimo's
 * private API — see client.ts for the big caveat.
 *
 * Config via env (see .env.example): TIIMO_TOKEN, TIIMO_PROFILE_ID,
 * optionally TIIMO_API_BASE.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { TiimoClient, TiimoError } from "./client.js";

const client = new TiimoClient({
  token: process.env.TIIMO_TOKEN ?? "",
  profileId: process.env.TIIMO_PROFILE_ID ?? "",
  apiBase: process.env.TIIMO_API_BASE,
});

const server = new McpServer({ name: "tiimo-mcp", version: "0.1.0" });

/** Wrap a handler so Tiimo/argument errors return as readable tool errors, not crashes. */
function tool<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      const result = await fn(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = err instanceof TiimoError ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `ERROR: ${msg}` }], isError: true };
    }
  };
}

server.tool(
  "list_task_lists",
  "List Cherub's Tiimo to-do lists (To-do / Work / Travel etc.) with their ids and task counts.",
  {},
  tool(async () => {
    const lists = await client.listTaskLists();
    return lists.map((l) => ({
      listId: l.todoTaskListId,
      title: l.title,
      taskCount: (l.items ?? []).length,
    }));
  }),
);

server.tool(
  "list_tasks",
  "List tasks across all to-do lists (optionally only open/incomplete ones).",
  { includeCompleted: z.boolean().default(false).describe("Include checked-off tasks") },
  tool(async ({ includeCompleted }: { includeCompleted: boolean }) => {
    const tasks = await client.listTasks();
    return tasks
      .filter((t) => includeCompleted || !t.isChecked)
      .map((t) => ({
        taskId: t.taskId,
        list: t.listTitle,
        title: t.title,
        isChecked: t.isChecked,
        notes: t.notes,
        icon: t.iconId,
      }));
  }),
);

server.tool(
  "create_task",
  "Create a new to-do task in a given list. Get listId from list_task_lists. NOTE: Tiimo is eventually consistent (~4-8s) — a new task is not immediately updatable.",
  {
    listId: z.string().describe("Target list id (from list_task_lists)"),
    title: z.string().describe("Task title"),
    notes: z.string().optional(),
    durationSec: z.number().int().nonnegative().optional().describe("Estimated duration in seconds"),
    icon: z.string().optional().describe("A single unicode emoji"),
  },
  tool(async (a: { listId: string; title: string; notes?: string; durationSec?: number; icon?: string }) => {
    const t = await client.createTask(a);
    return { created: true, taskId: t.taskId, title: t.title, listId: t.todoTaskListId };
  }),
);

server.tool(
  "update_task",
  "Update a task's fields (title/notes/icon/duration). Re-reads then writes the full object.",
  {
    taskId: z.string(),
    title: z.string().optional(),
    notes: z.string().optional(),
    durationSec: z.number().int().nonnegative().optional(),
    icon: z.string().optional(),
  },
  tool(async (a: { taskId: string; title?: string; notes?: string; durationSec?: number; icon?: string }) => {
    const patch: Record<string, unknown> = {};
    if (a.title !== undefined) patch.title = a.title;
    if (a.notes !== undefined) patch.notes = a.notes;
    if (a.durationSec !== undefined) patch.duration = a.durationSec;
    if (a.icon !== undefined) patch.iconId = a.icon;
    const t = await client.updateTask(a.taskId, patch);
    return { updated: true, taskId: t.taskId, title: t.title };
  }),
);

server.tool(
  "complete_task",
  "Mark a to-do task as done (checked).",
  { taskId: z.string() },
  tool(async ({ taskId }: { taskId: string }) => {
    const t = await client.completeTask(taskId);
    return { taskId: t.taskId, isChecked: t.isChecked };
  }),
);

server.tool(
  "uncomplete_task",
  "Mark a previously-completed to-do task as not done (unchecked).",
  { taskId: z.string() },
  tool(async ({ taskId }: { taskId: string }) => {
    const t = await client.uncompleteTask(taskId);
    return { taskId: t.taskId, isChecked: t.isChecked };
  }),
);

server.tool(
  "delete_task",
  "Permanently delete a to-do task.",
  { taskId: z.string() },
  tool(async ({ taskId }: { taskId: string }) => {
    await client.deleteTask(taskId);
    return { deleted: true, taskId };
  }),
);

server.tool(
  "create_list",
  "Create a new to-do list (e.g. a project or context). Returns the server-assigned listId you can then create tasks in.",
  {
    title: z.string().describe("List name"),
    description: z.string().optional(),
    selectedGrouping: z
      .string()
      .optional()
      .describe('How tasks group in the UI, e.g. "Priority" or "Manual" (default "Priority")'),
  },
  tool(async (a: { title: string; description?: string; selectedGrouping?: string }) => {
    const l = await client.createTaskList(a);
    return { created: true, listId: l.todoTaskListId, title: l.title };
  }),
);

server.tool(
  "list_activities",
  "List calendar activities (scheduled/recurring events) in a date range. Dates are YYYY-MM-DD. Returns a map keyed by date.",
  {
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  },
  tool(async ({ fromDate, toDate }: { fromDate: string; toDate: string }) => {
    const byDate = await client.listActivities(fromDate, toDate);
    const out: Record<string, unknown[]> = {};
    for (const [date, acts] of Object.entries(byDate)) {
      if (!acts?.length) continue;
      out[date] = acts.map((a) => ({
        activityId: a.activityId,
        title: a.title,
        startTime: a.startTime,
        endTime: a.endTime,
        isRepeating: a.isRepeating,
        completedAt: a.completedAt,
        icon: a.iconId,
      }));
    }
    return out;
  }),
);

server.tool(
  "complete_activity",
  "Mark a calendar activity occurrence complete for a specific date. instanceDate is YYYY-MM-DD.",
  { activityId: z.string(), instanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
  tool(async ({ activityId, instanceDate }: { activityId: string; instanceDate: string }) => {
    await client.setActivityAction(activityId, instanceDate, "Completed");
    return { activityId, instanceDate, action: "Completed" };
  }),
);

server.tool(
  "reset_activity",
  "Un-complete (reset) a calendar activity occurrence for a specific date. instanceDate is YYYY-MM-DD.",
  { activityId: z.string(), instanceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
  tool(async ({ activityId, instanceDate }: { activityId: string; instanceDate: string }) => {
    await client.setActivityAction(activityId, instanceDate, "Reset");
    return { activityId, instanceDate, action: "Reset" };
  }),
);

server.tool(
  "create_activity",
  "Schedule a ONE-OFF calendar activity (timed event). startTime is naive 'YYYY-MM-DDTHH:MM:SS' treated as UTC; provide a duration in seconds. Recurring events are not supported by this tool.",
  {
    title: z.string(),
    startTime: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
      .describe("Start, naive 'YYYY-MM-DDTHH:MM:SS' (UTC)"),
    durationSec: z.number().int().positive().describe("Event length in seconds"),
    description: z.string().optional(),
    icon: z.string().optional().describe("A single unicode emoji"),
    timeOfDay: z
      .enum(["Morning", "Afternoon", "Evening", "Night"])
      .optional()
      .describe("Which day-section to group under (default Morning)"),
  },
  tool(
    async (a: {
      title: string;
      startTime: string;
      durationSec: number;
      description?: string;
      icon?: string;
      timeOfDay?: "Morning" | "Afternoon" | "Evening" | "Night";
    }) => {
      const act = await client.createActivity(a);
      return {
        created: true,
        activityId: act.activityId,
        title: act.title,
        startTime: act.startTime,
        endTime: act.endTime,
      };
    },
  ),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("tiimo-mcp server running on stdio");
