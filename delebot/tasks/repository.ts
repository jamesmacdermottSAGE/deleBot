import { TasksDatastore } from "../db.ts";
import { canAccessTask, isTaskAssignees, isTaskTeams } from "./access.ts";
import type { Task, TaskAccess } from "./models.ts";

export interface TaskRepository {
  findBySource(channelId: string, messageTs: string): Promise<Task | null>;
  findInThread(channelId: string, threadTs: string): Promise<Task[]>;
  save(task: Task): Promise<void>;
  delete(task: Task): Promise<void>;
  list(access: TaskAccess): Promise<Task[]>;
  referencedTeamIds(): Promise<string[]>;
}

export class TaskReferenceError extends Error {}

interface DatastoreResult {
  ok: boolean;
  error?: string;
  item?: Record<string, unknown>;
  items?: Record<string, unknown>[];
  next_cursor?: string;
  response_metadata?: { next_cursor?: string; warnings?: string[]; messages?: string[] };
}

/** Small structural boundary supported by both the Slack SDK and test clients. */
export interface DatastoreClient {
  apps: {
    datastore: {
      get(args: { datastore: string; id: string }): Promise<DatastoreResult>;
      put(args: {
        datastore: string;
        item: Record<string, unknown>;
      }): Promise<DatastoreResult>;
      query(args: {
        datastore: string;
        expression: string;
        expression_attributes: Record<string, string>;
        expression_values: Record<string, string | number>;
        limit: number;
        cursor?: string;
      }): Promise<DatastoreResult>;
    };
  };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Reject malformed rows instead of silently dropping tasks or presenting partial data. */
function fromRecord(row: Record<string, unknown>): Task {
  // Existing rows predate team visibility; keep them private to their creator.
  const teams = row.teams === undefined ? [] : row.teams;
  const assignmentBased = row.assignment_version === 2;
  const assignees = assignmentBased ? row.assigned_to : row.assignees;
  const completed = row.completed === undefined
    ? row.status === "completed"
    : row.completed;
  const priority = row.priority ?? row.urgency ?? null;
  const dueDate = row.due_date === "" || row.due_date === undefined ? null : row.due_date;
  const strings = [
    "id",
    "name",
    "created_by",
    "created_at",
    "channel_id",
    "message_ts",
  ];
  if (
    !strings.every((key) => typeof row[key] === "string" && row[key].trim()) ||
    !Number.isSafeInteger(row.number) || (row.number as number) < 1 ||
    (priority !== null &&
      (!Number.isInteger(priority) || (priority as number) < 1 ||
        (priority as number) > 5)) ||
    typeof row.description !== "string" ||
    !stringArray(row.links) || !stringArray(row.assignees) ||
    (assignmentBased && !isTaskAssignees(assignees)) ||
    (row.assignment_version !== undefined && !assignmentBased) ||
    (row.assigned_to !== undefined && !assignmentBased) ||
    typeof completed !== "boolean" ||
    (row.deleted !== undefined && typeof row.deleted !== "boolean") ||
    (row.thread_ts !== undefined &&
      (typeof row.thread_ts !== "string" || !row.thread_ts.trim())) ||
    !isTaskTeams(teams) ||
    (dueDate !== null && !isDate(dueDate)) ||
    Number.isNaN(Date.parse(row.created_at as string)) ||
    !["open", "completed"].includes(row.status as string) ||
    (completed !== (row.status === "completed")) ||
    row.id !== `${row.channel_id}:${row.message_ts}`
  ) {
    throw new Error("Task datastore contains an invalid record.");
  }
  if (assignmentBased) {
    const expectedTeams = (assignees as string[]).filter((id) =>
      /^S/.test(id) || id === "all"
    );
    if (
      JSON.stringify([...new Set(teams)].sort()) !==
        JSON.stringify([...new Set(expectedTeams)].sort())
    ) {
      throw new Error("Task datastore contains an invalid assignment policy.");
    }
  }
  return {
    id: row.id as string,
    number: row.number as number,
    name: row.name as string,
    links: [...row.links],
    assignees: [...assignees as string[]],
    assignmentBased,
    completed,
    ...(row.deleted === undefined ? {} : { deleted: row.deleted as boolean }),
    description: row.description as string,
    dueDate: dueDate as string | null,
    priority: priority as Task["priority"],
    teams: [...teams],
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    channelId: row.channel_id as string,
    messageTs: row.message_ts as string,
    threadTs: typeof row.thread_ts === "string" && row.thread_ts
      ? row.thread_ts
      : row.message_ts as string,
    ...(row.applied_events === undefined
      ? {}
      : { appliedEvents: parseAppliedEvents(row.applied_events) }),
    ...(row.assignment_events === undefined
      ? {}
      : { assignmentEvents: parseAssignmentEvents(row.assignment_events) }),
    status: row.status as Task["status"],
  };
}

function parseAppliedEvents(value: unknown): string[] {
  if (!stringArray(value)) throw new Error("Invalid applied task events.");
  return [...value];
}
function parseAssignmentEvents(value: unknown): Record<string, string[]> {
  if (typeof value !== "string") throw new Error("Invalid assignment events.");
  const parsed = JSON.parse(value);
  if (
    !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    !Object.values(parsed).every((ids) =>
      Array.isArray(ids) &&
      ids.every((id) => typeof id === "string" && /^(all|[UWS][A-Z0-9]+)$/.test(id))
    )
  ) {
    throw new Error("Invalid assignment events.");
  }
  return parsed;
}

function toRecord(task: Task): Record<string, unknown> {
  return {
    id: task.id,
    number: task.number,
    name: task.name,
    links: task.links,
    assignees: task.assignees.filter((id) => /^[UW]/.test(id)),
    ...(task.assignmentBased
      ? { assigned_to: task.assignees, assignment_version: 2 }
      : {}),
    completed: task.completed,
    ...(task.deleted === undefined ? {} : { deleted: task.deleted }),
    description: task.description,
    due_date: task.dueDate ?? "",
    ...(task.priority === null
      ? {}
      : { priority: task.priority, urgency: task.priority }),
    teams: task.teams,
    created_by: task.createdBy,
    created_at: task.createdAt,
    channel_id: task.channelId,
    message_ts: task.messageTs,
    thread_ts: task.threadTs,
    ...(task.appliedEvents ? { applied_events: task.appliedEvents } : {}),
    ...(task.assignmentEvents
      ? { assignment_events: JSON.stringify(task.assignmentEvents) }
      : {}),
    status: task.status,
  };
}

export class SlackTaskRepository implements TaskRepository {
  constructor(private readonly client: DatastoreClient) {}

  /** Internal membership-discovery metadata; no task details are returned to callers. */
  async referencedTeamIds(): Promise<string[]> {
    const teams = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.client.apps.datastore.query({
        datastore: TasksDatastore.name,
        // Slack's datastore adapter rejects an empty ExpressionAttributeValues
        // map, including for attribute_exists alone. Bind a real size threshold.
        expression: "attribute_exists(#teams) AND size(#teams) >= :zero",
        expression_attributes: { "#teams": "teams" },
        expression_values: { ":zero": 0 },
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok || !Array.isArray(result.items)) {
        throw new TaskReferenceError(
          `Cannot read task team references: ${result.error ?? "invalid_response"}`,
        );
      }
      for (const row of result.items) {
        if (row.deleted === true) continue;
        if (row.teams === undefined) continue;
        if (!isTaskTeams(row.teams)) {
          throw new TaskReferenceError("Invalid task team policy.");
        }
        for (const id of row.teams) if (id !== "all") teams.add(id);
      }
      cursor = result.next_cursor || result.response_metadata?.next_cursor || undefined;
      if (cursor && cursors.has(cursor)) {
        throw new TaskReferenceError("Repeated task team cursor.");
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...teams];
  }

  async findBySource(channelId: string, messageTs: string): Promise<Task | null> {
    const result = await this.client.apps.datastore.get({
      datastore: TasksDatastore.name,
      id: `${channelId}:${messageTs}`,
    });
    if (!result.ok) {
      throw new Error(`Cannot read task: ${result.error ?? "unknown_error"}`);
    }
    if (!result.item || Object.keys(result.item).length === 0) return null;
    const task = fromRecord(result.item);
    if (task.channelId !== channelId || task.messageTs !== messageTs) {
      throw new Error("Task datastore returned a task from another message.");
    }
    return task;
  }

  async findInThread(channelId: string, threadTs: string): Promise<Task[]> {
    const tasks: Task[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.client.apps.datastore.query({
        datastore: TasksDatastore.name,
        expression:
          "#channel = :channel AND (#thread = :thread OR (attribute_not_exists(#thread) AND #message = :thread))",
        expression_attributes: {
          "#channel": "channel_id",
          "#thread": "thread_ts",
          "#message": "message_ts",
        },
        expression_values: { ":channel": channelId, ":thread": threadTs },
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok || !Array.isArray(result.items)) {
        throw new Error("Cannot find tasks in this thread.");
      }
      for (const row of result.items) {
        const task = fromRecord(row);
        if (!task.deleted && task.channelId === channelId && task.threadTs === threadTs) {
          tasks.push(task);
        }
      }
      cursor = result.next_cursor || result.response_metadata?.next_cursor || undefined;
      if (cursor && cursors.has(cursor)) throw new Error("Repeated thread query cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return tasks;
  }

  async save(task: Task): Promise<void> {
    const item = toRecord(task);
    fromRecord(item);
    const result = await this.client.apps.datastore.put({
      datastore: TasksDatastore.name,
      item,
    });
    if (!result.ok) {
      throw new Error(`Cannot save task: ${result.error ?? "unknown_error"}`);
    }
  }

  async delete(task: Task): Promise<void> {
    // Keep the source key so a delayed replay cannot recreate the deleted task.
    await this.save({ ...task, deleted: true });
  }

  async list(access: TaskAccess): Promise<Task[]> {
    const expressionValues: Record<string, string | number> = {
      ":all": "all",
      ":zero": 0,
      ":user": access.userId,
      ":version": 2,
    };
    const permissions = [
      "contains(#teams, :all)",
      "(#version = :version AND contains(#assigned, :user))",
      "(#version = :version AND #creator = :user)",
    ];
    for (const [index, team] of [...new Set(access.teamIds)].entries()) {
      const parameter = `:team${index}`;
      expressionValues[parameter] = team;
      permissions.push(`contains(#teams, ${parameter})`);
    }
    permissions.push(
      "((attribute_not_exists(#teams) OR size(#teams) = :zero) AND #creator = :user)",
    );
    const tasks: Task[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.client.apps.datastore.query({
        datastore: TasksDatastore.name,
        expression: permissions.join(" OR "),
        expression_attributes: {
          "#teams": "teams",
          "#creator": "created_by",
          "#version": "assignment_version",
          "#assigned": "assigned_to",
        },
        expression_values: expressionValues,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!result.ok) {
        throw new Error(`Cannot list tasks: ${result.error ?? "unknown_error"}`);
      }
      if (!Array.isArray(result.items)) {
        throw new Error("Task datastore returned an invalid task list.");
      }
      for (const row of result.items) {
        const task = fromRecord(row);
        // Enforce the policy locally too, regardless of server-side filtering.
        if (canAccessTask(task, access)) tasks.push(task);
      }
      cursor = result.next_cursor || result.response_metadata?.next_cursor || undefined;
      if (cursor) {
        if (seenCursors.has(cursor)) {
          throw new Error("Task datastore repeated a pagination cursor.");
        }
        seenCursors.add(cursor);
      }
    } while (cursor);
    return tasks;
  }
}
