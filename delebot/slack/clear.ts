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
interface QueryArgs {
  datastore: string;
  limit: number;
  cursor?: string;
  expression?: string;
  expression_attributes?: Record<string, string>;
  expression_values?: Record<string, string>;
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
        args: QueryArgs,
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
}
/** Supply only a requester-owned user token; a bot token cannot delete user messages. */
export interface UserDeletionClient {
  auth: { test(): Promise<ApiResult & { user_id?: string }> };
  chat: ClearClient["chat"];
}
export interface ClearResult {
  deleted: number;
  failed: number;
  remaining: boolean;
  userMessagesRemaining: boolean;
}
interface HistoryMessage {
  ts: string;
  user?: string;
  reply_count?: number;
}
interface Target {
  ts: string;
  owner: "bot" | "user";
}
interface Thread {
  ts: string;
  cursor?: string;
  seen: string[];
  root?: Target;
}
interface ClearJob {
  version: 1;
  channel: string;
  userId: string;
  boundary: string;
  threadTs?: string;
  historyDone: boolean;
  historyCursor?: string;
  historySeen: string[];
  threads: Thread[];
  pending: Target[];
  cleanup: string[];
  userMessagesRemaining: boolean;
}
const timestamp = /^\d+\.\d{1,6}$/;
const BATCH_SIZE = 8;
const PAGE_SIZE = 40;
function time(ts: string): bigint {
  const [whole, fraction] = ts.split(".");
  return BigInt(whole + fraction.padEnd(6, "0"));
}
function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && timestamp.test(value);
}
function pageMessages(page: MessagePage): HistoryMessage[] {
  if (!page.ok || !Array.isArray(page.messages)) {
    throw new Error("Cannot read DM history.");
  }
  const result: HistoryMessage[] = [];
  for (const value of page.messages) {
    if (
      !value || typeof value !== "object" || !validTimestamp(value.ts) ||
      (value.user !== undefined && typeof value.user !== "string")
    ) throw new Error("Invalid DM history.");
    result.push(value);
  }
  if (page.has_more && !page.response_metadata?.next_cursor) {
    throw new Error("Incomplete DM history.");
  }
  return result;
}
function nextCursor(page: MessagePage, seen: string[]): string | undefined {
  const cursor = page.response_metadata?.next_cursor || undefined;
  if (cursor && seen.includes(cursor)) throw new Error("Repeated DM history cursor.");
  if (cursor) seen.push(cursor);
  return cursor;
}
function parseJob(
  value: unknown,
  channel: string,
  userId: string,
  threadTs?: string,
): ClearJob {
  if (!value || typeof value !== "object") throw new Error("Invalid clear progress.");
  const job = value as ClearJob;
  const validTarget = (candidate: unknown): candidate is Target => {
    if (!candidate || typeof candidate !== "object") return false;
    const target = candidate as Target;
    return validTimestamp(target.ts) && ["bot", "user"].includes(target.owner);
  };
  if (
    job.version !== 1 || job.channel !== channel || job.userId !== userId ||
    job.threadTs !== threadTs ||
    !validTimestamp(job.boundary) || typeof job.historyDone !== "boolean" ||
    typeof job.userMessagesRemaining !== "boolean" ||
    (job.historyCursor !== undefined && typeof job.historyCursor !== "string") ||
    !Array.isArray(job.historySeen) ||
    !job.historySeen.every((v) => typeof v === "string") ||
    !Array.isArray(job.threads) ||
    !job.threads.every((v) =>
      v && validTimestamp(v.ts) && Array.isArray(v.seen) &&
      v.seen.every((cursor) => typeof cursor === "string") &&
      (v.cursor === undefined || typeof v.cursor === "string") &&
      (v.root === undefined || validTarget(v.root))
    ) ||
    !Array.isArray(job.pending) ||
    !job.pending.every(validTarget) ||
    !Array.isArray(job.cleanup) || !job.cleanup.every(validTimestamp)
  ) throw new Error("Invalid clear progress.");
  return job;
}
async function grouped<T>(values: T[], work: (value: T) => Promise<void>) {
  for (let start = 0; start < values.length; start += 4) {
    const results = await Promise.allSettled(values.slice(start, start + 4).map(work));
    if (results.some((result) => result.status === "rejected")) {
      throw new Error("Message cleanup could not finish.");
    }
  }
}

/** Cleanup is scoped to deleted message IDs, never the entire workspace's history. */
async function cleanupMessages(
  client: ClearClient,
  channel: string,
  userId: string,
  removed: string[],
  threadTs?: string,
) {
  if (!removed.length) return;
  const values: Record<string, string> = { ":channel": `"channelId":"${channel}"` };
  for (const [index, ts] of removed.entries()) {
    values[`:message${index}`] = `"messageTs":"${ts}"`;
  }
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await client.apps.datastore.query({
      datastore: "assignment_notifications",
      limit: 100,
      expression: `contains(#state, :channel) AND (${
        removed.map((_, index) => `contains(#state, :message${index})`).join(" OR ")
      })`,
      expression_attributes: { "#state": "state" },
      expression_values: values,
      ...(cursor ? { cursor } : {}),
    });
    if (!page.ok || !Array.isArray(page.items)) {
      throw new Error("Cannot read invitation cleanup records.");
    }
    // Reuse the validated query rows; a network GET for every invitation caused
    // the previous clear command to exhaust the local function's time budget.
    const rows = new Map(page.items.map((row) => [row.id, row]));
    const store = new SlackNotificationStore({
      apps: {
        datastore: {
          get: ({ id }) => Promise.resolve({ ok: true, item: rows.get(id) }),
          put: (args) => client.apps.datastore.put(args),
        },
      },
    });
    const batches: NotificationBatch[] = [];
    for (const row of page.items) {
      if (typeof row.id !== "string") {
        throw new Error("Invalid invitation cleanup record.");
      }
      const batch = await store.get(row.id);
      if (!batch) continue;
      let changed = false;
      for (const invitation of Object.values(batch.invitations ?? {})) {
        if (
          invitation.channelId !== channel || invitation.recipientId !== userId ||
          !invitation.messageTs || !removed.includes(invitation.messageTs)
        ) continue;
        if (invitation.status === "pending") invitation.status = "cancelled";
        invitation.messageRemoved = true;
        batch.cancelled = [...new Set([...batch.cancelled, userId])];
        changed = true;
      }
      if (changed) batches.push(batch);
    }
    await grouped(batches, (batch) => store.save(batch));
    cursor = page.next_cursor || page.response_metadata?.next_cursor || undefined;
    if (cursor && seen.has(cursor)) {
      throw new Error("Repeated invitation cleanup cursor.");
    }
    if (cursor) seen.add(cursor);
  } while (cursor);
  const keys = new Set(removed.map((ts) => `${channel}:${ts}:${userId}`));
  if (threadTs) keys.add(`${channel}:${threadTs}:${userId}`);
  else keys.add(`${channel}:latest:${userId}`);
  const deletions = [
    ...removed.map((ts) => ({ datastore: "task_displays", id: `${channel}:${ts}` })),
    ...[...keys].map((id) => ({ datastore: "task_conversations", id })),
  ];
  await grouped(deletions, async (args) => {
    const result = await client.apps.datastore.delete(args);
    if (!result.ok && result.error !== "item_not_found") {
      throw new Error("Cannot remove cleared message context.");
    }
  });
}

/**
 * Clear a bounded batch and save progress before mutating Slack. Repeating clear
 * resumes the same snapshot, including across pages containing only user messages.
 * A supplied threadTs limits the operation to that DM thread. Tasks are untouched.
 */
export async function clearDmHistory(
  client: ClearClient,
  channel: string,
  userId: string,
  botUserId: string,
  boundary: string,
  threadTs?: string,
  userDeletionClient?: UserDeletionClient,
): Promise<ClearResult> {
  if (
    !/^D[A-Z0-9]+$/.test(channel) || !/^[UW][A-Z0-9]+$/.test(userId) ||
    !/^[UW][A-Z0-9]+$/.test(botUserId) || !validTimestamp(boundary) ||
    (threadTs !== undefined && !validTimestamp(threadTs))
  ) throw new Error("Clear requires a direct message.");
  if (userDeletionClient) {
    const identity = await userDeletionClient.auth.test();
    if (!identity.ok || identity.user_id !== userId) {
      throw new Error("User-message deletion must be authorized by this requester.");
    }
  }
  const id = `${channel}:clear-job:${userId}:${threadTs ?? "all"}`;
  const current = await client.apps.datastore.get({
    datastore: "task_conversations",
    id,
  });
  if (!current.ok) throw new Error("Cannot read clear progress.");
  const saved = current.item;
  let job: ClearJob;
  if (saved && Object.keys(saved).length) {
    if (
      saved.user_id !== userId || !Array.isArray(saved.task_ids) ||
      typeof saved.task_ids[0] !== "string"
    ) throw new Error("Invalid clear progress.");
    job = parseJob(JSON.parse(saved.task_ids[0]), channel, userId, threadTs);
  } else {job = {
      version: 1,
      channel,
      userId,
      boundary,
      ...(threadTs ? { threadTs } : {}),
      historyDone: !!threadTs,
      historySeen: [],
      threads: threadTs ? [{ ts: threadTs, seen: [] }] : [],
      pending: [],
      cleanup: [],
      userMessagesRemaining: false,
    };}
  const save = async () => {
    const result = await client.apps.datastore.put({
      datastore: "task_conversations",
      item: {
        id,
        user_id: userId,
        task_ids: [JSON.stringify(job)],
        message_kind: "clear-job",
      },
    });
    if (!result.ok) throw new Error("Cannot save clear progress.");
  };
  const result: ClearResult = {
    deleted: 0,
    failed: 0,
    remaining: true,
    userMessagesRemaining: job.userMessagesRemaining,
  };
  // Repair bookkeeping from a prior unconfirmed cleanup before new deletions.
  if (job.cleanup.length) {
    try {
      await cleanupMessages(client, channel, userId, job.cleanup, threadTs);
      job.cleanup = [];
    } catch {
      result.failed++;
      await save();
      return result;
    }
  }
  const target = (message: HistoryMessage): Target | undefined => {
    if (time(message.ts) > time(job.boundary)) return;
    if (message.user === botUserId) return { ts: message.ts, owner: "bot" };
    if (message.user === userId) {
      if (userDeletionClient) return { ts: message.ts, owner: "user" };
      job.userMessagesRemaining = true;
    }
  };
  const add = (value?: Target) => {
    if (value && !job.pending.some((item) => item.ts === value.ts)) {
      job.pending.push(value);
    }
  };
  // At most two read pages per call; do not traverse every thread before deleting.
  for (let pages = 0; pages < 2 && job.pending.length < BATCH_SIZE; pages++) {
    const thread = job.threads[0];
    if (thread) {
      const page = await client.conversations.replies({
        channel,
        ts: thread.ts,
        latest: job.boundary,
        inclusive: true,
        limit: PAGE_SIZE,
        ...(thread.cursor ? { cursor: thread.cursor } : {}),
      });
      for (const message of pageMessages(page)) {
        const candidate = target(message);
        if (message.ts === thread.ts) thread.root = candidate;
        else add(candidate);
      }
      thread.cursor = nextCursor(page, thread.seen);
      if (!thread.cursor) {
        add(thread.root);
        job.threads.shift();
      }
    } else if (!job.historyDone) {
      const page = await client.conversations.history({
        channel,
        latest: job.boundary,
        inclusive: true,
        limit: PAGE_SIZE,
        ...(job.historyCursor ? { cursor: job.historyCursor } : {}),
      });
      for (const message of pageMessages(page)) {
        const candidate = target(message);
        if (message.reply_count) {
          if (!job.threads.some((item) => item.ts === message.ts)) {
            job.threads.push({
              ts: message.ts,
              seen: [],
              ...(candidate ? { root: candidate } : {}),
            });
          }
        } else add(candidate);
      }
      job.historyCursor = nextCursor(page, job.historySeen);
      job.historyDone = !job.historyCursor;
    } else break;
  }
  await save();
  const batch = [...job.pending].sort((a, b) => time(a.ts) > time(b.ts) ? -1 : 1).slice(
    0,
    BATCH_SIZE,
  );
  const removed = new Set<string>();
  await Promise.all(batch.map(async (item) => {
    const deletion = item.owner === "user" ? userDeletionClient?.chat : client.chat;
    if (!deletion) {
      job.userMessagesRemaining = true;
      result.failed++;
      return;
    }
    try {
      const response = await deletion.delete({ channel, ts: item.ts });
      if (response.ok || response.error === "message_not_found") {
        removed.add(item.ts);
        if (response.ok) result.deleted++;
      } else result.failed++;
    } catch {
      result.failed++;
    }
  }));
  job.pending = job.pending.filter((item) => !removed.has(item.ts));
  job.cleanup = [...removed];
  await save();
  try {
    await cleanupMessages(client, channel, userId, job.cleanup, threadTs);
    job.cleanup = [];
  } catch {
    result.failed++;
  }
  result.remaining = !job.historyDone || !!job.threads.length || !!job.pending.length ||
    !!job.cleanup.length;
  result.userMessagesRemaining = job.userMessagesRemaining;
  if (result.remaining) await save();
  else {
    const deleted = await client.apps.datastore.delete({
      datastore: "task_conversations",
      id,
    });
    if (!deleted.ok) {
      result.failed++;
      result.remaining = true;
    }
  }
  return result;
}
