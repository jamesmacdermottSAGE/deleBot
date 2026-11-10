import { DefineDatastore, Schema } from "deno-slack-sdk/mod.ts";
import type { SlackAPIClient } from "deno-slack-api/types.ts";
import { canViewTask } from "../tasks/access.ts";
import type { Task, TaskAccess } from "../tasks/models.ts";

export type NotificationTask =
  & Pick<
    Task,
    "id" | "name" | "number" | "assignees" | "channelId" | "messageTs"
  >
  & Partial<
    Pick<
      Task,
      | "viewPerms"
      | "editPerms"
      | "teams"
      | "assignmentBased"
      | "createdBy"
      | "deleted"
      | "assignmentResponses"
    >
  >;

export const ASSIGNMENT_ACCEPT = "delebot_assignment_accept";
export const ASSIGNMENT_REJECT = "delebot_assignment_reject";
export const ASSIGNMENT_DELEGATE = "delebot_assignment_delegate";
export const ASSIGNMENT_ACTION_IDS = [
  ASSIGNMENT_ACCEPT,
  ASSIGNMENT_REJECT,
  ASSIGNMENT_DELEGATE,
];
export type MessageBlocks = NonNullable<
  Parameters<SlackAPIClient["chat"]["postMessage"]>[0]["blocks"]
>;
export interface NotificationContext {
  rememberTask?: (
    channel: string,
    messageTs: string,
    user: string,
    taskId: string,
  ) => Promise<void>;
  executionId?: string;
  loadAccess?: (
    task: Task,
    recipientId: string,
    workspaceId?: string,
  ) => Promise<TaskAccess>;
}
export interface NotificationResult {
  failed: string[];
  interactive: boolean;
}

export interface AssignmentInvitation {
  id: string;
  recipientId: string;
  status: "pending" | "accepted" | "rejected" | "delegated" | "cancelled";
  executionId: string;
  channelId?: string;
  messageTs?: string;
  messageRemoved?: boolean;
  delegatedTo?: string[];
  returnedBy?: string;
  note?: string;
  modalNonce?: string;
  modalId?: string;
  decision?: {
    kind: "accept" | "reject" | "delegate";
    assignees?: string[];
    note?: string;
    messageTs: string;
  };
}

/** Delivery state retains invitation context for reliable retries and refreshes. */
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
  workspaceId?: string;
  sourceChannelId?: string;
  sourceMessageTs?: string;
  invitations?: Record<string, AssignmentInvitation>;
  completedExecutions?: string[];
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
      blocks?: MessageBlocks;
    }): Promise<ApiResult & { ts?: string }>;
    getPermalink?(args: { channel: string; message_ts: string }): Promise<
      ApiResult & { permalink?: string }
    >;
    delete?(
      args: { channel: string; ts: string },
    ): Promise<{ ok: boolean; error?: string }>;
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
  functions?: {
    completeSuccess(
      args: { function_execution_id: string; outputs: { ignored: boolean } },
    ): Promise<{ ok: boolean; error?: string }>;
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
  if (
    batch.workspaceId !== undefined &&
    (typeof batch.workspaceId !== "string" || !/^T[A-Z0-9]+$/.test(batch.workspaceId))
  ) throw new Error("Invalid notification workspace.");
  if (
    batch.sourceChannelId !== undefined &&
    (typeof batch.sourceChannelId !== "string" ||
      !/^[CDG][A-Z0-9]+$/.test(batch.sourceChannelId))
  ) throw new Error("Invalid notification source.");
  if (
    batch.sourceMessageTs !== undefined &&
    (typeof batch.sourceMessageTs !== "string" ||
      !/^\d+\.\d+$/.test(batch.sourceMessageTs))
  ) throw new Error("Invalid notification source.");
  if (batch.invitations !== undefined) {
    if (
      !batch.invitations || typeof batch.invitations !== "object" ||
      Array.isArray(batch.invitations)
    ) throw new Error("Invalid invitations.");
    for (const [recipient, raw] of Object.entries(batch.invitations)) {
      const invitation = raw as AssignmentInvitation;
      if (
        !invitation || typeof invitation !== "object" ||
        !recipients.includes(recipient) || invitation.recipientId !== recipient ||
        typeof invitation.id !== "string" || !/^[a-f0-9-]{36}$/.test(invitation.id) ||
        typeof invitation.executionId !== "string" || !invitation.executionId ||
        !["pending", "accepted", "rejected", "delegated", "cancelled"].includes(
          invitation.status,
        ) ||
        (invitation.channelId !== undefined &&
          !/^D[A-Z0-9]+$/.test(invitation.channelId)) ||
        (invitation.messageTs !== undefined &&
          !/^\d+\.\d+$/.test(invitation.messageTs)) ||
        (invitation.messageRemoved !== undefined &&
          typeof invitation.messageRemoved !== "boolean") ||
        (invitation.delegatedTo !== undefined &&
          !strings(invitation.delegatedTo, /^[UWS][A-Z0-9]+$/)) ||
        (invitation.returnedBy !== undefined &&
          (typeof invitation.returnedBy !== "string" ||
            !/^[UW][A-Z0-9]+$/.test(invitation.returnedBy))) ||
        (invitation.note !== undefined &&
          (typeof invitation.note !== "string" || invitation.note.length > 2000)) ||
        (invitation.modalNonce !== undefined &&
          !/^[a-f0-9-]{36}$/.test(invitation.modalNonce)) ||
        (invitation.modalId !== undefined &&
          (typeof invitation.modalId !== "string" || !invitation.modalId))
      ) throw new Error("Invalid invitation.");
      if (
        invitation.decision &&
        (!["accept", "reject", "delegate"].includes(invitation.decision.kind) ||
          !/^\d+\.\d+$/.test(invitation.decision.messageTs) ||
          (invitation.decision.assignees !== undefined &&
            !strings(invitation.decision.assignees, /^[UWS][A-Z0-9]+$/)) ||
          (invitation.decision.note !== undefined &&
            (typeof invitation.decision.note !== "string" ||
              invitation.decision.note.length > 2000)))
      ) throw new Error("Invalid invitation decision.");
    }
  }
  if (
    batch.completedExecutions !== undefined && !strings(batch.completedExecutions, /^.+$/)
  ) throw new Error("Invalid completed executions.");
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

export function escapeNotificationText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
const escape = escapeNotificationText;

export function invitationValue(
  batch: NotificationBatch,
  invitation: AssignmentInvitation,
): string {
  return JSON.stringify({
    batchId: batch.id,
    recipientId: invitation.recipientId,
    invitationId: invitation.id,
  });
}

function isCurrentAssignment(task: NotificationTask, access: TaskAccess): boolean {
  return task.assignees.some((id) =>
    id === access.userId || (/^S/.test(id) && access.teamIds.includes(id))
  );
}

async function reconcileInvitations(
  task: NotificationTask,
  batch: NotificationBatch,
  client: NotificationClient,
  store: NotificationStore,
  context: NotificationContext,
): Promise<string[]> {
  const failed = new Set<string>();
  for (const invitation of Object.values(batch.invitations ?? {})) {
    if (!invitation.channelId || !invitation.messageTs || invitation.messageRemoved) {
      continue;
    }
    try {
      let remove = task.deleted || invitation.status === "cancelled" ||
        invitation.status === "rejected";
      if (!remove) {
        if (context.loadAccess) {
          const access = await context.loadAccess(
            task as Task,
            invitation.recipientId,
            batch.workspaceId,
          );
          if (access.userId !== invitation.recipientId) {
            failed.add(invitation.recipientId);
            continue;
          }
          remove = !canViewTask(task as Task, access) ||
            ((invitation.status === "pending" || invitation.status === "accepted") &&
              !isCurrentAssignment(task, access));
        } else if (
          task.viewPerms !== undefined &&
          !(task.viewPerms.length === 1 && task.viewPerms[0] === "all")
        ) {
          // Never retain an interactive copy when its explicit ACL cannot be verified.
          remove = true;
        }
      }
      if (!remove) continue;
      if (invitation.status !== "rejected") invitation.status = "cancelled";
      batch.cancelled = [...new Set([...batch.cancelled, invitation.recipientId])];
      await store.save(batch);
      if (!client.chat.delete) {
        failed.add(invitation.recipientId);
        continue;
      }
      const deleted = await client.chat.delete({
        channel: invitation.channelId,
        ts: invitation.messageTs,
      });
      if (!deleted.ok && deleted.error !== "message_not_found") {
        failed.add(invitation.recipientId);
        continue;
      }
      invitation.messageRemoved = true;
      await store.save(batch);
    } catch {
      failed.add(invitation.recipientId);
    }
  }
  return [...failed];
}

export function assignmentBlocks(
  text: string,
  batch: NotificationBatch,
  invitation: AssignmentInvitation,
): MessageBlocks {
  const value = invitationValue(batch, invitation);
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: ASSIGNMENT_ACCEPT,
          text: { type: "plain_text", text: "Accept" },
          style: "primary",
          value,
        },
        {
          type: "button",
          action_id: ASSIGNMENT_REJECT,
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          value,
        },
        {
          type: "button",
          action_id: ASSIGNMENT_DELEGATE,
          text: { type: "plain_text", text: "Delegate" },
          value,
        },
      ],
    },
  ];
}

export function assignmentNotificationText(
  task: NotificationTask,
  recipientId: string,
  invitation: Pick<AssignmentInvitation, "returnedBy" | "note"> = {},
): string {
  const returnedBy = invitation.returnedBy ??
    task.assignmentResponses?.[recipientId]?.returnedBy;
  const note = invitation.note ?? task.assignmentResponses?.[recipientId]?.note;
  return [
    returnedBy
      ? `Task *#${task.number}: ${
        escape(task.name)
      }* was returned to you after <@${returnedBy}> rejected it.`
      : `You have been assigned task *#${task.number}: ${escape(task.name)}*.`,
    `Reply here with \`accept\`, \`reject\`, \`delegate @person\`, or \`done\`. You can also send \`${task.number} done\` directly to DeleBot.`,
    ...(note?.trim() ? [`*Note:* ${escape(note.trim())}`] : []),
  ].join("\n\n");
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
  context: NotificationContext = {},
): Promise<NotificationResult> {
  let interactive = false;
  const id = `${task.id}:${eventKey}`;
  let batch: NotificationBatch;
  try {
    const saved = await store.get(id);
    if (saved) {
      batch = validateBatch(saved, id);
      if (batch.taskId !== task.id || batch.eventKey !== eventKey) {
        return { failed: ["delivery_state"], interactive };
      }
    } else {
      const targets = [...new Set(assigned.filter((target) => target !== "all"))];
      if (!targets.length) return { failed: [], interactive };
      if (!strings(targets, /^[UWS][A-Z0-9]+$/)) {
        return { failed: ["assignment_targets"], interactive };
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
        ...(workspaceId ? { workspaceId } : {}),
        sourceChannelId: task.channelId,
        sourceMessageTs: task.messageTs,
      };
      await store.save(batch);
    }
  } catch {
    return { failed: ["delivery_state"], interactive };
  }

  const failed = new Set(await reconcileInvitations(task, batch, client, store, context));
  if (task.deleted) {
    batch.cancelled = [
      ...new Set([
        ...batch.cancelled,
        ...batch.recipients.filter((id) => !batch.delivered.includes(id)),
      ]),
    ];
    try {
      await store.save(batch);
    } catch {
      failed.add("delivery_state");
    }
    return { failed: [...failed], interactive };
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
    return { failed: [...failed], interactive };
  }

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
    return { failed: [...new Set([...failed, "delivery_state"])], interactive };
  }

  for (const recipient of batch.recipients) {
    if (batch.delivered.includes(recipient) || batch.cancelled.includes(recipient)) {
      continue;
    }
    if (!eligible.has(recipient)) {
      if (failed.size) failed.add(recipient);
      continue;
    }
    try {
      if (task.deleted) {
        failed.add(recipient);
        continue;
      }
      if (context.loadAccess) {
        const access = await context.loadAccess(
          task as Task,
          recipient,
          batch.workspaceId ?? workspaceId,
        );
        if (access.userId !== recipient || !canViewTask(task as Task, access)) {
          failed.add(recipient);
          continue;
        }
        if (!isCurrentAssignment(task, access)) {
          batch.cancelled = [...new Set([...batch.cancelled, recipient])];
          await store.save(batch);
          continue;
        }
      } else if (
        task.viewPerms !== undefined &&
        !(task.viewPerms.length === 1 && task.viewPerms[0] === "all")
      ) {
        failed.add(recipient);
        continue;
      }
      const dm = await client.conversations.open({ users: recipient });
      if (!dm.ok || !dm.channel?.id || !/^D[A-Z0-9]+$/.test(dm.channel.id)) {
        failed.add(recipient);
        continue;
      }
      let invitation: AssignmentInvitation | undefined;
      const returnedBy = task.assignmentResponses?.[recipient]?.returnedBy;
      const note = batch.assigned.map((id) => task.assignmentResponses?.[id]?.note).find((
        value,
      ) => value?.trim());
      if (context.executionId) {
        batch.invitations ??= {};
        invitation = batch.invitations[recipient];
        if (!invitation) {
          invitation = {
            id: crypto.randomUUID(),
            recipientId: recipient,
            status: "pending",
            executionId: context.executionId,
            ...(returnedBy ? { returnedBy } : {}),
            ...(note ? { note } : {}),
          };
          batch.invitations[recipient] = invitation;
        } else if (invitation.status !== "pending") continue;
        // An unsent invitation is owned by the execution that actually posts it.
        invitation.executionId = context.executionId;
        await store.save(batch);
      }
      const text = assignmentNotificationText(
        task,
        recipient,
        invitation ?? { returnedBy, note },
      );
      const sent = await client.chat.postMessage({
        channel: dm.channel.id,
        text,
        unfurl_links: false,
        unfurl_media: false,
        ...(invitation
          ? {
            blocks: assignmentBlocks(
              text,
              batch,
              invitation,
            ),
          }
          : {}),
      });
      if (!sent.ok || !sent.ts) {
        failed.add(recipient);
        continue;
      }
      if (invitation) {
        invitation.channelId = dm.channel.id;
        invitation.messageTs = sent.ts;
        interactive = true;
      }
      batch.delivered.push(recipient);
      if (context.rememberTask) {
        try {
          await context.rememberTask(dm.channel.id, sent.ts, recipient, task.id);
        } catch {
          failed.add(recipient);
        }
      }
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
          interactive,
        };
      }
    } catch {
      failed.add(recipient);
    }
  }
  return { failed: [...failed], interactive };
}

/** Resume durable assignment intents after any authorized task mutation. */
export async function notifyTaskAssignments(
  task: Task,
  workspaceId: string | undefined,
  client: NotificationClient,
  store: NotificationStore,
  context: NotificationContext = {},
): Promise<NotificationResult> {
  const failed = new Set<string>();
  let interactive = false;
  for (const [eventKey, assigned] of Object.entries(task.assignmentEvents ?? {})) {
    if (!assigned.some((target) => target !== "all")) continue;
    const delivery = await notifyAssignments(
      task,
      assigned,
      eventKey,
      workspaceId,
      client,
      store,
      context,
    );
    interactive ||= delivery.interactive;
    for (const target of delivery.failed) failed.add(target);
  }
  return { failed: [...failed], interactive };
}
