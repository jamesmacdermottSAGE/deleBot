import type { Task, TaskAccess } from "./models.ts";

export function isTaskAssignees(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((id) => typeof id === "string" && /^(all|[UWS][A-Z0-9]+)$/.test(id)) &&
    (!value.includes("all") || value.length === 1);
}

export function isPublicTask(
  task: Pick<Task, "teams" | "assignees" | "assignmentBased">,
): boolean {
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

/** New tasks allow their creator and assignees; legacy tasks retain their team policy. */
export function canAccessTask(
  task:
    & Pick<Task, "teams" | "createdBy">
    & Partial<Pick<Task, "assignees" | "assignmentBased" | "deleted">>,
  access: TaskAccess,
): boolean {
  if (
    task.deleted || !access || typeof access.userId !== "string" || !access.userId ||
    !Array.isArray(access.teamIds)
  ) return false;
  if (task.assignmentBased) {
    if (!isTaskAssignees(task.assignees)) return false;
    if (task.createdBy === access.userId) return true;
    if (task.assignees.includes("all")) return task.assignees.length === 1;
    return task.assignees.some((id) =>
      id === access.userId ||
      (/^S/.test(id) && access.teamIds.includes(id))
    );
  }
  const teams = task.teams;
  if (teams === undefined || (Array.isArray(teams) && teams.length === 0)) {
    return task.createdBy === access.userId;
  }
  if (!isTaskTeams(teams)) return false;
  return teams[0] === "all" || teams.some((team) => access.teamIds.includes(team));
}
