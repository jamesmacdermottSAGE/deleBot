import type { TaskAccess } from "../tasks/models.ts";

export interface TeamSnapshot {
  access: TaskAccess;
  /** Active Slack user groups that can be selected when creating a task. */
  knownTeamIds: string[];
  teamNames: Record<string, string>;
  disabledTeamIds?: string[];
}

export interface TeamDirectory {
  load(
    userId: string,
    workspaceId?: string,
    referencedTeams?: string[],
  ): Promise<TeamSnapshot>;
}

/** usergroups.list includes complete membership when include_users is true. */
export interface TeamClient {
  usergroups: {
    users: {
      list(
        args: { usergroup: string; team_id?: string; include_disabled: boolean },
      ): Promise<{
        ok: boolean;
        error?: string;
        users?: unknown;
      }>;
    };
    list(args: {
      include_users: boolean;
      include_count: boolean;
      include_disabled: boolean;
      team_id?: string;
    }): Promise<{ ok: boolean; error?: string; usergroups?: unknown }>;
  };
}

export class TeamLookupError extends Error {
  constructor(readonly code: string) {
    super(`Cannot verify team membership: ${code}`);
  }
}

export function membershipHelp(error: unknown): string {
  if (!(error instanceof TeamLookupError)) return "Please try again shortly.";
  if (error.code === "workspace_read_missing_scope") {
    return "Restart slack run and approve the channel-reading permissions (channels:read and groups:read).";
  }
  if (error.code === "workspace_context_unavailable") {
    return "Slack did not identify this channel's workspace. Check the app's channel-reading permissions.";
  }
  if (error.code === "missing_scope") {
    return "Refresh the app installation to grant usergroups:read.";
  }
  if (
    ["invalid_team", "missing_argument", "enterprise_is_restricted"].includes(error.code)
  ) {
    return "Slack needs the workspace context for this enterprise installation.";
  }
  if (error.code === "ratelimited") {
    return "Slack is limiting membership requests; please try again shortly.";
  }
  return `Slack reported ${
    /^[a-z_]+$/.test(error.code) ? error.code : "a membership error"
  }.`;
}

function incomplete(): never {
  throw new Error("Slack returned incomplete team membership data. Please try again.");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function userId(value: unknown): value is string {
  return typeof value === "string" && /^[UW][A-Z0-9]+$/.test(value);
}

function memberCount(value: unknown): number {
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) {
    value = Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return incomplete();
  }
  return value;
}

/** Membership is freshly loaded for every command; API failures never grant access. */
export class SlackTeamDirectory implements TeamDirectory {
  constructor(private readonly client: TeamClient) {}

  async load(
    requesterId: string,
    workspaceId?: string,
    referencedTeams: string[] = [],
  ): Promise<TeamSnapshot> {
    if (!userId(requesterId)) throw new Error("Cannot verify an invalid Slack user.");
    const result = await this.client.usergroups.list({
      include_users: true,
      include_count: true,
      include_disabled: false,
      ...(workspaceId && /^T[A-Z0-9]+$/.test(workspaceId)
        ? { team_id: workspaceId }
        : {}),
    });
    if (!result.ok) {
      throw new TeamLookupError(result.error ?? "unknown_error");
    }
    if (!Array.isArray(result.usergroups)) return incomplete();

    const knownTeamIds: string[] = [];
    const teamIds: string[] = [];
    const teamNames: Record<string, string> = {};
    const seen = new Set<string>();
    const excluded = new Set<string>();
    for (const group of result.usergroups) {
      if (!record(group)) return incomplete();
      if (
        typeof group.id !== "string" || !/^S[A-Z0-9]+$/.test(group.id) ||
        typeof group.date_delete !== "number" ||
        !Number.isSafeInteger(group.date_delete) || group.date_delete < 0
      ) return incomplete();
      // Sidebar sections are not task teams. Slack normally omits them here.
      if (group.date_delete !== 0) {
        excluded.add(group.id);
        if (typeof group.enterprise_subteam_id === "string") {
          excluded.add(group.enterprise_subteam_id);
        }
        continue;
      }
      // Section/type flags alone do not establish whether this ID is usable as
      // a team. For explicitly referenced IDs, ask the membership API below.
      if (
        group.is_section === true ||
        (group.is_usergroup === false && group.is_subteam !== true)
      ) continue;
      // Enterprise mentions may use enterprise_subteam_id while the workspace
      // API returns a local id. Both identify this same verified membership.
      const ids = [
        ...new Set([
          group.id,
          ...(typeof group.enterprise_subteam_id === "string" &&
              /^S[A-Z0-9]+$/.test(group.enterprise_subteam_id)
            ? [group.enterprise_subteam_id]
            : []),
        ]),
      ];
      if (ids.some((id) => seen.has(id))) return incomplete();
      for (const id of ids) seen.add(id);

      if (!Array.isArray(group.users) || !group.users.every(userId)) return incomplete();
      const users = new Set(group.users);
      if (users.size !== group.users.length) return incomplete();
      if (
        group.user_count !== undefined && memberCount(group.user_count) !== users.size
      ) return incomplete();

      const name = typeof group.handle === "string" && group.handle.trim()
        ? group.handle.trim()
        : typeof group.name === "string" && group.name.trim()
        ? group.name.trim()
        : group.id;
      for (const id of ids) {
        knownTeamIds.push(id);
        teamNames[id] = name;
        if (users.has(requesterId)) teamIds.push(id);
      }
    }
    for (const id of new Set(referencedTeams)) {
      if (knownTeamIds.includes(id) || excluded.has(id) || id === "all") continue;
      if (!/^S[A-Z0-9]+$/.test(id)) return incomplete();
      const membership = await this.client.usergroups.users.list({
        usergroup: id,
        include_disabled: false,
        ...(workspaceId && /^T[A-Z0-9]+$/.test(workspaceId)
          ? { team_id: workspaceId }
          : {}),
      });
      if (!membership.ok) {
        console.warn(
          JSON.stringify({
            event: "direct_team_lookup_failed",
            team_id: id,
            workspace_id: workspaceId,
            error: membership.error,
          }),
        );
        if (
          ["usergroup_not_found", "subteam_not_found", "invalid_usergroup"].includes(
            membership.error ?? "",
          )
        ) continue;
        throw new TeamLookupError(membership.error ?? "unknown_error");
      }
      if (!Array.isArray(membership.users) || !membership.users.every(userId)) {
        return incomplete();
      }
      knownTeamIds.push(id);
      if (membership.users.includes(requesterId)) teamIds.push(id);
    }
    if (!knownTeamIds.length && workspaceId) {
      // Enough metadata to distinguish an empty API result from filtered groups;
      // never include members, credentials, or task text in diagnostics.
      console.warn(JSON.stringify({
        event: "workspace_groups_empty",
        workspace_id: workspaceId,
        returned_groups: result.usergroups.map((group) => {
          const row = group as Record<string, unknown>;
          return {
            id: row.id,
            is_usergroup: row.is_usergroup,
            is_subteam: row.is_subteam,
            is_section: row.is_section,
            date_delete: row.date_delete,
          };
        }),
      }));
    }
    return {
      access: { userId: requesterId, teamIds },
      knownTeamIds,
      teamNames,
      disabledTeamIds: [...excluded],
    };
  }
}
