import type { Task, TaskAccess } from "./models.ts";

export function isTaskAssignees(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((id) => typeof id === "string" && /^(all|[UWS][A-Z0-9]+)$/.test(id)) &&
    (!value.includes("all") || value.length === 1);
}

export const isTaskPermissions = isTaskAssignees;

export function isPublicTask(
  task: Pick<Task, "teams" | "assignees" | "assignmentBased" | "viewPerms">,
): boolean {
  if (task.viewPerms !== undefined) {
    return isTaskAssignees(task.viewPerms) && task.viewPerms.length === 1 &&
      task.viewPerms[0] === "all";
  }
  return task.assignmentBased
    ? task.assignees.length === 1 && task.assignees[0] === "all"
    : task.teams.length === 1 && task.teams[0] === "all";
}

/** Empty teams also support user-only and unassigned tasks; malformed policies fail closed. */
export function isTaskTeams(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 1 && value[0] === "all") return true;
  return value.every((team) => typeof team === "string" && /^S[A-Z0-9]+$/.test(team));
}

type AccessTask =
  & Pick<Task, "teams" | "createdBy">
  & Partial<
    Pick<Task, "assignees" | "assignmentBased" | "deleted" | "viewPerms" | "editPerms">
  >;

function validAccess(access: TaskAccess): boolean {
  return !!access && typeof access.userId === "string" && !!access.userId &&
    Array.isArray(access.teamIds);
}

function matches(policy: unknown, access: TaskAccess): boolean {
  return isTaskAssignees(policy) &&
    policy.some((id) =>
      id === "all" || id === access.userId ||
      (/^S/.test(id) && access.teamIds.includes(id))
    );
}

/** The legacy policy is retained until that specific permission is configured. */
export function effectiveTaskViewPerms(task: AccessTask): string[] {
  if (task.deleted) return [];
  if (task.viewPerms !== undefined) {
    return isTaskAssignees(task.viewPerms) ? [...task.viewPerms] : [];
  }
  if (task.assignmentBased) {
    if (!isTaskAssignees(task.assignees)) return [];
    if (task.assignees.includes("all")) return ["all"];
    return [...new Set([task.createdBy, ...task.assignees])];
  }
  if (task.teams === undefined || (Array.isArray(task.teams) && !task.teams.length)) {
    return [task.createdBy];
  }
  return isTaskTeams(task.teams) ? [...task.teams] : [];
}

/** Explicit permissions do not grant implicit access to creators or assignees. */
export function canAccessTask(task: AccessTask, access: TaskAccess): boolean {
  if (task.deleted || !validAccess(access)) return false;
  return matches(effectiveTaskViewPerms(task), access);
}

export const canViewTask = canAccessTask;

export function canEditTask(task: AccessTask, access: TaskAccess): boolean {
  if (!canAccessTask(task, access)) return false;
  if (task.editPerms !== undefined) return matches(task.editPerms, access);
  // View configuration does not broaden an unchanged legacy editing policy.
  return matches(effectiveTaskViewPerms({ ...task, viewPerms: undefined }), access);
}

/** Group discovery must include permission principals as well as assignees. */
export function taskReferencedTeamIds(
  task: Partial<Pick<Task, "teams" | "assignees" | "viewPerms" | "editPerms">>,
): string[] {
  return [
    ...new Set(
      [
        task.teams,
        task.assignees,
        task.viewPerms,
        task.editPerms,
      ].flatMap((ids) => Array.isArray(ids) ? ids : []).filter((id) =>
        typeof id === "string" && /^S[A-Z0-9]+$/.test(id)
      ),
    ),
  ];
}
