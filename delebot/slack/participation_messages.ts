import { delegationEndpoint, dispatchDelegation } from "./delegation_dispatch.ts";
import { taskTitle } from "./messages.ts";
import { canAccessTask, canManageTask } from "../tasks/access.ts";
import type { Task, TaskAccess } from "../tasks/models.ts";
import { withKeyLock } from "../tasks/mutation.ts";
import {
  parseParticipation,
  type ParticipationBinding,
  type ParticipationDelivery,
  respondToCollaboration,
  respondToTaskAction,
  taskActionApprovers,
  type TaskActionRequest,
  taskCanCollaborate,
  type TaskParticipation,
} from "../tasks/participation.ts";
import type { TaskRepository } from "../tasks/repository.ts";
import { TaskAccessError, TaskCommandError } from "../tasks/service.ts";
import type { TaskDisplays } from "./task_displays.ts";
import {
  escapeNotificationText as escape,
  type MessageBlocks,
  type NotificationClient,
  type NotificationContext,
  type NotificationResult,
  type NotificationStore,
  notifyTaskAssignments,
} from "./notifications.ts";

export const COLLAB_ACCEPT = "delebot_collab_accept";
export const COLLAB_REJECT = "delebot_collab_reject";
export const REQUEST_APPROVE = "delebot_request_approve";
export const REQUEST_REJECT = "delebot_request_reject";
export const PARTICIPATION_ACTION_IDS = [
  COLLAB_ACCEPT,
  COLLAB_REJECT,
  REQUEST_APPROVE,
  REQUEST_REJECT,
];

export interface ParticipationClient extends NotificationClient {
  chat: NotificationClient["chat"] & {
    update(
      args: { channel: string; ts: string; text: string; blocks: MessageBlocks },
    ): Promise<{ ok: boolean; error?: string }>;
  };
}
type ParticipatingTask = Task & { participation?: TaskParticipation };
interface ActionReference {
  taskId: string;
  eventKey: string;
  recipientId: string;
  bindingId: string;
}
export interface ParticipationAction {
  actionId: string;
  value: string;
  userId: string;
  channelId: string;
  messageTs: string;
  executionId: string;
  actionTs?: string;
  note?: string;
}
export interface ParticipationDependencies {
  client: ParticipationClient;
  repository: TaskRepository;
  loadAccess: NonNullable<NotificationContext["loadAccess"]>;
  rememberTask?: NotificationContext["rememberTask"];
  displays?: TaskDisplays;
  notificationStore?: NotificationStore;
}

function reference(value: string): ActionReference | undefined {
  try {
    const ref = JSON.parse(value);
    if (
      typeof ref.taskId === "string" && ref.taskId.length <= 400 &&
      typeof ref.eventKey === "string" && ref.eventKey.length <= 400 &&
      /^[UW][A-Z0-9]+$/.test(ref.recipientId) && /^[a-f0-9-]{36}$/.test(ref.bindingId)
    ) return ref;
  } catch { /* Invalid controls reveal no task contents. */ }
}
function blocks(
  task: Task,
  eventKey: string,
  recipientId: string,
  binding: ParticipationBinding,
  delivery: ParticipationDelivery,
  text: string,
): MessageBlocks {
  const value = JSON.stringify({
    taskId: task.id,
    eventKey,
    recipientId,
    bindingId: binding.id,
  });
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: delivery.kind === "collaboration" ? COLLAB_ACCEPT : REQUEST_APPROVE,
          text: {
            type: "plain_text",
            text: delivery.kind === "collaboration"
              ? "Accept collaboration"
              : "Approve request",
          },
          value,
          style: "primary",
        },
        {
          type: "button",
          action_id: delivery.kind === "collaboration" ? COLLAB_REJECT : REQUEST_REJECT,
          text: {
            type: "plain_text",
            text: delivery.kind === "collaboration"
              ? "Reject collaboration"
              : "Reject request",
          },
          value,
        },
      ],
    },
  ];
}

function state(
  task: ParticipatingTask,
  eventKey: string,
  delivery: ParticipationDelivery,
  userId: string,
): ParticipationBinding["status"] {
  if (delivery.kind === "collaboration") {
    if (task.deleted) return "cancelled";
    const invitation = task.participation?.collaborators[userId];
    if (
      !invitation || invitation.eventKey !== eventKey ||
      !taskCanCollaborate(task, invitation.invitedBy)
    ) return "cancelled";
    return invitation.status;
  }
  const request = task.participation?.requests[delivery.reference];
  if (!request) return "cancelled";
  return request.status;
}

export function requestStatusText(task: Task, request: TaskActionRequest): string {
  const kind = request.kind === "complete"
    ? "Completion"
    : request.kind === "incomplete"
    ? "Reopening"
    : "Deletion";
  const status = request.status === "pending" ? "requested" : `request ${request.status}`;
  const emoji = request.status === "approved"
    ? "✅"
    : request.status === "rejected" || request.status === "cancelled"
    ? "❌"
    : "⏳";
  return `${taskTitle(task)}\n\n${emoji} ${kind} ${status}.${
    request.status === "approved" && request.kind === "delete"
      ? ` Task deleted by <@${request.resolvedBy}>.`
      : ""
  }${request.rejectionNote ? `\n\n*Reason:* ${escape(request.rejectionNote)}` : ""}`;
}

export function collaborationStatusText(
  task: Task,
  delivery: ParticipationDelivery,
): string {
  const statuses = delivery.recipients.map((user) => {
    const invitation = task.participation?.collaborators[user];
    const status = invitation?.eventKey === delivery.reference
      ? invitation.status
      : "cancelled";
    return `<@${user}> ${
      status === "accepted" ? "✅" : status === "pending" ? "⏳" : "❌"
    } ${status}${
      invitation?.eventKey === delivery.reference && invitation.rejectionNote
        ? ` — ${escape(invitation.rejectionNote)}`
        : ""
    }`;
  });
  return `${taskTitle(task)}\n\nCollaboration requested.\n${statuses.join("\n")}`;
}

function textFor(
  task: ParticipatingTask,
  delivery: ParticipationDelivery,
  userId: string,
): string {
  const title = taskTitle(task);
  if (delivery.kind === "collaboration") {
    const invitation = task.participation!.collaborators[userId];
    return `<@${invitation.invitedBy}> invited you to collaborate on task ${title}.\n\nAccept or reject below, or reply with \`collab accept\` or \`collab reject\`. Collaboration does not change the assignee.`;
  }
  const request = task.participation!.requests[delivery.reference];
  return `<@${request.requestedBy}> requests ${
    request.kind === "complete"
      ? "completion"
      : request.kind === "incomplete"
      ? "reopening"
      : "deletion"
  } of task ${title}.\n\nOnly someone in the task's Access field can approve this request.`;
}

async function accessFor(
  task: Task,
  userId: string,
  workspaceId: string | undefined,
  context: NotificationContext,
): Promise<TaskAccess> {
  const access = context.loadAccess
    ? await context.loadAccess(task, userId, workspaceId)
    : { userId, teamIds: [] };
  if (access.userId !== userId) throw new Error("Recipient identity mismatch.");
  return access;
}

/** Delivery and retries are serialized with all task mutations and carry stable Slack send IDs. */
export async function notifyParticipation(
  task: ParticipatingTask,
  workspaceId: string | undefined,
  client: ParticipationClient,
  context: NotificationContext,
  repository: TaskRepository,
): Promise<NotificationResult> {
  return await withKeyLock(task.id, async () => {
    const current = await repository.findById(task.id) as ParticipatingTask | null;
    if (!current?.participation) return { failed: [], interactive: false };
    current.participation = parseParticipation(current.participation);
    let closedRequests = false;
    for (const request of Object.values(current.participation.requests)) {
      if (
        request.status === "pending" &&
        (current.deleted || (current.completed && request.kind === "complete") ||
          (!current.completed && request.kind === "incomplete"))
      ) {
        request.status = "cancelled";
        closedRequests = true;
      }
    }
    if (closedRequests) await repository.save(current);
    const failed = new Set<string>();
    for (const request of Object.values(current.participation.requests)) {
      for (const message of request.confirmations ?? []) {
        try {
          const access = await accessFor(current, message.userId, workspaceId, context);
          const visible = canAccessTask({ ...current, deleted: false }, access);
          const updated = await client.chat.update({
            channel: message.channelId,
            ts: message.messageTs,
            text: visible
              ? requestStatusText(current, request)
              : "This task is no longer available.",
            blocks: [],
          });
          if (
            !updated.ok &&
            !["message_not_found", "message_not_modified"].includes(updated.error ?? "")
          ) failed.add(message.userId);
          if (visible && context.rememberTask) {
            await context.rememberTask(
              message.channelId,
              message.messageTs,
              message.userId,
              current.id,
            );
          }
        } catch {
          failed.add(message.userId);
        }
      }
    }
    let interactive = false;
    for (
      const [eventKey, delivery] of Object.entries(current.participation.deliveryEvents)
    ) {
      delivery.workspaceId ??= workspaceId;
      const workspace = delivery.workspaceId;
      delivery.deliveries ??= {};
      for (const message of delivery.confirmations ?? []) {
        try {
          const access = await accessFor(current, message.userId, workspace, context);
          const updated = await client.chat.update({
            channel: message.channelId,
            ts: message.messageTs,
            text: canAccessTask(current, access)
              ? collaborationStatusText(current, delivery)
              : "This task is no longer available.",
            blocks: [],
          });
          if (
            !updated.ok &&
            !["message_not_found", "message_not_modified"].includes(updated.error ?? "")
          ) failed.add(message.userId);
        } catch {
          failed.add(message.userId);
        }
      }
      const users = new Set<string>();
      const request = current.participation.requests[delivery.reference];
      const principals = delivery.kind === "approval"
        ? taskActionApprovers(current)
        : delivery.recipients;
      const active = !current.deleted &&
        (delivery.kind === "approval"
          ? request?.status === "pending"
          : !current.completed);
      if (active) {
        for (const principal of principals) {
          if (/^[UW][A-Z0-9]+$/.test(principal)) {
            users.add(principal);
            continue;
          }
          if (!/^S[A-Z0-9]+$/.test(principal)) continue;
          try {
            const group = await client.usergroups.users.list({
              usergroup: principal,
              include_disabled: false,
              ...(workspace ? { team_id: workspace } : {}),
            });
            if (
              !group.ok || !Array.isArray(group.users) ||
              !group.users.every((user) =>
                typeof user === "string" && /^[UW][A-Z0-9]+$/.test(user)
              )
            ) {
              failed.add(principal);
              continue;
            }
            for (const user of group.users) users.add(user);
          } catch {
            failed.add(principal);
          }
        }
      }
      for (const [userId, binding] of Object.entries(delivery.deliveries)) {
        if (!binding.messageTs || !binding.channelId) continue;
        try {
          const access = await accessFor(current, userId, workspace, context);
          let nextStatus = state(current, eventKey, delivery, userId);
          if (
            !canAccessTask({ ...current, deleted: false }, access) ||
            (delivery.kind === "approval" && nextStatus === "pending" &&
              !canManageTask(current, access))
          ) nextStatus = "cancelled";
          if (nextStatus === "pending") {
            const text = textFor(current, delivery, userId);
            if (binding.renderedText !== text) {
              const updated = await client.chat.update({
                channel: binding.channelId,
                ts: binding.messageTs,
                text,
                blocks: blocks(current, eventKey, userId, binding, delivery, text),
              });
              if (
                !updated.ok &&
                !["message_not_found", "message_not_modified"].includes(
                  updated.error ?? "",
                )
              ) {
                failed.add(userId);
                continue;
              }
              binding.renderedText = text;
              await repository.save(current);
            }
            continue;
          }
          binding.status = nextStatus;
          const visible = canAccessTask({ ...current, deleted: false }, access);
          const text = !visible
            ? "This task is no longer available."
            : delivery.kind === "approval" && request
            ? requestStatusText(current, request)
            : `${taskTitle(current)}\n\n${
              nextStatus === "accepted" ? "✅" : "❌"
            } Collaboration ${nextStatus}.${
              current.participation.collaborators[userId]?.rejectionNote
                ? `\n\n*Reason:* ${
                  escape(current.participation.collaborators[userId].rejectionNote!)
                }`
                : ""
            }`;
          const updated = await client.chat.update({
            channel: binding.channelId,
            ts: binding.messageTs,
            text,
            blocks: [],
          });
          if (
            !updated.ok &&
            !["message_not_found", "message_not_modified"].includes(updated.error ?? "")
          ) failed.add(userId);
          try {
            if (visible && context.rememberTask && !binding.contextSaved) {
              await context.rememberTask(
                binding.channelId,
                binding.messageTs,
                userId,
                current.id,
              );
              binding.contextSaved = true;
            }
          } catch {
            console.warn(
              JSON.stringify({
                event: "participation_context_save_failed",
                taskId: current.id,
              }),
            );
          }
          await repository.save(current);
        } catch {
          failed.add(userId);
        }
      }
      for (const userId of users) {
        if (state(current, eventKey, delivery, userId) !== "pending") continue;
        try {
          const access = await accessFor(current, userId, workspace, context);
          if (
            !canAccessTask(current, access) ||
            (delivery.kind === "approval" && !canManageTask(current, access))
          ) {
            failed.add(userId);
            continue;
          }
          let binding = delivery.deliveries[userId];
          if (binding?.messageTs) {
            if (context.rememberTask && !binding.contextSaved && binding.channelId) {
              await context.rememberTask(
                binding.channelId,
                binding.messageTs,
                userId,
                current.id,
              );
              binding.contextSaved = true;
              await repository.save(current);
            }
            continue;
          }
          binding ??= {
            id: crypto.randomUUID(),
            executionId: context.executionId ?? "commands",
            status: "pending",
          };
          // Failed unsent invitations move to the execution that actually posts
          // the retry; its Slack buttons must bind to that live execution.
          if (context.executionId) binding.executionId = context.executionId;
          delivery.deliveries[userId] = binding;
          await repository.save(current);
          const dm = await client.conversations.open({ users: userId });
          if (!dm.ok || !dm.channel?.id || !/^D[A-Z0-9]+$/.test(dm.channel.id)) {
            failed.add(userId);
            continue;
          }
          if (context.executionId) await context.prepareInteractivity?.();
          const text = textFor(current, delivery, userId);
          const sent = await client.chat.postMessage(
            {
              channel: dm.channel.id,
              text,
              unfurl_links: false,
              unfurl_media: false,
              ...(context.executionId
                ? { blocks: blocks(current, eventKey, userId, binding, delivery, text) }
                : {}),
              client_msg_id: binding.id,
            } as Parameters<ParticipationClient["chat"]["postMessage"]>[0],
          );
          if (!sent.ok || !sent.ts) {
            failed.add(userId);
            continue;
          }
          binding.channelId = dm.channel.id;
          binding.messageTs = sent.ts;
          binding.renderedText = text;
          await repository.save(current);
          if (context.rememberTask) {
            await context.rememberTask(dm.channel.id, sent.ts, userId, current.id);
            binding.contextSaved = true;
            await repository.save(current);
          }
          if (context.executionId) interactive = true;
        } catch {
          failed.add(userId);
        }
      }
    }
    return { failed: [...failed], interactive };
  });
}

/** Bind response buttons to the exact person, task, message, event and execution. */
export async function handleParticipationAction(
  action: ParticipationAction,
  dependencies: ParticipationDependencies,
): Promise<{ ok: boolean; error?: string; interactive?: boolean }> {
  try {
    const ref = reference(action.value);
    if (
      !ref || ref.recipientId !== action.userId ||
      !PARTICIPATION_ACTION_IDS.includes(action.actionId)
    ) return { ok: false, error: "This control is not available." };
    const task = await dependencies.repository.findById(ref.taskId) as
      | ParticipatingTask
      | null;
    const delivery = task?.participation?.deliveryEvents[ref.eventKey];
    const binding = delivery?.deliveries?.[action.userId];
    if (
      !task || !delivery || !binding || binding.id !== ref.bindingId ||
      binding.executionId !== action.executionId ||
      binding.channelId !== action.channelId || binding.messageTs !== action.messageTs
    ) return { ok: false, error: "This control is not available." };
    const isCollaboration = action.actionId === COLLAB_ACCEPT ||
      action.actionId === COLLAB_REJECT;
    if ((delivery.kind === "collaboration") !== isCollaboration) {
      return { ok: false, error: "This control does not match the request." };
    }
    const context = {
      userId: action.userId,
      channelId: action.channelId,
      messageTs: action.actionTs ??
        `${Math.floor(Date.now() / 1000)}.${String(Date.now() % 1000).padStart(3, "0")}`,
    };
    let current = task;
    if (
      binding.status === "pending" &&
      state(task, ref.eventKey, delivery, action.userId) === "pending"
    ) {
      const access = await dependencies.loadAccess(
        task,
        action.userId,
        delivery.workspaceId,
      );
      const result = isCollaboration
        ? await respondToCollaboration(
          task,
          action.actionId === COLLAB_ACCEPT ? "accept" : "reject",
          context,
          dependencies.repository,
          access,
          ref.eventKey,
          action.note,
        )
        : await respondToTaskAction(
          task,
          delivery.reference,
          action.actionId === REQUEST_APPROVE ? "approve" : "reject",
          context,
          dependencies.repository,
          access,
          action.note,
        );
      current = result.task;
    }
    const assignments =
      (current.deleted || current.completed) && dependencies.notificationStore
        ? await notifyTaskAssignments(
          current,
          delivery.workspaceId,
          dependencies.client,
          dependencies.notificationStore,
          { loadAccess: dependencies.loadAccess, executionId: action.executionId },
        )
        : { failed: [], interactive: false };
    const notifications = await notifyParticipation(
      current,
      delivery.workspaceId,
      dependencies.client,
      {
        loadAccess: dependencies.loadAccess,
        rememberTask: dependencies.rememberTask,
        executionId: action.executionId,
      },
      dependencies.repository,
    );
    notifications.failed = [...new Set([...notifications.failed, ...assignments.failed])];
    if (dependencies.displays) {
      try {
        await dependencies.displays.refresh(
          current,
          current.deleted
            ? {
              eventKey: `${context.channelId}:${context.messageTs}`,
              text: requestStatusText(
                current,
                current.participation!.requests[delivery.reference],
              ),
              sourceChannel: action.channelId,
              sourceThread: action.messageTs,
            }
            : undefined,
        );
      } catch {
        console.warn(
          JSON.stringify({
            event: "participation_display_refresh_failed",
            taskId: current.id,
          }),
        );
      }
    }
    if (
      dependencies.notificationStore && dependencies.client.functions &&
      !notifications.failed.length
    ) {
      await withKeyLock(task.id, async () => {
        const final = await dependencies.repository.findById(task.id) as
          | ParticipatingTask
          | null;
        if (
          !final?.participation ||
          final.participation.completedExecutions?.includes(action.executionId)
        ) return;
        const pendingParticipation = Object.values(final.participation.deliveryEvents)
          .some((event) =>
            Object.values(event.deliveries ?? {}).some((item) =>
              item.executionId === action.executionId && item.status === "pending"
            )
          );
        if (pendingParticipation) return;
        for (const key of Object.keys(final.assignmentEvents ?? {})) {
          const batch = await dependencies.notificationStore!.get(`${final.id}:${key}`);
          if (
            Object.values(batch?.invitations ?? {}).some((item) =>
              item.executionId === action.executionId && item.status === "pending" &&
              !item.messageRemoved
            )
          ) return;
        }
        const completed = await dependencies.client.functions!.completeSuccess({
          function_execution_id: action.executionId,
          outputs: { ignored: false },
        });
        if (
          !completed.ok &&
          !["already_complete", "function_execution_already_completed"].includes(
            completed.error ?? "",
          )
        ) throw new Error("Cannot finish participation interaction.");
        final.participation.completedExecutions = [
          ...new Set([
            ...final.participation.completedExecutions ?? [],
            action.executionId,
          ]),
        ];
        await dependencies.repository.save(final);
      });
    }
    return {
      ok: !notifications.failed.length,
      ...(notifications.failed.length
        ? {
          error:
            "The response was saved, but some messages could not be updated. Try again.",
        }
        : {}),
      interactive: notifications.interactive || assignments.interactive,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof TaskAccessError || error instanceof TaskCommandError
        ? error.message
        : "I could not apply this response. Please try again.",
    };
  }
}

export const PARTICIPATION_REJECT_VIEW = "delebot_participation_reject";

/** Opening a rejection form does not change the request. The worker validates its original binding. */
export async function participationBlockActionHandler(
  { body, action, client }:
    import("deno-slack-sdk/functions/interactivity/types.ts").ActionContext<
      Record<string, unknown>
    >,
) {
  const raw = action as unknown as {
    action_id: string;
    value: string;
    action_ts?: string;
  };
  const container = body.container as { channel_id?: string; message_ts?: string };
  const submitted: ParticipationAction = {
    actionId: raw.action_id,
    value: raw.value,
    actionTs: raw.action_ts,
    userId: body.user.id,
    channelId: container.channel_id ?? "",
    messageTs: container.message_ts ?? "",
    executionId: body.function_data.execution_id,
  };
  try {
    const workerUrl = await delegationEndpoint(client);
    if ([COLLAB_REJECT, REQUEST_REJECT].includes(submitted.actionId)) {
      const opened = await client.views.open({
        interactivity_pointer: body.interactivity.interactivity_pointer,
        view: {
          type: "modal",
          callback_id: PARTICIPATION_REJECT_VIEW,
          title: { type: "plain_text", text: "Reject request" },
          submit: { type: "plain_text", text: "Reject" },
          close: { type: "plain_text", text: "Cancel" },
          private_metadata: JSON.stringify({ action: submitted, workerUrl }),
          blocks: [{
            type: "input",
            block_id: "rejection_note",
            optional: true,
            label: { type: "plain_text", text: "Reason (optional)" },
            element: {
              type: "plain_text_input",
              action_id: "note",
              multiline: true,
              max_length: 2000,
            },
          }],
        },
      });
      if (!opened.ok) throw new Error("Cannot open rejection form.");
    } else {await dispatchDelegation(
        workerUrl,
        { kind: "participation_action", action: submitted },
        submitted.channelId,
        submitted.userId,
      );}
  } catch {
    await client.chat.postEphemeral({
      channel: submitted.channelId,
      user: submitted.userId,
      text: "Slack could not receive your response. Please retry.",
    });
  }
}

export async function participationViewSubmissionHandler(
  { body, view }:
    import("deno-slack-sdk/functions/interactivity/types.ts").ViewSubmissionContext<
      Record<string, unknown>
    >,
  dispatch = dispatchDelegation,
) {
  try {
    const metadata = JSON.parse(view.private_metadata ?? "");
    const action = metadata.action as ParticipationAction;
    const note = view.state.values.rejection_note?.note?.value ?? "";
    if (
      action?.userId !== body.user.id ||
      ![COLLAB_REJECT, REQUEST_REJECT].includes(action.actionId) || note.length > 2000
    ) throw new Error("Invalid rejection.");
    await dispatch(
      metadata.workerUrl,
      { kind: "participation_action", action: { ...action, note } },
      action.channelId,
      action.userId,
    );
    return { response_action: "clear" as const };
  } catch {
    return {
      response_action: "errors" as const,
      errors: { rejection_note: "Slack could not receive your rejection. Please retry." },
    };
  }
}
