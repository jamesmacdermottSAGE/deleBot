import { canAccessTask, isTaskAssignees } from "./access.ts";
import type { TaskPatch } from "./commands.ts";
import type { Task, TaskAccess, TaskInput, TaskQuery } from "./models.ts";
import type { TaskRepository } from "./repository.ts";

export interface TaskContext {
  channelId: string;
  messageTs: string;
  userId: string;
  threadTs?: string;
}
function messageTime(ts: string): number {
  const match = /^(\d+)\.(\d{1,6})$/.exec(ts);
  if (!match) throw new Error("Invalid source message timestamp");
  const value = Number(match[1] + match[2].padEnd(6, "0"));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Unsafe message timestamp");
  }
  return value;
}
export async function taskNumber(channelId: string, messageTs: string): Promise<number> {
  messageTime(messageTs);
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${channelId}:${messageTs}`),
    ),
  );
  return Number.parseInt(
    [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 13),
    16,
  ) || 1;
}
export class TaskAccessError extends Error {}
export class TaskCommandError extends Error {}
export function mutationKey(context: TaskContext): string {
  return `${context.channelId}:${context.messageTs}`;
}
function validate(input: TaskInput) {
  if (!input.name.trim() || input.name.length > 200) {
    throw new TaskCommandError("A task needs a name of 1–200 characters.");
  }
  if (!isTaskAssignees(input.assignees) || input.assignees.length > 20) {
    throw new TaskCommandError("Choose up to 20 people or teams, or use all on its own.");
  }
  if (input.description.length > 2000) {
    throw new TaskCommandError("Keep the description to 2,000 characters or fewer.");
  }
  if (
    input.links.length > 10 ||
    input.links.some((url) => url.length > 1000 || !/^https?:\/\//.test(url))
  ) {
    throw new TaskCommandError(
      "Use up to 10 HTTP(S) links, each at most 1,000 characters.",
    );
  }
  if (
    input.priority !== null &&
    (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 5)
  ) throw new TaskCommandError("Priority must be 1–5; 1 is highest.");
  if (input.dueDate !== null) {
    const date = new Date(`${input.dueDate}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) || Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== input.dueDate
    ) throw new TaskCommandError("Use a valid due date.");
  }
}
export async function createTask(
  draft: Pick<TaskInput, "name"> & Partial<Omit<TaskInput, "name">>,
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
): Promise<{ task: Task; created: boolean }> {
  if (access.userId !== context.userId) {
    throw new TaskAccessError("The requester does not match the creator.");
  }
  const existing = await repository.findBySource(context.channelId, context.messageTs);
  if (existing) {
    if (existing.deleted) {
      throw new TaskCommandError(
        "This task has been deleted. Send a new task command to create another.",
      );
    }
    if (!canAccessTask(existing, access)) {
      throw new TaskAccessError("This task is not available to you.");
    }
    return { task: existing, created: false };
  }
  const input: TaskInput = {
    name: draft.name.trim(),
    links: [...new Set(draft.links ?? [])],
    assignees: [...new Set(draft.assignees ?? [])],
    description: draft.description ?? "",
    dueDate: draft.dueDate ?? null,
    priority: draft.priority ?? null,
    completed: draft.completed ?? false,
  };
  validate(input);
  const key = mutationKey(context);
  const task: Task = {
    ...input,
    id: key,
    number: await taskNumber(context.channelId, context.messageTs),
    createdBy: context.userId,
    createdAt: new Date(Math.floor(messageTime(context.messageTs) / 1000)).toISOString(),
    channelId: context.channelId,
    messageTs: context.messageTs,
    threadTs: context.threadTs || context.messageTs,
    assignmentBased: true,
    teams: input.assignees.filter((id) => /^S/.test(id) || id === "all"),
    status: input.completed ? "completed" : "open",
    appliedEvents: [key],
    assignmentEvents: { [key]: input.assignees },
  };
  await repository.save(task);
  return { task, created: true };
}
export async function resolveTaskForUpdate(
  number: number | undefined,
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
): Promise<Task> {
  const candidates = number !== undefined
    ? (await repository.list(access)).filter((task) => task.number === number)
    : await repository.findInThread(
      context.channelId,
      context.threadTs || context.messageTs,
    );
  const visible = candidates.filter((task) => canAccessTask(task, access));
  if (!visible.length) {
    throw new TaskCommandError(
      number === undefined
        ? "No task available in this thread. Start one with task Name, or specify a task number."
        : "No task with that number is available to you.",
    );
  }
  if (visible.length !== 1) {
    throw new TaskCommandError(
      "More than one task matches. Put the task number before the update, e.g. 123 done.",
    );
  }
  return visible[0];
}
export async function updateTask(
  task: Task,
  patch: TaskPatch,
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
): Promise<{ task: Task; updated: boolean }> {
  if (context.userId !== access.userId || !canAccessTask(task, access)) {
    throw new TaskAccessError(
      "Only the creator or current assignees can update this task.",
    );
  }
  const key = mutationKey(context);
  if (task.appliedEvents?.includes(key)) return { task, updated: false };
  let assignees = task.assignees;
  if (patch.assignees !== undefined) {
    if (patch.assignees.length && !isTaskAssignees(patch.assignees)) {
      throw new TaskCommandError("Choose people or teams, or use all on its own.");
    }
    const added = patch.assignees.length ? patch.assignees : [context.userId];
    const previous = task.assignmentBased
      ? task.assignees
      : task.teams.includes("all")
      ? ["all"]
      : [...new Set([...task.assignees, ...task.teams])];
    assignees = added.includes("all")
      ? ["all"]
      : [...new Set([...(previous.includes("all") ? [] : previous), ...added])];
  }
  const next: Task = {
    ...task,
    links: [...new Set([...task.links, ...patch.links ?? []])],
    assignees,
    description: patch.description === undefined
      ? task.description
      : [task.description, patch.description].filter(Boolean).join("\n\n"),
    priority: patch.priority ?? task.priority,
    dueDate: patch.dueDate === undefined ? task.dueDate : patch.dueDate,
    completed: patch.completed ?? task.completed,
    appliedEvents: [...task.appliedEvents ?? [], key],
  };
  next.status = next.completed ? "completed" : "open";
  if (patch.assignees !== undefined) {
    next.assignmentBased = true;
    next.teams = next.assignees.filter((id) => /^S/.test(id) || id === "all");
  }
  validate(next);
  const before = new Set([...task.assignees, ...task.teams]);
  const newlyAssigned = patch.assignees === undefined
    ? []
    : next.assignees.filter((id) => !before.has(id));
  next.assignmentEvents = { ...task.assignmentEvents, [key]: newlyAssigned };
  await repository.save(next);
  return { task: next, updated: true };
}

export async function deleteTask(
  task: Task,
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
): Promise<void> {
  if (context.userId !== access.userId || !canAccessTask(task, access)) {
    throw new TaskAccessError(
      "Only the creator or current assignees can delete this task.",
    );
  }
  await repository.delete(task);
}

function soonWindow(now: Date): { start: string; end: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  const start = `${part("year")}-${part("month")}-${part("day")}`;
  const end = new Date(`${start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 3);
  return { start, end: end.toISOString().slice(0, 10) };
}

export async function listTasks(
  query: TaskQuery,
  access: TaskAccess,
  repository: TaskRepository,
  now = new Date(),
): Promise<Task[]> {
  const dueWindow = query.kind === "filters" && query.soon ? soonWindow(now) : undefined;
  return (await repository.list(access)).filter((task) => {
    if (!canAccessTask(task, access)) return false;
    switch (query.kind) {
      case "all":
        return true;
      case "number":
        return task.number === query.number;
      case "name":
        return task.name.toLocaleLowerCase("en-GB") ===
          query.name.toLocaleLowerCase("en-GB");
      case "assignee":
        return task.assignees.includes(query.userId);
      case "priority":
        return task.priority === query.priority;
      case "due":
        return task.dueDate === query.dueDate;
      case "team":
        return task.teams.includes(query.teamId);
      case "completed":
        return task.completed === query.completed;
      case "filters": {
        const matchesTarget = !query.targets?.length || query.targets.some((target) => {
          switch (target.kind) {
            case "me":
              return task.assignees.includes(access.userId);
            case "user":
              return task.assignees.includes(target.userId);
            case "team":
              return task.teams.includes(target.teamId);
            case "my-teams":
              return task.teams.some((team) => access.teamIds.includes(team));
          }
        });
        return matchesTarget &&
          (query.priority === undefined || task.priority === query.priority) &&
          (query.dueDate === undefined || task.dueDate === query.dueDate) &&
          (!dueWindow || (task.dueDate !== null && task.dueDate >= dueWindow.start &&
            task.dueDate <= dueWindow.end));
      }
    }
  }).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.messageTs.localeCompare(b.messageTs) ||
    a.channelId.localeCompare(b.channelId)
  );
}
