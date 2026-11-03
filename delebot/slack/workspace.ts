import { TeamLookupError } from "./teams.ts";

export interface WorkspaceClient {
  conversations: {
    info(args: { channel: string }): Promise<{
      ok: boolean;
      error?: string;
      channel?: { context_team_id?: string };
    }>;
  };
}

/** Resolve the conversation's workspace, rather than the enterprise installation ID. */
export async function resolveWorkspace(
  client: WorkspaceClient,
  channelId: string,
  sender: { team_id?: string; enterprise_user?: { teams?: string[] } },
): Promise<string> {
  const conversation = await client.conversations.info({ channel: channelId });
  const context = conversation.channel?.context_team_id;
  if (conversation.ok && context && /^T[A-Z0-9]+$/.test(context)) return context;
  // A profile can still identify a workspace on installations where conversation
  // metadata is unavailable. Never guess between several enterprise workspaces.
  if (sender.team_id && /^T[A-Z0-9]+$/.test(sender.team_id)) return sender.team_id;
  const teams = [...new Set(sender.enterprise_user?.teams ?? [])]
    .filter((id) => /^T[A-Z0-9]+$/.test(id));
  if (teams.length === 1) return teams[0];
  throw new TeamLookupError(
    conversation.error === "missing_scope"
      ? "workspace_read_missing_scope"
      : "workspace_context_unavailable",
  );
}
