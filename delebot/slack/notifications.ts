import { DefineDatastore, Schema } from "deno-slack-sdk/mod.ts";
import type { Task } from "../tasks/models.ts";

export type NotificationTask = Pick<
  Task,
  "id" | "name" | "number" | "assignees" | "channelId" | "messageTs"
>;

/** Delivery bookkeeping contains IDs only; task contents stay in the task datastore. */
export const AssignmentNotificationsDatastore = DefineDatastore({
  name: "assignment_notifications",
  primary_key: "id",
  attributes: {
    id: { type: Schema.types.string },
    task_id: { type: Schema.types.string },
    event_key: { type: Schema.types.string },
    state: { type: Schema.types.string },
  },
});

export interface NotificationBatch {
  id: string;
  taskId: string;
  eventKey: string;
  assigned: string[];
  recipients: string[];
  delivered: string[];
  cancelled: string[];
  resolvedGroups: string[];
}

export interface NotificationStore {
  get(id: string): Promise<NotificationBatch | null>;
  save(batch: NotificationBatch): Promise<void>;
}

interface ApiResult {
  ok: boolean;
  error?: string;
}

export interface NotificationClient {
  conversations: {
    open(args: { users: string }): Promise<ApiResult & { channel?: { id?: string } }>;
  };
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      unfurl_links: boolean;
      unfurl_media: boolean;
    }): Promise<ApiResult & { ts?: string }>;
    getPermalink?(args: { channel: string; message_ts: string }): Promise<
      ApiResult & { permalink?: string }
    >;
  };
  usergroups: {
    users: {
      list(args: {
        usergroup: string;
        include_disabled: boolean;
        team_id?: string;
      }): Promise<ApiResult & { users?: unknown }>;
    };
  };
}

interface NotificationDatastoreClient {
  apps: {
    datastore: {
      get(args: { datastore: string; id: string }): Promise<
        ApiResult & { item?: Record<string, unknown> }
      >;
      put(args: { datastore: string; item: Record<string, unknown> }): Promise<ApiResult>;
    };
  };
}

function strings(value: unknown, pattern: RegExp): value is string[] {
  return Array.isArray(value) &&
    value.every((id) => typeof id === "string" && pattern.test(id)) &&
    new Set(value).size === value.length;
}

function validateBatch(value: unknown, expectedId: string): NotificationBatch {
  if (!value || typeof value !== "object") throw new Error("Invalid notification state.");
  const batch = value as Record<string, unknown>;
  if (
    batch.id !== expectedId || typeof batch.taskId !== "string" || !batch.taskId ||
    typeof batch.eventKey !== "string" || !batch.eventKey ||
    batch.id !== `${batch.taskId}:${batch.eventKey}` ||
    !strings(batch.assigned, /^[UWS][A-Z0-9]+$/) ||
    !strings(batch.recipients, /^[UW][A-Z0-9]+$/) ||
    !strings(batch.delivered, /^[UW][A-Z0-9]+$/) ||
    !strings(batch.cancelled, /^[UW][A-Z0-9]+$/) ||
    !strings(batch.resolvedGroups, /^S[A-Z0-9]+$/)
  ) throw new Error("Invalid notification state.");
  const recipients = batch.recipients;
  const assigned = batch.assigned;
  if (
    !batch.delivered.every((id) => recipients.includes(id)) ||
    !batch.cancelled.every((id) => recipients.includes(id)) ||
    !batch.resolvedGroups.every((id) => assigned.includes(id))
  ) {
    throw new Error("Invalid notification state.");
  }
  return structuredClone(batch) as unknown as NotificationBatch;
}

/** Safe retries depend on retaining delivery state; invalid state must never be ignored. */
export class SlackNotificationStore implements NotificationStore {
  constructor(private readonly client: NotificationDatastoreClient) {}

  async get(id: string): Promise<NotificationBatch | null> {
    const result = await this.client.apps.datastore.get({
      datastore: AssignmentNotificationsDatastore.name,
      id,
    });
    if (!result.ok) throw new Error("Cannot read assignment notification state.");
    if (!result.item || Object.keys(result.item).length === 0) return null;
    const item = result.item;
    if (item.id !== id || typeof item.state !== "string") {
      throw new Error("Invalid notification state.");
    }
    const state = JSON.parse(item.state);
    return validateBatch({
      ...state,
      id: item.id,
      taskId: item.task_id,
      eventKey: item.event_key,
    }, id);
  }

  async save(batch: NotificationBatch): Promise<void> {
    const valid = validateBatch(batch, batch.id);
    const { id, taskId, eventKey, ...state } = valid;
    const result = await this.client.apps.datastore.put({
      datastore: AssignmentNotificationsDatastore.name,
      item: { id, task_id: taskId, event_key: eventKey, state: JSON.stringify(state) },
    });
    if (!result.ok) throw new Error("Cannot save assignment notification state.");
  }
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function notificationText(
  task: NotificationTask,
  client: NotificationClient,
): Promise<string> {
  let source = /^[CDG][A-Z0-9]+$/.test(task.channelId)
    ? `<#${task.channelId}>`
    : "the task thread";
  if (client.chat.getPermalink) {
    try {
      const link = await client.chat.getPermalink({
        channel: task.channelId,
        message_ts: task.messageTs,
      });
      if (link.ok && link.permalink && /^https:\/\//.test(link.permalink)) {
        const url = link.permalink.replaceAll("|", "%7C").replaceAll("<", "%3C")
          .replaceAll(">", "%3E");
        source = `<${escape(url)}|Open task thread>`;
      }
    } catch {
      // A missing source link must not block assignment delivery.
    }
  }
  return [
    `You have been assigned task *#${task.number}: ${escape(task.name)}*.`,
    `Source: ${source}`,
    `To mark it complete, reply in its thread with \`@DeleBot done\`, or use \`@DeleBot ${task.number} done\`.`,
  ].join("\n");
}

/**
 * Notify only newly assigned targets, with delivery persisted per task/event.
 * A repeated event may pass []: its saved outbox is resumed. Group recipients
 * are deduplicated and current membership is rechecked before pending DMs.
 *
 * Slack cannot atomically send a DM and persist its delivery marker. If a send
 * succeeds but saving the marker fails (or concurrent duplicate workflows run),
 * a retry can duplicate that notification; no exactly-once guarantee is claimed.
 */
export async function notifyAssignments(
  task: NotificationTask,
  assigned: string[],
  eventKey: string,
  workspaceId: string | undefined,
  client: NotificationClient,
  store: NotificationStore,
): Promise<{ failed: string[] }> {
  const id = `${task.id}:${eventKey}`;
  let batch: NotificationBatch;
  try {
    const saved = await store.get(id);
    if (saved) {
      batch = validateBatch(saved, id);
      if (batch.taskId !== task.id || batch.eventKey !== eventKey) {
        return { failed: ["delivery_state"] };
      }
    } else {
      const targets = [...new Set(assigned.filter((target) => target !== "all"))];
      if (!targets.length) return { failed: [] };
      if (!strings(targets, /^[UWS][A-Z0-9]+$/)) {
        return { failed: ["assignment_targets"] };
      }
      batch = {
        id,
        taskId: task.id,
        eventKey,
        assigned: targets,
        recipients: targets.filter((target) => /^[UW]/.test(target)),
        delivered: [],
        cancelled: [],
        resolvedGroups: [],
      };
      await store.save(batch);
    }
  } catch {
    return { failed: ["delivery_state"] };
  }

  const unresolvedGroup = batch.assigned.some((target) =>
    /^S/.test(target) &&
    task.assignees.includes(target) && !batch.resolvedGroups.includes(target)
  );
  if (
    !unresolvedGroup &&
    batch.recipients.every((recipient) =>
      batch.delivered.includes(recipient) || batch.cancelled.includes(recipient)
    )
  ) {
    return { failed: [] };
  }

  const failed = new Set<string>();
  const eligible = new Set<string>();
  const activeTargets = batch.assigned.filter((target) =>
    task.assignees.includes(target)
  );
  for (const target of activeTargets) {
    if (/^[UW]/.test(target)) {
      eligible.add(target);
      continue;
    }
    try {
      const response = await client.usergroups.users.list({
        usergroup: target,
        include_disabled: false,
        ...(workspaceId && /^T[A-Z0-9]+$/.test(workspaceId)
          ? { team_id: workspaceId }
          : {}),
      });
      if (!response.ok || !strings(response.users, /^[UW][A-Z0-9]+$/)) {
        failed.add(target);
        continue;
      }
      for (const member of response.users) eligible.add(member);
      if (!batch.resolvedGroups.includes(target)) {
        batch.recipients = [...new Set([...batch.recipients, ...response.users])];
        batch.resolvedGroups.push(target);
      }
    } catch {
      failed.add(target);
    }
  }
  if (!failed.size) {
    batch.cancelled = [
      ...new Set([
        ...batch.cancelled,
        ...batch.recipients.filter((recipient) =>
          !eligible.has(recipient) && !batch.delivered.includes(recipient)
        ),
      ]),
    ];
  }
  try {
    // Resolve and persist recipients before performing any externally visible send.
    await store.save(batch);
  } catch {
    return { failed: [...new Set([...failed, "delivery_state"])] };
  }

  const text = await notificationText(task, client);
  for (const recipient of batch.recipients) {
    if (batch.delivered.includes(recipient) || batch.cancelled.includes(recipient)) {
      continue;
    }
    if (!eligible.has(recipient)) {
      if (failed.size) failed.add(recipient);
      continue;
    }
    try {
      const dm = await client.conversations.open({ users: recipient });
      if (!dm.ok || !dm.channel?.id || !/^D[A-Z0-9]+$/.test(dm.channel.id)) {
        failed.add(recipient);
        continue;
      }
      const sent = await client.chat.postMessage({
        channel: dm.channel.id,
        text,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!sent.ok || !sent.ts) {
        failed.add(recipient);
        continue;
      }
      batch.delivered.push(recipient);
      try {
        await store.save(batch);
      } catch {
        // Stop after an unrecorded send, limiting the possible duplicate window.
        return {
          failed: [
            ...new Set([
              ...failed,
              ...batch.recipients.filter((person) =>
                !batch.cancelled.includes(person) &&
                (person === recipient || !batch.delivered.includes(person))
              ),
            ]),
          ],
        };
      }
    } catch {
      failed.add(recipient);
    }
  }
  return { failed: [...failed] };
}

/** Resume durable assignment intents after any authorized task mutation. */
export async function notifyTaskAssignments(
  task: Task,
  workspaceId: string | undefined,
  client: NotificationClient,
  store: NotificationStore,
): Promise<{ failed: string[] }> {
  const failed = new Set<string>();
  for (const [eventKey, assigned] of Object.entries(task.assignmentEvents ?? {})) {
    if (!assigned.some((target) => target !== "all")) continue;
    const delivery = await notifyAssignments(
      task,
      assigned,
      eventKey,
      workspaceId,
      client,
      store,
    );
    for (const target of delivery.failed) failed.add(target);
  }
  return { failed: [...failed] };
}
