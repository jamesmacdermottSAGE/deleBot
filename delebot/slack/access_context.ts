import { canAccessTask, taskReferencedTeamIds } from "../tasks/access.ts";
import type { Task, TaskAccess } from "../tasks/models.ts";
import { SlackTeamDirectory, type TeamClient, type TeamSnapshot } from "./teams.ts";
import { resolveWorkspace, type WorkspaceClient } from "./workspace.ts";

/** Cache verified membership only for one incoming command or interaction. */
export function taskAccessLoader(client: TeamClient & WorkspaceClient) {
  const directory = new SlackTeamDirectory(client);
  const snapshots = new Map<string, Promise<TeamSnapshot>>();
  const workspaces = new Map<string, Promise<string>>();
  return async (
    task: Task,
    userId: string,
    workspaceId?: string,
  ): Promise<TaskAccess & { teamNames?: Record<string, string> }> => {
    const direct = { userId, teamIds: [] as string[] };
    const references = taskReferencedTeamIds(task);
    if (!references.length) return direct;
    try {
      let workspace = workspaceId;
      if (!workspace) {
        if (!workspaces.has(task.channelId)) {
          workspaces.set(task.channelId, resolveWorkspace(client, task.channelId, {}));
        }
        workspace = await workspaces.get(task.channelId)!;
      }
      const key = `${workspace}:${references.sort().join(",")}`;
      if (!snapshots.has(key)) {
        snapshots.set(key, directory.load(userId, workspace, references));
      }
      const snapshot = await snapshots.get(key)!;
      const teamIds = Object.entries(snapshot.teamMembers ?? {}).filter(([, members]) =>
        members.includes(userId)
      ).map(([id]) => id);
      return { userId, teamIds, teamNames: snapshot.teamNames };
    } catch (error) {
      if (
        ![...task.assignees, ...task.teams].some((id) => /^S/.test(id)) &&
        canAccessTask(task, direct)
      ) return direct;
      throw error;
    }
  };
}
