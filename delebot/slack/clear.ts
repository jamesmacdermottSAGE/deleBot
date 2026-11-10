import { type NotificationBatch, SlackNotificationStore } from "./notifications.ts";

interface ApiResult {
  ok: boolean;
  error?: string;
}
interface MessagePage extends ApiResult {
  messages?: unknown;
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}
export interface ClearClient {
  conversations: {
    history(
      args: {
        channel: string;
        latest: string;
        inclusive: boolean;
        limit: number;
        cursor?: string;
      },
    ): Promise<MessagePage>;
    replies(
      args: {
        channel: string;
        ts: string;
        latest: string;
        inclusive: boolean;
        limit: number;
        cursor?: string;
      },
    ): Promise<MessagePage>;
  };
  chat: { delete(args: { channel: string; ts: string }): Promise<ApiResult> };
  apps: {
    datastore: {
      query(
        args: { datastore: string; limit: number; cursor?: string },
      ): Promise<
        ApiResult & {
          items?: Record<string, unknown>[];
          next_cursor?: string;
          response_metadata?: { next_cursor?: string };
        }
      >;
      get(
        args: { datastore: string; id: string },
      ): Promise<ApiResult & { item?: Record<string, unknown> }>;
      put(args: { datastore: string; item: Record<string, unknown> }): Promise<ApiResult>;
      delete(args: { datastore: string; id: string }): Promise<ApiResult>;
    };
  };
  functions?: {
    completeSuccess(
      args: { function_execution_id: string; outputs: { ignored: boolean } },
    ): Promise<ApiResult>;
  };
}

interface HistoryMessage {
  ts: string;
  user?: string;
  reply_count?: number;
}
const timestamp = /^\d+\.\d{1,6}$/;
function before(value: string, boundary: string): boolean {
  const parts = (ts: string) => {
    const [whole, fraction] = ts.split(".");
    return BigInt(whole + fraction.padEnd(6, "0"));
  };
  return parts(value) < parts(boundary);
}

async function messages(
  load: (cursor?: string) => Promise<MessagePage>,
): Promise<HistoryMessage[]> {
  const result: HistoryMessage[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    if (!page.ok || !Array.isArray(page.messages)) {
      throw new Error("Cannot read DM history.");
    }
    for (const message of page.messages) {
      if (
        !message || typeof message !== "object" || typeof message.ts !== "string" ||
        !timestamp.test(message.ts)
      ) throw new Error("Invalid DM history.");
      result.push(message);
    }
    cursor = page.response_metadata?.next_cursor || undefined;
    if ((page.has_more && !cursor) || (cursor && cursors.has(cursor))) {
      throw new Error("Incomplete DM history.");
    }
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return result;
}

async function records(
  client: ClearClient,
  datastore: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.apps.datastore.query({
      datastore,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    if (!page.ok || !Array.isArray(page.items)) {
      throw new Error("Cannot read message records.");
    }
    rows.push(...page.items);
    cursor = page.next_cursor || page.response_metadata?.next_cursor || undefined;
    if (cursor && cursors.has(cursor)) throw new Error("Repeated message cursor.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return rows;
}

/** Clear only this bot's messages in the requesting person's DM, including threads. */
export async function clearDmHistory(
  client: ClearClient,
  channel: string,
  userId: string,
  botUserId: string,
  boundary: string,
): Promise<{ deleted: number; failed: number }> {
  if (
    !/^D[A-Z0-9]+$/.test(channel) || !/^[UW][A-Z0-9]+$/.test(userId) ||
    !/^[UW][A-Z0-9]+$/.test(botUserId) || !timestamp.test(boundary)
  ) throw new Error("Clear requires a direct message.");
  const history = await messages((cursor) =>
    client.conversations.history({
      channel,
      latest: boundary,
      inclusive: false,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    })
  );
  const targets = new Set<string>();
  const collect = (items: HistoryMessage[]) => {
    for (const message of items) {
      if (message.user === botUserId && before(message.ts, boundary)) {
        targets.add(message.ts);
      }
    }
  };
  collect(history);
  for (const root of history) {
    if (!root.reply_count) continue;
    collect(
      await messages((cursor) =>
        client.conversations.replies({
          channel,
          ts: root.ts,
          latest: boundary,
          inclusive: false,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        })
      ),
    );
  }
  // Read bookkeeping before deleting, so a partial read never clears only part of a DM.
  const displays = await records(client, "task_displays");
  const contexts = await records(client, "task_conversations");
  const store = new SlackNotificationStore(client);
  const batches: NotificationBatch[] = [];
  for (const row of await records(client, "assignment_notifications")) {
    if (typeof row.id !== "string") throw new Error("Invalid invitation record.");
    const batch = await store.get(row.id);
    if (!batch) throw new Error("Missing invitation record.");
    batches.push(batch);
  }
  const ownDisplays = displays.filter((row) =>
    row.channel_id === channel && row.user_id === userId &&
    typeof row.message_ts === "string" && timestamp.test(row.message_ts) &&
    before(row.message_ts, boundary)
  );
  for (const row of ownDisplays) targets.add(row.message_ts as string);
  for (const batch of batches) {
    for (const invitation of Object.values(batch.invitations ?? {})) {
      if (
        invitation.channelId === channel && invitation.recipientId === userId &&
        invitation.messageTs && before(invitation.messageTs, boundary) &&
        !invitation.messageRemoved
      ) {
        targets.add(invitation.messageTs);
      }
    }
  }
  let deleted = 0;
  let failed = 0;
  const removed = new Set<string>();
  // Replies have newer timestamps than their parents; delete them first.
  for (const ts of [...targets].sort((a, b) => before(a, b) ? 1 : -1)) {
    try {
      const result = await client.chat.delete({ channel, ts });
      if (result.ok || result.error === "message_not_found") {
        removed.add(ts);
        if (result.ok) deleted++;
      } else failed++;
    } catch {
      failed++;
    }
  }
  const affectedExecutions = new Set<string>();
  for (const batch of batches) {
    let changed = false;
    for (const invitation of Object.values(batch.invitations ?? {})) {
      if (
        invitation.channelId !== channel || invitation.recipientId !== userId ||
        !invitation.messageTs || !before(invitation.messageTs, boundary)
      ) continue;
      if (!removed.has(invitation.messageTs) && !invitation.messageRemoved) continue;
      if (invitation.status === "pending") invitation.status = "cancelled";
      invitation.messageRemoved = true;
      batch.cancelled = [...new Set([...batch.cancelled, userId])];
      affectedExecutions.add(invitation.executionId);
      changed = true;
    }
    if (changed) {
      try {
        await store.save(batch);
      } catch {
        failed++;
      }
    }
  }
  for (
    const [datastore, rows] of [["task_displays", ownDisplays], [
      "task_conversations",
      contexts.filter((row) =>
        row.user_id === userId && typeof row.id === "string" &&
        row.id.startsWith(`${channel}:`)
      ),
    ]] as const
  ) {
    for (const row of rows) {
      if (datastore === "task_displays" && !removed.has(row.message_ts as string)) {
        continue;
      }
      try {
        if (
          typeof row.id !== "string" ||
          !(await client.apps.datastore.delete({ datastore, id: row.id })).ok
        ) failed++;
      } catch {
        failed++;
      }
    }
  }
  if (!failed && client.functions) {
    for (const executionId of affectedExecutions) {
      if (
        batches.some((batch) => batch.completedExecutions?.includes(executionId))
      ) continue;
      if (
        batches.some((batch) =>
          Object.values(batch.invitations ?? {}).some((invitation) =>
            invitation.executionId === executionId && invitation.status === "pending" &&
            !invitation.messageRemoved
          )
        )
      ) continue;
      try {
        const result = await client.functions.completeSuccess({
          function_execution_id: executionId,
          outputs: { ignored: false },
        });
        if (!result.ok) {
          failed++;
          continue;
        }
        const batch = batches.find((batch) =>
          Object.values(batch.invitations ?? {}).some((invitation) =>
            invitation.executionId === executionId
          )
        )!;
        batch.completedExecutions = [
          ...new Set([...batch.completedExecutions ?? [], executionId]),
        ];
        await store.save(batch);
      } catch {
        failed++;
      }
    }
  }
  return { deleted, failed };
}
