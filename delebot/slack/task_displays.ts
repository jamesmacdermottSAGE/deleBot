import { DefineDatastore, Schema } from "deno-slack-sdk/mod.ts";
import { canAccessTask } from "../tasks/access.ts";
import type { Task, TaskAccess } from "../tasks/models.ts";
import { formatTask, splitTaskReply } from "./messages.ts";
import type { SlackAPIClient } from "deno-slack-api/types.ts";
import { SlackTeamDirectory } from "./teams.ts";
import { resolveWorkspace } from "./workspace.ts";
import { taskReferencedTeamIds } from "../tasks/access.ts";
import {
  assignmentBlocks,
  type AssignmentInvitation,
  assignmentNotificationText,
  escapeNotificationText,
  type MessageBlocks,
  type NotificationBatch,
  SlackNotificationStore,
} from "./notifications.ts";

export function taskDisplays(client: SlackAPIClient): TaskDisplays {
  const directory = new SlackTeamDirectory(client);
  return new SlackTaskDisplays(client, async (task, userId, workspaceId) => {
    const direct = { userId, teamIds: [] as string[] };
    const references = taskReferencedTeamIds(task);
    if (!references.length) return direct;
    try {
      const workspace = workspaceId ?? await resolveWorkspace(client, task.channelId, {});
      const snapshot = await directory.load(userId, workspace, references);
      if (snapshot.access.userId !== userId) throw new Error("Incorrect task viewer.");
      return { ...snapshot.access, teamNames: snapshot.teamNames };
    } catch (error) {
      // An unavailable lookup does not mean a team member left. In particular,
      // public viewing access alone must never trigger invitation deletion.
      if (
        ![...task.assignees, ...task.teams].some((id) => /^S/.test(id)) &&
        canAccessTask(task, direct)
      ) return direct;
      throw error;
    }
  });
}

export const TaskDisplaysDatastore = DefineDatastore({
  name: "task_displays",
  primary_key: "id",
  attributes: {
    id: { type: Schema.types.string },
    task_id: { type: Schema.types.string },
    channel_id: { type: Schema.types.string },
    message_ts: { type: Schema.types.string },
    user_id: { type: Schema.types.string },
    part: { type: Schema.types.integer },
  },
});
export interface TaskDisplays {
  track(
    taskId: string,
    channel: string,
    ts: string,
    user: string,
    part?: number,
  ): Promise<void>;
  refresh(task: Task): Promise<number>;
}
interface Client {
  apps: {
    datastore: {
      get(
        args: { datastore: string; id: string },
      ): Promise<{ ok: boolean; item?: Record<string, unknown> }>;
      put(
        args: { datastore: string; item: Record<string, unknown> },
      ): Promise<{ ok: boolean }>;
      query(
        args: {
          datastore: string;
          expression: string;
          expression_attributes: Record<string, string>;
          expression_values: Record<string, string>;
          limit: number;
          cursor?: string;
        },
      ): Promise<
        {
          ok: boolean;
          items?: Record<string, unknown>[];
          next_cursor?: string;
          response_metadata?: { next_cursor?: string };
        }
      >;
    };
  };
  chat: {
    update(
      args: {
        channel: string;
        ts: string;
        text: string;
        blocks: MessageBlocks;
        unfurl_links: boolean;
        unfurl_media: boolean;
      },
    ): Promise<{ ok: boolean; error?: string }>;
    delete(
      args: { channel: string; ts: string },
    ): Promise<{ ok: boolean; error?: string }>;
  };
}
export class SlackTaskDisplays implements TaskDisplays {
  constructor(
    private client: Client,
    private loadAccess: (
      task: Task,
      user: string,
      workspaceId?: string,
    ) => Promise<TaskAccess & { teamNames?: Record<string, string> }>,
  ) {}
  async track(taskId: string, channel: string, ts: string, user: string, part = 0) {
    const result = await this.client.apps.datastore.put({
      datastore: TaskDisplaysDatastore.name,
      item: {
        id: `${channel}:${ts}`,
        task_id: taskId,
        channel_id: channel,
        message_ts: ts,
        user_id: user,
        part,
      },
    });
    if (!result.ok) throw new Error("Cannot track task message.");
  }
  async refresh(task: Task): Promise<number> {
    // Conversation context also references interactive invitations. Identify those
    // before recovering old cards, so card refreshes can never strip their controls.
    const invitations = new Map<
      string,
      { batch: NotificationBatch; invitation: AssignmentInvitation }
    >();
    const store = new SlackNotificationStore(this.client);
    const notificationCursors = new Set<string>();
    let notificationCursor: string | undefined;
    do {
      const page = await this.client.apps.datastore.query({
        datastore: "assignment_notifications",
        expression: "#task = :task",
        expression_attributes: { "#task": "task_id" },
        expression_values: { ":task": task.id },
        limit: 100,
        ...(notificationCursor ? { cursor: notificationCursor } : {}),
      });
      if (!page.ok || !Array.isArray(page.items)) {
        throw new Error("Cannot identify assignment invitations.");
      }
      for (const item of page.items) {
        if (typeof item.id !== "string") throw new Error("Invalid assignment record.");
        const batch = await store.get(item.id);
        if (!batch || batch.taskId !== task.id) continue;
        for (const invitation of Object.values(batch.invitations ?? {})) {
          if (invitation.channelId && invitation.messageTs) {
            invitations.set(`${invitation.channelId}:${invitation.messageTs}`, {
              batch,
              invitation,
            });
          }
        }
      }
      notificationCursor = page.next_cursor || page.response_metadata?.next_cursor ||
        undefined;
      if (notificationCursor && notificationCursors.has(notificationCursor)) {
        throw new Error("Repeated invitation cursor.");
      }
      if (notificationCursor) notificationCursors.add(notificationCursor);
    } while (notificationCursor);
    // Enterprise DM metadata may omit context_team_id. Delivery already saved
    // the verified source workspace; use it again when refreshing invitations.
    const workspaceId = [...invitations.values()].find(({ batch }) => batch.workspaceId)
      ?.batch.workspaceId;
    const rows: Record<string, unknown>[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.client.apps.datastore.query({
        datastore: TaskDisplaysDatastore.name,
        expression: "#task = :task",
        expression_attributes: { "#task": "task_id" },
        expression_values: { ":task": task.id },
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!page.ok || !Array.isArray(page.items)) {
        throw new Error("Cannot load displayed task messages.");
      }
      rows.push(...page.items);
      cursor = page.next_cursor || page.response_metadata?.next_cursor || undefined;
      if (cursor && cursors.has(cursor)) throw new Error("Repeated display cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    // Recover bot cards posted before display tracking was introduced. Context
    // timestamps also include human commands; Slack refuses edits to those.
    cursor = undefined;
    cursors.clear();
    do {
      const page = await this.client.apps.datastore.query({
        datastore: "task_conversations",
        expression: "contains(#tasks, :task)",
        expression_attributes: { "#tasks": "task_ids" },
        expression_values: { ":task": task.id },
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!page.ok || !Array.isArray(page.items)) {
        throw new Error("Cannot load earlier task contexts.");
      }
      for (const context of page.items) {
        if (context.message_kind !== undefined && context.message_kind !== "card") {
          continue;
        }
        if (
          typeof context.id !== "string" || !Array.isArray(context.task_ids) ||
          !context.task_ids.includes(task.id)
        ) continue;
        const match = /^([DG][A-Z0-9]+):(\d+\.\d+):([UW][A-Z0-9]+)$/.exec(context.id);
        if (
          !match || context.user_id !== match[3] ||
          rows.some((row) => row.channel_id === match[1] && row.message_ts === match[2])
        ) continue;
        rows.push({
          task_id: task.id,
          channel_id: match[1],
          message_ts: match[2],
          user_id: match[3],
          part: 0,
          legacy: true,
          combined: context.task_ids.length > 1,
        });
      }
      cursor = page.next_cursor || page.response_metadata?.next_cursor || undefined;
      if (cursor && cursors.has(cursor)) throw new Error("Repeated task context cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    let failed = 0;
    for (const row of rows) {
      if (invitations.has(`${row.channel_id}:${row.message_ts}`)) continue;
      if (
        row.task_id !== task.id || typeof row.channel_id !== "string" ||
        typeof row.message_ts !== "string" || typeof row.user_id !== "string" ||
        !Number.isInteger(row.part) || (row.part as number) < 0
      ) {
        failed++;
        continue;
      }
      try {
        const access = task.deleted
          ? undefined
          : await this.loadAccess(task, row.user_id, workspaceId);
        const visible = !!access && canAccessTask(task, access);
        const parts = visible ? splitTaskReply(formatTask(task, access?.teamNames)) : [];
        const text = row.combined
          ? "This task list has changed. Send ls again for current task cards."
          : parts[row.part as number];
        const result = text
          ? await this.client.chat.update({
            channel: row.channel_id,
            ts: row.message_ts,
            text,
            blocks: [],
            unfurl_links: false,
            unfurl_media: false,
          })
          : task.deleted
          ? await this.client.chat.update({
            channel: row.channel_id,
            ts: row.message_ts,
            text: "🗑️ Task deleted",
            blocks: [],
            unfurl_links: false,
            unfurl_media: false,
          })
          : await this.client.chat.delete({
            channel: row.channel_id,
            ts: row.message_ts,
          });
        const ignored = [
          "message_not_found",
          "message_not_modified",
          ...(row.legacy ? ["cant_update_message", "cant_delete_message"] : []),
        ];
        if (!result.ok && !ignored.includes(result.error ?? "")) failed++;
        if (result.ok && row.legacy && !row.combined && visible && text) {
          await this.track(
            task.id,
            row.channel_id,
            row.message_ts,
            row.user_id,
            row.part as number,
          );
        }
      } catch {
        failed++;
      }
    }
    for (const { batch, invitation } of invitations.values()) {
      if (invitation.status !== "pending" || invitation.messageRemoved) continue;
      try {
        const access = await this.loadAccess(
          task,
          invitation.recipientId,
          batch.workspaceId,
        );
        const assigned = task.assignees.includes(invitation.recipientId) ||
          task.assignees.some((id) => /^S/.test(id) && access.teamIds.includes(id));
        if (task.deleted || !canAccessTask(task, access) || !assigned) {
          const result = await this.client.chat.delete({
            channel: invitation.channelId!,
            ts: invitation.messageTs!,
          });
          if (!result.ok && result.error !== "message_not_found") failed++;
          continue;
        }
        // Also repairs invitations whose blocks were removed by the previous
        // refresh implementation, retaining their original recipient binding.
        const returnedBy = invitation.returnedBy ??
          task.assignmentResponses?.[invitation.recipientId]?.returnedBy;
        const note = invitation.note ??
          task.assignmentResponses?.[invitation.recipientId]?.note;
        const text = returnedBy
          ? assignmentNotificationText(task, invitation.recipientId, invitation)
          : formatTask(task, access.teamNames) +
            (note?.trim() ? `\n\n*Note:* ${escapeNotificationText(note.trim())}` : "");
        const result = await this.client.chat.update({
          channel: invitation.channelId!,
          ts: invitation.messageTs!,
          text,
          blocks: assignmentBlocks(text, batch, invitation),
          unfurl_links: false,
          unfurl_media: false,
        });
        if (!result.ok && result.error !== "message_not_modified") failed++;
      } catch {
        failed++;
      }
    }
    return failed;
  }
}
