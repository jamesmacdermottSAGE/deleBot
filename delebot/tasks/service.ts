import {
  canAccessTask,
  canEditTask,
  effectiveTaskViewPerms,
  isTaskAssignees,
  isTaskPermissions,
} from "./access.ts";
import type { ClearField, TaskPatch, TaskSet } from "./commands.ts";
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
  for (const links of [input.jiraLinks ?? [], input.githubLinks ?? []]) {
    if (
      links.length > 10 ||
      links.some((url) => url.length > 1000 || !/^https?:\/\//i.test(url))
    ) throw new TaskCommandError("Use up to 10 valid HTTP(S) links in each link field.");
  }
  for (const policy of [input.viewPerms, input.editPerms]) {
    if (policy !== undefined && !isTaskPermissions(policy)) {
      throw new TaskCommandError(
        "Choose people or teams for permissions, or use all on its own.",
      );
    }
  }
}

/** Old tasks recover their return path from delegation history until next assigned. */
function assignmentReturnPath(
  task: Task,
  principals: string[],
  visited = new Set<string>(),
): string[] {
  for (const id of principals) {
    const path = task.assignmentResponses?.[id]?.returnTo;
    if (path !== undefined) return [...path];
    visited.add(id);
  }
  const delegator = Object.entries(task.assignmentResponses ?? {}).reverse().find(
    ([id, response]) =>
      !visited.has(id) && /^[UW]/.test(id) && response.status === "delegated" &&
      response.delegatedTo?.some((target) => principals.includes(target)),
  )?.[0];
  return delegator
    ? [delegator, ...assignmentReturnPath(task, [delegator], visited)]
    : visited.has(task.createdBy)
    ? []
    : [task.createdBy];
}

function delegationReturnPath(task: Task, userId: string, target: string): string[] {
  return [...new Set([userId, ...assignmentReturnPath(task, [userId])])]
    .filter((id) => id !== target);
}

export async function createTask(
  draft: Pick<TaskInput, "name"> & Partial<Omit<TaskInput, "name">> & {
    matchPerms?: boolean;
  },
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
    jiraLinks: [...new Set(draft.jiraLinks ?? [])],
    githubLinks: [...new Set(draft.githubLinks ?? [])],
    assignees: [...new Set(draft.assignees ?? [])],
    description: draft.description ?? "",
    dueDate: draft.dueDate ?? null,
    priority: draft.priority ?? null,
    completed: draft.completed ?? false,
    viewPerms: draft.viewPerms === undefined ? ["all"] : [...new Set(draft.viewPerms)],
    editPerms: draft.editPerms === undefined ? ["all"] : [...new Set(draft.editPerms)],
  };
  if (draft.matchPerms) {
    if (draft.editPerms !== undefined) {
      throw new TaskCommandError(
        "Use perms match without setting edit permissions in the same command.",
      );
    }
    input.editPerms = [...input.viewPerms!];
  }
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
    assignmentResponses: Object.fromEntries(
      input.assignees.filter((id) => id !== "all").map((id) => [id, {
        status: "pending" as const,
        returnTo: id === context.userId ? [] : [context.userId],
      }]),
    ),
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
  if (context.userId !== access.userId || !canEditTask(task, access)) {
    throw new TaskAccessError("You need view and edit permission to update this task.");
  }
  const key = mutationKey(context);
  if (task.appliedEvents?.includes(key)) return { task, updated: false };
  const replacements = patch.set ?? {};
  const clears = new Set(patch.clear ?? []);
  const defaults: Record<ClearField, unknown> = {
    links: [],
    jiraLinks: [],
    githubLinks: [],
    assignees: [],
    description: "",
    priority: null,
    dueDate: null,
    completed: false,
    viewPerms: ["all"],
    editPerms: ["all"],
  };
  for (const field of clears) {
    if (!Object.hasOwn(defaults, field)) {
      throw new TaskCommandError("A task name cannot be cleared.");
    }
    if (Object.hasOwn(patch, field) || Object.hasOwn(replacements, field)) {
      throw new TaskCommandError("Set, add, or clear each field once per command.");
    }
  }
  for (const field of Object.keys(replacements) as (keyof TaskSet)[]) {
    if (field !== "name" && !Object.hasOwn(defaults, field)) {
      throw new TaskCommandError("Choose a supported task field to edit.");
    }
    if (Object.hasOwn(patch, field)) {
      throw new TaskCommandError("Do not combine adding and replacing the same field.");
    }
  }
  if (
    patch.matchPerms &&
    (patch.editPerms !== undefined || replacements.editPerms !== undefined ||
      clears.has("editPerms"))
  ) {
    throw new TaskCommandError("Use perms match without another edit permission change.");
  }
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
    jiraLinks: [...new Set([...task.jiraLinks ?? [], ...patch.jiraLinks ?? []])],
    githubLinks: [...new Set([...task.githubLinks ?? [], ...patch.githubLinks ?? []])],
    assignees,
    description: patch.description === undefined
      ? task.description
      : [task.description, patch.description].filter(Boolean).join("\n\n"),
    priority: patch.priority ?? task.priority,
    dueDate: patch.dueDate === undefined ? task.dueDate : patch.dueDate,
    completed: patch.completed ?? task.completed,
    ...(patch.viewPerms === undefined
      ? {}
      : { viewPerms: [...new Set(patch.viewPerms)] }),
    ...(patch.editPerms === undefined
      ? {}
      : { editPerms: [...new Set(patch.editPerms)] }),
    appliedEvents: [...task.appliedEvents ?? [], key],
  };
  Object.assign(next, replacements);
  if (replacements.assignees?.length === 0) next.assignees = [context.userId];
  for (const field of clears) {
    Object.assign(next, { [field]: structuredClone(defaults[field]) });
  }
  next.name = next.name.trim();
  next.assignees = [...new Set(next.assignees)];
  next.links = [...new Set(next.links)];
  if (next.viewPerms !== undefined) next.viewPerms = [...new Set(next.viewPerms)];
  if (next.editPerms !== undefined) next.editPerms = [...new Set(next.editPerms)];
  if (patch.matchPerms) next.editPerms = effectiveTaskViewPerms(next);
  next.status = next.completed ? "completed" : "open";
  const assignmentChanged = patch.assignees !== undefined ||
    replacements.assignees !== undefined || clears.has("assignees");
  if (assignmentChanged) {
    if (!task.assignmentBased) {
      if (next.viewPerms === undefined) next.viewPerms = effectiveTaskViewPerms(task);
      if (next.editPerms === undefined) next.editPerms = effectiveTaskViewPerms(task);
    }
    next.assignmentBased = true;
    next.teams = next.assignees.filter((id) => /^S/.test(id) || id === "all");
  }
  validate(next);
  const before = new Set([...task.assignees, ...task.teams]);
  const newlyAssigned = !assignmentChanged
    ? []
    : next.assignees.filter((id) => !before.has(id));
  next.assignmentResponses = clears.has("assignees")
    ? {}
    : { ...task.assignmentResponses };
  for (const id of newlyAssigned) {
    if (id !== "all") {
      next.assignmentResponses[id] = {
        status: "pending",
        returnTo: delegationReturnPath(task, context.userId, id),
      };
    }
  }
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
  if (context.userId !== access.userId || !canEditTask(task, access)) {
    throw new TaskAccessError("You need view and edit permission to delete this task.");
  }
  await repository.delete(task);
}

export type AssignmentDecision = {
  kind: "accept" | "reject" | "delegate";
  assignees?: string[];
  note?: string;
};

/** An invitation recipient can respond without being an editor; delegation still edits the task. */
export async function respondToAssignment(
  task: Task,
  decision: AssignmentDecision,
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
): Promise<{ task: Task; updated: boolean }> {
  if (context.userId !== access.userId || !canAccessTask(task, access)) {
    throw new TaskAccessError("This assignment is not available to you.");
  }
  const key = mutationKey(context);
  if (task.appliedEvents?.includes(key)) return { task, updated: false };
  const previous = task.assignmentBased
    ? task.assignees
    : task.teams.includes("all")
    ? ["all"]
    : [...new Set([...task.assignees, ...task.teams])];
  const respondingTeams = previous.filter((id) =>
    /^S/.test(id) && access.teamIds.includes(id)
  );
  const assigned = previous.includes(access.userId) || previous.includes("all") ||
    respondingTeams.length > 0;
  if (!assigned) throw new TaskAccessError("You are no longer assigned this task.");
  if (!["accept", "reject", "delegate"].includes(decision.kind)) {
    throw new TaskCommandError("Choose accept, reject, or delegate.");
  }
  if (
    decision.note !== undefined &&
    (typeof decision.note !== "string" || decision.note.length > 2000)
  ) {
    throw new TaskCommandError("Keep the delegation note to 2,000 characters or fewer.");
  }
  const note = decision.kind === "delegate" ? decision.note?.trim() : undefined;
  const replacesTeams = decision.kind !== "reject" && respondingTeams.length > 0;
  let assignees = replacesTeams
    ? previous.filter((id) => !respondingTeams.includes(id))
    : [...previous];
  const returnPath = assignmentReturnPath(
    task,
    previous.includes(access.userId) ? [access.userId] : respondingTeams,
  ).filter((id) => id !== access.userId);
  const returnedTo = decision.kind === "reject" ? returnPath[0] : undefined;
  if (decision.kind === "accept" && replacesTeams) {
    assignees = [...new Set([...assignees, access.userId])];
  }
  if (decision.kind === "reject" || decision.kind === "delegate") {
    assignees = assignees.filter((id) => id !== access.userId);
  }
  if (returnedTo) {
    assignees = [
      ...new Set([...(assignees.includes("all") ? [] : assignees), returnedTo]),
    ];
  }
  if (decision.kind === "delegate") {
    if (!canEditTask(task, access)) {
      throw new TaskAccessError(
        "You need view and edit permission to delegate this task.",
      );
    }
    if (
      !isTaskAssignees(decision.assignees) || !decision.assignees.length ||
      decision.assignees.includes("all")
    ) {
      throw new TaskCommandError("Choose one or more people or teams to delegate to.");
    }
    if (decision.assignees.includes(access.userId)) {
      throw new TaskCommandError("Choose another person or team to delegate to.");
    }
    if (assignees.includes("all")) assignees = [];
    assignees = [...new Set([...assignees, ...decision.assignees])];
  }
  const changesAssignments = decision.kind !== "accept" || replacesTeams;
  const next: Task = {
    ...task,
    assignmentResponses: {
      ...task.assignmentResponses,
      [access.userId]: {
        status: decision.kind === "accept"
          ? "accepted"
          : decision.kind === "reject"
          ? "rejected"
          : "delegated",
        ...(decision.kind === "delegate" ? { delegatedTo: decision.assignees } : {}),
        returnTo: returnPath,
      },
      ...Object.fromEntries(
        (decision.assignees ?? []).map((id) => [id, {
          status: "pending" as const,
          ...(note ? { note } : {}),
          returnTo: [...new Set([access.userId, ...returnPath])].filter((parent) =>
            parent !== id
          ),
        }]),
      ),
      ...(returnedTo
        ? {
          [returnedTo]: {
            status: "pending" as const,
            returnTo: returnPath.slice(1),
            returnedBy: access.userId,
          },
        }
        : {}),
    },
    assignees,
    ...(changesAssignments && !task.assignmentBased
      ? {
        assignmentBased: true,
        viewPerms: task.viewPerms ?? effectiveTaskViewPerms(task),
        editPerms: task.editPerms ?? effectiveTaskViewPerms(task),
      }
      : {}),
    ...(changesAssignments
      ? { teams: assignees.filter((id) => /^S/.test(id) || id === "all") }
      : {}),
    appliedEvents: [...task.appliedEvents ?? [], key],
    assignmentEvents: {
      ...task.assignmentEvents,
      [key]: returnedTo
        ? [returnedTo]
        : decision.kind === "delegate"
        ? assignees.filter((id) =>
          !task.assignees.includes(id) && !task.teams.includes(id)
        )
        : [],
    },
  };
  validate(next);
  await repository.save(next);
  return { task: next, updated: true };
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
              return task.assignees.includes(access.userId) ||
                [...task.assignees, ...task.teams].some((id) =>
                  /^S/.test(id) && access.teamIds.includes(id)
                );
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
