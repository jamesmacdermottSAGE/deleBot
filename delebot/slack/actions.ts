import { taskTitle } from "./messages.ts";
import {
  delegationEndpoint,
  dispatchDelegation,
  isDelegationEndpoint,
} from "./delegation_dispatch.ts";
import type { SlackAPIClient } from "deno-slack-api/types.ts";
import { SlackDmContexts } from "./dm_context.ts";
import { recipientMentions } from "./delegation_input.ts";
import { type TaskDisplays, taskDisplays } from "./task_displays.ts";
import type {
  ActionContext,
  ViewSubmissionContext,
} from "deno-slack-sdk/functions/interactivity/types.ts";
import { canDelegateTask, canManageTask, canViewTask } from "../tasks/access.ts";
import { taskAccessLoader } from "./access_context.ts";
import type { Task, TaskAccess } from "../tasks/models.ts";
import { SlackTaskRepository, type TaskRepository } from "../tasks/repository.ts";
import {
  deleteTask,
  respondToAssignment,
  TaskAccessError,
  TaskCommandError,
} from "../tasks/service.ts";
import { requestTaskAction } from "../tasks/participation.ts";
import { notifyParticipation } from "./participation_messages.ts";
import type { TeamClient } from "./teams.ts";
import { resolveWorkspace } from "./workspace.ts";
import {
  ASSIGNMENT_ACCEPT,
  ASSIGNMENT_DELEGATE,
  ASSIGNMENT_REJECT,
  ASSIGNMENT_RETURN_DELETE,
  type AssignmentInvitation,
  escapeNotificationText,
  type MessageBlocks,
  type NotificationBatch,
  type NotificationClient,
  type NotificationContext,
  type NotificationStore,
  notifyTaskAssignments,
  SlackNotificationStore,
} from "./notifications.ts";

export { ASSIGNMENT_ACTION_IDS } from "./notifications.ts";
export const ASSIGNMENT_DELEGATE_VIEW = "delebot_assignment_delegate_view";

interface ApiResult {
  ok: boolean;
  error?: string;
}
export interface AssignmentClient extends NotificationClient {
  chat: NotificationClient["chat"] & {
    update(
      args: { channel: string; ts: string; text: string; blocks: MessageBlocks },
    ): Promise<ApiResult>;
    delete(args: { channel: string; ts: string }): Promise<ApiResult>;
    postEphemeral?(
      args: { channel: string; user: string; text: string },
    ): Promise<ApiResult>;
  };
  views: {
    open(
      args: Parameters<SlackAPIClient["views"]["open"]>[0],
    ): Promise<ApiResult & { view?: { id?: string } }>;
  };
  usergroups: NotificationClient["usergroups"] & TeamClient["usergroups"];
  functions: {
    completeSuccess(
      args: { function_execution_id: string; outputs: { ignored: boolean } },
    ): Promise<ApiResult>;
  };
}

export interface AssignmentDependencies {
  delegationEndpoint?: () => Promise<string>;
  deliveryExecutionId?: string;
  displays?: TaskDisplays;
  rememberTask?: NotificationContext["rememberTask"];
  client: AssignmentClient;
  repository: TaskRepository;
  store: NotificationStore;
  loadAccess: NonNullable<NotificationContext["loadAccess"]>;
  resolveWorkspace?: (task: Task) => Promise<string>;
}
export interface AssignmentAction {
  actionId: string;
  value: string;
  userId: string;
  channelId: string;
  messageTs: string;
  executionId: string;
  interactivityPointer?: string;
  actionTs?: string;
}
export interface AssignmentSubmission {
  privateMetadata: string;
  userId: string;
  viewId: string;
  executionId: string;
  recipients?: unknown;
  note?: string;
  /** Compatibility with delegation dialogs opened before the combined field. */
  selectedUsers?: string[];
  teamText?: string;
}
export interface AssignmentActionResult {
  ok: boolean;
  error?: string;
  interactive?: boolean;
  errorField?: "delegation_recipients" | "delegation_note";
}
interface InvitationReference {
  batchId: string;
  recipientId: string;
  invitationId: string;
  nonce?: string;
}

function reference(value: string): InvitationReference | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed.batchId === "string" && parsed.batchId.length <= 300 &&
        /^[UW][A-Z0-9]+$/.test(parsed.recipientId) &&
        /^[a-f0-9-]{36}$/.test(parsed.invitationId) &&
        (parsed.nonce === undefined || /^[a-f0-9-]{36}$/.test(parsed.nonce))
      ? parsed
      : null;
  } catch {
    return null;
  }
}

interface BoundInvitation {
  batch: NotificationBatch;
  invitation: AssignmentInvitation;
  task: Task;
}
async function boundInvitation(
  ref: InvitationReference | null,
  userId: string,
  executionId: string,
  dependencies: AssignmentDependencies,
): Promise<BoundInvitation | null> {
  if (!ref || ref.recipientId !== userId) return null;
  const batch = await dependencies.store.get(ref.batchId);
  const invitation = batch?.invitations?.[userId];
  if (
    !batch || !invitation || invitation.id !== ref.invitationId ||
    invitation.recipientId !== userId || invitation.executionId !== executionId ||
    !batch.delivered.includes(userId) || !invitation.channelId || !invitation.messageTs
  ) return null;
  const task = await dependencies.repository.findById(batch.taskId);
  if (
    !task || task.id !== batch.taskId || task.channelId !== batch.sourceChannelId ||
    task.messageTs !== batch.sourceMessageTs
  ) return null;
  if (!batch.workspaceId && dependencies.resolveWorkspace) {
    try {
      batch.workspaceId = await dependencies.resolveWorkspace(task);
      await dependencies.store.save(batch);
    } catch {
      // Direct/public policies can still be evaluated without group metadata.
    }
  }
  return { batch, invitation, task };
}

function currentlyAssigned(task: Task, access: TaskAccess): boolean {
  if (task.assignmentTree) {
    return Object.values(task.assignmentTree.nodes).some((node) =>
      node.kind === "user" && node.principalId === access.userId &&
      ["pending", "accepted"].includes(node.status)
    );
  }
  const targets = task.assignmentBased
    ? task.assignees
    : [...task.assignees, ...task.teams];
  return targets.some((id) =>
    id === access.userId || (/^S/.test(id) && access.teamIds.includes(id))
  );
}

async function finishExecution(
  bound: BoundInvitation,
  dependencies: AssignmentDependencies,
): Promise<void> {
  const executionId = bound.invitation.executionId;
  if (
    dependencies.deliveryExecutionId && dependencies.deliveryExecutionId !== executionId
  ) return;
  // Every invitation created by this function execution belongs to this one task,
  // including assignments delegated later from a modal.
  const keys = new Set([
    ...Object.keys(bound.task.assignmentEvents ?? {}),
    bound.batch.eventKey,
  ]);
  for (const key of keys) {
    const batch = await dependencies.store.get(`${bound.task.id}:${key}`);
    if (batch?.completedExecutions?.includes(executionId)) return;
    if (
      Object.values(batch?.invitations ?? {}).some((invitation) =>
        invitation.executionId === executionId && invitation.status === "pending" &&
        batch!.delivered.includes(invitation.recipientId) &&
        !batch!.cancelled.includes(invitation.recipientId)
      )
    ) return;
  }
  const result = await dependencies.client.functions.completeSuccess({
    function_execution_id: executionId,
    outputs: { ignored: false },
  });
  if (
    !result.ok &&
    !["already_complete", "function_execution_already_completed"].includes(
      result.error ?? "",
    )
  ) {
    throw new Error(
      `Cannot complete assignment interaction: ${result.error ?? "unknown_error"}`,
    );
  }
  bound.batch.completedExecutions = [
    ...new Set([...bound.batch.completedExecutions ?? [], executionId]),
  ];
  await dependencies.store.save(bound.batch);
}

async function renderDecision(
  bound: BoundInvitation,
  dependencies: AssignmentDependencies,
): Promise<void> {
  if (dependencies.displays && await dependencies.displays.refresh(bound.task)) {
    throw new Error("Some task messages could not be refreshed.");
  }
  const { invitation } = bound;
  if (invitation.closedBy) {
    await finishExecution(bound, dependencies);
    return;
  }
  if (
    (invitation.status === "accepted" || invitation.status === "delegated") &&
    !await currentAccess(bound, dependencies)
  ) {
    // A legacy assignment may have been the actor's only viewing permission.
    // Recheck after the mutation before retaining any task title in this DM.
    invitation.status = "cancelled";
    await dependencies.store.save(bound.batch);
  }
  const channel = invitation.channelId!;
  const ts = invitation.messageTs!;
  if (invitation.status === "rejected" || invitation.status === "cancelled") {
    if (!invitation.messageRemoved) {
      const result = await dependencies.client.chat.delete({ channel, ts });
      if (!result.ok && result.error !== "message_not_found") {
        throw new Error("Cannot remove assignment message.");
      }
      invitation.messageRemoved = true;
      await dependencies.store.save(bound.batch);
    }
  } else {
    const status = invitation.status === "accepted"
      ? "✅ Accepted"
      : `↪️ Delegated to ${
        (invitation.delegatedTo ?? []).map((id) =>
          /^S/.test(id) ? `<!subteam^${id}>` : `<@${id}>`
        ).join(", ")
      }`;
    const text = `*Task #${bound.task.number}: ${
      escapeNotificationText(bound.task.name)
    }*\n\n${status}`;
    const result = await dependencies.client.chat.update({
      channel,
      ts,
      text,
      blocks: [],
    });
    if (
      !result.ok &&
      !["message_not_modified", "message_not_found"].includes(result.error ?? "")
    ) {
      throw new Error(
        `Cannot update assignment message: ${result.error ?? "unknown_error"}`,
      );
    }
  }
  await finishExecution(bound, dependencies);
}

async function currentAccess(
  bound: BoundInvitation,
  dependencies: AssignmentDependencies,
): Promise<TaskAccess | null> {
  if (bound.task.deleted) return null;
  const access = await dependencies.loadAccess(
    bound.task,
    bound.invitation.recipientId,
    bound.batch.workspaceId,
  );
  return access.userId === bound.invitation.recipientId && canViewTask(bound.task, access)
    ? access
    : null;
}

async function deliverDecision(
  bound: BoundInvitation,
  dependencies: AssignmentDependencies,
): Promise<AssignmentActionResult> {
  const delivery = await notifyTaskAssignments(
    bound.task,
    bound.batch.workspaceId,
    dependencies.client,
    dependencies.store,
    {
      executionId: dependencies.deliveryExecutionId ?? bound.invitation.executionId,
      loadTask: (id) => dependencies.repository.findById(id),
      loadAccess: dependencies.loadAccess,
      rememberTask: dependencies.rememberTask,
    },
  );
  // Delivery can cancel squad invitations or remove the rejected invitation.
  // Preserve those saved changes before rendering this recipient's decision.
  const reconciled = await dependencies.store.get(bound.batch.id);
  const invitation = reconciled?.invitations?.[bound.invitation.recipientId];
  if (reconciled && invitation) {
    bound.batch = reconciled;
    bound.invitation = invitation;
  }
  if (delivery.failed.length) {
    return {
      ok: false,
      interactive: true,
      error:
        "Your response was saved, but some assignment messages could not be delivered or updated. Retry this response, or update the task to retry delivery.",
    };
  }
  await renderDecision(bound, dependencies);
  return { ok: true, interactive: delivery.interactive };
}

async function cancelUnavailable(
  bound: BoundInvitation,
  dependencies: AssignmentDependencies,
): Promise<AssignmentActionResult> {
  bound.invitation.status = "cancelled";
  await dependencies.store.save(bound.batch);
  await renderDecision(bound, dependencies);
  return { ok: false, error: "This assignment is no longer available to you." };
}

function decisionTimestamp(suggested?: string): string {
  if (suggested && /^\d+\.\d{1,6}$/.test(suggested)) return suggested;
  const now = Date.now();
  const random = crypto.getRandomValues(new Uint16Array(1))[0] % 1000;
  return `${Math.floor(now / 1000)}.${String(now % 1000).padStart(3, "0")}${
    String(random).padStart(3, "0")
  }`;
}

async function assignmentGroupMembers(
  task: Task,
  targets: string[],
  client: AssignmentClient,
  workspaceId?: string,
): Promise<Record<string, string[]>> {
  const ids = [
    ...new Set(
      [...(task.assignmentTree ? [] : [...task.assignees, ...task.teams]), ...targets]
        .filter((id) => /^S/.test(id)),
    ),
  ];
  const entries = await Promise.all(ids.map(async (id) => {
    const result = await client.usergroups.users.list({
      usergroup: id,
      include_disabled: false,
      ...(workspaceId ? { team_id: workspaceId } : {}),
    });
    if (
      !result.ok || !Array.isArray(result.users) ||
      !result.users.every((user) =>
        typeof user === "string" && /^[UW][A-Z0-9]+$/.test(user)
      )
    ) throw new TaskCommandError("I couldn't verify all squad members. Please retry.");
    return [id, [...new Set(result.users as string[])]] as const;
  }));
  return Object.fromEntries(entries.map(([id, members]) => [id, [...members]]));
}

async function applyDecision(
  bound: BoundInvitation,
  kind: "accept" | "reject" | "delegate",
  dependencies: AssignmentDependencies,
  assignees?: string[],
  actionTs?: string,
  note?: string,
): Promise<AssignmentActionResult> {
  const access = await currentAccess(bound, dependencies);
  if (!access) return await cancelUnavailable(bound, dependencies);
  if (bound.invitation.status !== "pending") {
    if (bound.invitation.status !== "cancelled") {
      return await deliverDecision(bound, dependencies);
    }
    await renderDecision(bound, dependencies);
    return { ok: true };
  }
  const savedDecision = bound.invitation.decision;
  if (savedDecision && savedDecision.kind !== kind) {
    return {
      ok: false,
      error: "This assignment already has a response in progress. Retry that response.",
    };
  }
  const appliedKey = savedDecision &&
    `${bound.invitation.channelId}:${savedDecision.messageTs}`;
  const alreadyApplied = appliedKey && bound.task.appliedEvents?.includes(appliedKey);
  if (!alreadyApplied && !currentlyAssigned(bound.task, access)) {
    return await cancelUnavailable(bound, dependencies);
  }
  if (kind === "delegate" && !canDelegateTask(bound.task, access)) {
    return {
      ok: false,
      error:
        "You can respond to this assignment, but you do not have permission to delegate it.",
    };
  }
  if (!savedDecision) {
    bound.invitation.decision = {
      kind,
      ...(assignees ? { assignees } : {}),
      ...(note ? { note } : {}),
      messageTs: dependencies.deliveryExecutionId && bound.invitation.modalNonce
        ? `${
          Number.parseInt(
            bound.invitation.modalNonce.replaceAll("-", "").slice(0, 13),
            16,
          )
        }.000001`
        : decisionTimestamp(actionTs),
    };
    await dependencies.store.save(bound.batch);
  }
  const decision = bound.invitation.decision!;
  if (!alreadyApplied) {
    try {
      const result = await respondToAssignment(
        bound.task,
        {
          kind: decision.kind,
          ...(decision.assignees ? { assignees: decision.assignees } : {}),
          ...(decision.note ? { note: decision.note } : {}),
          ...(bound.batch.invitationKeys
            ? { invitationKeys: bound.batch.invitationKeys }
            : {}),
        },
        {
          channelId: bound.invitation.channelId!,
          messageTs: decision.messageTs,
          userId: bound.invitation.recipientId,
          groupMembers: await assignmentGroupMembers(
            bound.task,
            decision.assignees ?? [],
            dependencies.client,
            bound.batch.workspaceId,
          ),
        },
        dependencies.repository,
        access,
      );
      bound.task = result.task;
    } catch (error) {
      if (error instanceof TaskCommandError || error instanceof TaskAccessError) {
        // Validation/authorization failures never save a service event. Let the
        // user correct the modal, retaining intents only for uncertain failures.
        delete bound.invitation.decision;
        await dependencies.store.save(bound.batch);
        return { ok: false, error: error.message };
      }
      throw error;
    }
  }
  bound.invitation.status = kind === "accept"
    ? "accepted"
    : kind === "reject"
    ? "rejected"
    : "delegated";
  if (kind === "delegate") bound.invitation.delegatedTo = decision.assignees;
  // Retain the modal binding so a Slack retry can finish updating the same DM
  // after the service mutation or invitation decision has already been saved.
  await dependencies.store.save(bound.batch);
  return await deliverDecision(bound, dependencies);
}

export async function handleAssignmentAction(
  action: AssignmentAction,
  dependencies: AssignmentDependencies,
): Promise<AssignmentActionResult> {
  try {
    const ref = reference(action.value);
    const bound = await boundInvitation(
      ref,
      action.userId,
      action.executionId,
      dependencies,
    );
    if (
      !bound || bound.invitation.channelId !== action.channelId ||
      bound.invitation.messageTs !== action.messageTs
    ) return { ok: false, error: "This assignment control is not available." };
    if (
      ![
        ASSIGNMENT_ACCEPT,
        ASSIGNMENT_REJECT,
        ASSIGNMENT_DELEGATE,
        ASSIGNMENT_RETURN_DELETE,
      ].includes(
        action.actionId,
      )
    ) return { ok: false, error: "Unknown assignment response." };
    if (action.actionId === ASSIGNMENT_RETURN_DELETE) {
      const tree = bound.task.assignmentTree;
      const root = tree?.nodes[tree.rootId];
      if (
        bound.task.createdBy !== action.userId || !root?.returned ||
        root.status !== "pending" ||
        (bound.batch.invitationKeys?.length &&
          !bound.batch.invitationKeys.includes(`${root.id}:${root.generation}`))
      ) return { ok: false, error: "This creator-return control is no longer active." };
      if (bound.task.deleted) {
        await renderDecision(bound, dependencies);
        return { ok: true };
      }
      const access = await currentAccess(bound, dependencies);
      if (!access) return await cancelUnavailable(bound, dependencies);
      if (!canManageTask(bound.task, access)) {
        const request = await requestTaskAction(
          bound.task,
          "delete",
          {
            channelId: action.channelId,
            messageTs: decisionTimestamp(action.actionTs),
            userId: action.userId,
          },
          dependencies.repository,
          access,
        );
        const notifications = await notifyParticipation(
          request.task,
          bound.batch.workspaceId,
          dependencies.client,
          {
            executionId: dependencies.deliveryExecutionId ?? action.executionId,
            loadAccess: dependencies.loadAccess,
            rememberTask: dependencies.rememberTask,
          },
          dependencies.repository,
        );
        if (dependencies.displays) await dependencies.displays.refresh(request.task);
        return notifications.failed.length
          ? {
            ok: false,
            error:
              "Deletion requested, but some Access holders could not be notified. Retry Delete.",
          }
          : { ok: true, interactive: true };
      }
      // Use the deletion service so Access is checked on the fresh task state,
      // just as it is for a typed delete command.
      await deleteTask(
        bound.task,
        {
          channelId: action.channelId,
          messageTs: decisionTimestamp(action.actionTs),
          userId: action.userId,
        },
        dependencies.repository,
        access,
      );
      bound.task = { ...bound.task, deleted: true };
      bound.invitation.status = "rejected";
      await dependencies.store.save(bound.batch);
      return await deliverDecision(bound, dependencies);
    }
    if (action.actionId !== ASSIGNMENT_DELEGATE) {
      return await applyDecision(
        bound,
        action.actionId === ASSIGNMENT_ACCEPT ? "accept" : "reject",
        dependencies,
        undefined,
        action.actionTs,
      );
    }
    const access = await currentAccess(bound, dependencies);
    if (!access || !currentlyAssigned(bound.task, access)) {
      return await cancelUnavailable(bound, dependencies);
    }
    if (!canDelegateTask(bound.task, access)) {
      return { ok: false, error: "You do not have permission to delegate this task." };
    }
    if (bound.invitation.status !== "pending" || bound.invitation.decision) {
      return { ok: false, error: "This assignment already has a response." };
    }
    if (!action.interactivityPointer) {
      return { ok: false, error: "Open Delegate again to choose an assignee." };
    }
    let workerUrl: string | undefined;
    try {
      workerUrl = await dependencies.delegationEndpoint?.();
    } catch {
      return {
        ok: false,
        error:
          "The delegation workflow is not ready. Restart DeleBot and approve its updated app permissions, then reopen Delegate. If it still fails, check the workflow activity log.",
      };
    }
    const nonce = crypto.randomUUID();
    bound.invitation.modalNonce = nonce;
    delete bound.invitation.modalId;
    await dependencies.store.save(bound.batch);
    const opened = await dependencies.client.views.open({
      interactivity_pointer: action.interactivityPointer,
      view: {
        type: "modal",
        callback_id: ASSIGNMENT_DELEGATE_VIEW,
        private_metadata: JSON.stringify({
          ...ref,
          nonce,
          ...(workerUrl ? { workerUrl, channelId: bound.invitation.channelId } : {}),
        }),
        title: { type: "plain_text", text: "Delegate task" },
        submit: { type: "plain_text", text: "Delegate" },
        close: { type: "plain_text", text: "Cancel" },
        blocks: [
          {
            type: "input",
            block_id: "delegation_recipients",
            label: { type: "plain_text", text: "People and teams" },
            hint: {
              type: "plain_text",
              text: "Use @ to mention one or more people or teams (up to 20).",
            },
            element: {
              type: "rich_text_input",
              action_id: "recipients",
              placeholder: { type: "plain_text", text: "@person @team" },
              focus_on_load: true,
            },
          },
          {
            type: "input",
            block_id: "delegation_note",
            optional: true,
            label: { type: "plain_text", text: "Note" },
            hint: {
              type: "plain_text",
              text:
                "Sent to the recipients with their invitation. Leave blank to send no note.",
            },
            element: {
              type: "plain_text_input",
              action_id: "note",
              multiline: true,
              max_length: 2000,
            },
          },
        ],
      },
    });
    if (!opened.ok || !opened.view?.id) {
      return { ok: false, error: "I could not open Delegate. Try again." };
    }
    bound.invitation.modalId = opened.view.id;
    await dependencies.store.save(bound.batch);
    return { ok: true, interactive: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = /: ([a-z_]+)$/.exec(message)?.[1] ?? "unexpected_error";
    console.error(
      JSON.stringify({
        event: "assignment_action_failed",
        action_id: action.actionId,
        error_code: code,
      }),
    );
    return {
      ok: false,
      error:
        "I could not finish this assignment response. Retry it, or use the task's thread. The saved task state will be checked before applying it again.",
    };
  }
}

async function delegationTargets(
  submission: AssignmentSubmission,
  bound: BoundInvitation,
  dependencies: AssignmentDependencies,
): Promise<string[] | null> {
  if (
    (submission.selectedUsers !== undefined &&
      (!Array.isArray(submission.selectedUsers) ||
        !submission.selectedUsers.every((id) => /^[UW][A-Z0-9]+$/.test(id))))
  ) return null;
  const targets = new Set(submission.selectedUsers ?? []);
  const text = submission.recipients !== undefined
    ? recipientMentions(submission.recipients)
    : (submission.teamText ?? "").trim();
  if (text === undefined) return null;
  const mentions = /<@([UW][A-Z0-9]+)(?:\|[^>]+)?>|<!subteam\^(S[A-Z0-9]+)(?:\|[^>]+)?>/g;
  for (const mention of text.matchAll(mentions)) targets.add(mention[1] ?? mention[2]);
  const rest = text.replace(mentions, " ").trim();
  if (rest.replace(/[\s,]/g, "")) {
    const groups = await dependencies.client.usergroups.list({
      include_users: false,
      include_count: false,
      include_disabled: false,
      ...(bound.batch.workspaceId ? { team_id: bound.batch.workspaceId } : {}),
    });
    if (!groups.ok || !Array.isArray(groups.usergroups)) {
      throw new Error("Cannot verify target teams.");
    }
    const handles = new Map<string, string>();
    for (const raw of groups.usergroups) {
      if (!raw || typeof raw !== "object") throw new Error("Invalid target teams.");
      const group = raw as Record<string, unknown>;
      if (
        typeof group.id !== "string" || !/^S[A-Z0-9]+$/.test(group.id) ||
        typeof group.date_delete !== "number"
      ) throw new Error("Invalid target teams.");
      if (group.date_delete !== 0) continue;
      if (typeof group.handle === "string" && group.handle) {
        handles.set(group.handle.toLowerCase().replace(/^@/, ""), group.id);
      }
    }
    for (const handle of rest.split(/[\s,]+/).filter(Boolean)) {
      const id = handles.get(handle.toLowerCase().replace(/^@/, ""));
      if (!id) return null;
      targets.add(id);
    }
  }
  return targets.size && targets.size <= 20 ? [...targets] : null;
}

async function targetViewError(
  targets: string[],
  bound: BoundInvitation,
  dependencies: AssignmentDependencies,
): Promise<string | undefined> {
  for (const target of targets) {
    if (/^[UW]/.test(target)) {
      if (canViewTask(bound.task, { userId: target, teamIds: [] })) continue;
      const access = await dependencies.loadAccess(
        bound.task,
        target,
        bound.batch.workspaceId,
      );
      if (access.userId !== target || !canViewTask(bound.task, access)) {
        return "That person needs viewing permission first.";
      }
    } else {
      const response = await dependencies.client.usergroups.users.list({
        usergroup: target,
        include_disabled: false,
        ...(bound.batch.workspaceId ? { team_id: bound.batch.workspaceId } : {}),
      });
      if (
        !response.ok || !Array.isArray(response.users) ||
        !response.users.every((id) =>
          typeof id === "string" && /^[UW][A-Z0-9]+$/.test(id)
        )
      ) return "I could not verify that team's viewing permission. Please try again.";
      let visible = false;
      if (
        response.users.some((userId: string) =>
          canViewTask(bound.task, { userId, teamIds: [] })
        )
      ) continue;
      for (const member of response.users as string[]) {
        const access = await dependencies.loadAccess(
          bound.task,
          member,
          bound.batch.workspaceId,
        );
        if (access.userId === member && canViewTask(bound.task, access)) {
          visible = true;
          break;
        }
      }
      if (!visible) return "That team needs a member with viewing permission first.";
    }
  }
}

export async function handleAssignmentSubmission(
  submission: AssignmentSubmission,
  dependencies: AssignmentDependencies,
): Promise<AssignmentActionResult> {
  try {
    const ref = reference(submission.privateMetadata);
    const bound = await boundInvitation(
      ref,
      submission.userId,
      submission.executionId,
      dependencies,
    );
    if (
      !bound || !ref?.nonce || ref.nonce !== bound.invitation.modalNonce ||
      submission.viewId !== bound.invitation.modalId
    ) {
      return {
        ok: false,
        error: "This delegation form is no longer available. Open Delegate again.",
      };
    }
    if (bound.invitation.status !== "pending" || bound.invitation.decision) {
      return await applyDecision(bound, "delegate", dependencies);
    }
    if (
      submission.note !== undefined &&
      (typeof submission.note !== "string" || submission.note.length > 2000)
    ) {
      return {
        ok: false,
        error: "Keep the note to 2,000 characters or fewer.",
        errorField: "delegation_note",
      };
    }
    const access = await currentAccess(bound, dependencies);
    if (!access || !currentlyAssigned(bound.task, access)) {
      return await cancelUnavailable(bound, dependencies);
    }
    if (!canDelegateTask(bound.task, access)) {
      return { ok: false, error: "You do not have permission to delegate this task." };
    }
    const targets = await delegationTargets(submission, bound, dependencies);
    if (!targets) {
      return {
        ok: false,
        error:
          "Choose at least one person or active Slack user-group handle, up to 20 assignees.",
      };
    }
    const viewError = await targetViewError(targets, bound, dependencies);
    if (viewError) return { ok: false, error: viewError };
    return await applyDecision(
      bound,
      "delegate",
      dependencies,
      targets,
      undefined,
      submission.note?.trim(),
    );
  } catch {
    return { ok: false, error: "I could not delegate this task. Please try again." };
  }
}

export function productionDependencies(client: SlackAPIClient): AssignmentDependencies {
  return {
    delegationEndpoint: () => delegationEndpoint(client),
    displays: taskDisplays(client),
    rememberTask: async (channel, ts, user, id) => {
      const store = new SlackDmContexts(client);
      await store.save(channel, ts, user, [id], "invitation");
      await store.save(channel, ts, "*", [id], "context");
      await store.save(channel, "latest", user, [id]);
    },
    client,
    repository: new SlackTaskRepository(client),
    store: new SlackNotificationStore(client),
    resolveWorkspace: (task) => resolveWorkspace(client, task.channelId, {}),
    loadAccess: taskAccessLoader(client),
  };
}

export async function assignmentBlockActionHandler(
  { body, action, client }: ActionContext<Record<string, unknown>>,
  dispatch = dispatchDelegation,
): Promise<void> {
  const raw = action as unknown as Record<string, unknown>;
  const container = body.container as { channel_id?: string; message_ts?: string };
  const submitted: AssignmentAction = {
    actionId: typeof raw.action_id === "string" ? raw.action_id : "",
    value: typeof raw.value === "string" ? raw.value : "",
    userId: body.user.id,
    channelId: container.channel_id ?? "",
    messageTs: container.message_ts ?? "",
    executionId: body.function_data.execution_id,
    interactivityPointer: body.interactivity.interactivity_pointer,
    actionTs: typeof raw.action_ts === "string" ? raw.action_ts : undefined,
  };
  const dependencies = productionDependencies(client);
  let result: AssignmentActionResult;
  if (
    [ASSIGNMENT_ACCEPT, ASSIGNMENT_REJECT, ASSIGNMENT_RETURN_DELETE].includes(
      submitted.actionId,
    )
  ) {
    try {
      await dispatch(
        await delegationEndpoint(client),
        { kind: "assignment_action", action: submitted },
        submitted.channelId,
        submitted.userId,
      );
      return;
    } catch {
      result = {
        ok: false,
        error:
          "Slack could not confirm receipt of your response. Please retry; your task won't be changed twice.",
      };
    }
  } else result = await handleAssignmentAction(submitted, dependencies);

  if (!result.ok && result.error && container.channel_id) {
    await client.chat.postEphemeral({
      channel: container.channel_id,
      user: body.user.id,
      text: result.error,
    });
  }
}

export async function assignmentViewSubmissionHandler(
  { body, view }: ViewSubmissionContext<Record<string, unknown>>,
  dispatch = dispatchDelegation,
) {
  const values = view.state.values;
  const recipientValue = values.delegation_recipients?.recipients as unknown as {
    rich_text_value?: unknown;
  } | undefined;
  const submission: AssignmentSubmission = {
    privateMetadata: view.private_metadata ?? "",
    userId: body.user.id,
    viewId: view.id,
    executionId: body.function_data.execution_id,
    ...(recipientValue ? { recipients: recipientValue.rich_text_value } : {}),
    note: values.delegation_note?.note?.value ?? "",
    selectedUsers: values.delegation_people?.people?.selected_users ?? [],
    teamText: values.delegation_teams?.teams?.value ?? "",
  };
  const result = await queueDelegationSubmission(submission, dispatch);

  return result.ok ? { response_action: "clear" as const } : {
    response_action: "errors" as const,
    errors: {
      [
        result.errorField ??
          (recipientValue ? "delegation_recipients" : "delegation_teams")
      ]: result.error ?? "Could not delegate task.",
    },
  };
}

/** Only local input validation and one durable handoff belong on the modal deadline. */
export async function queueDelegationSubmission(
  submission: AssignmentSubmission,
  dispatch = dispatchDelegation,
): Promise<AssignmentActionResult> {
  const text = submission.recipients !== undefined
    ? recipientMentions(submission.recipients)
    : [...submission.selectedUsers ?? [], submission.teamText ?? ""].join(" ").trim();
  if (!text?.trim()) return { ok: false, error: "Mention at least one person or team." };
  if (submission.note && submission.note.length > 2000) {
    return {
      ok: false,
      error: "Keep the note to 2,000 characters or fewer.",
      errorField: "delegation_note",
    };
  }
  try {
    const metadata = JSON.parse(submission.privateMetadata);
    const ref = reference(submission.privateMetadata);
    if (
      !ref?.nonce || ref.recipientId !== submission.userId ||
      !isDelegationEndpoint(metadata.workerUrl) ||
      !/^D[A-Z0-9]+$/.test(metadata.channelId)
    ) {
      return { ok: false, error: "Reopen Delegate to load the updated form." };
    }
    await dispatch(metadata.workerUrl, submission, metadata.channelId, submission.userId);
    return { ok: true };
  } catch {
    return {
      ok: false,
      error:
        "Slack could not confirm receipt. Retry Delegate; repeated submissions do not delegate twice.",
    };
  }
}

/** The webhook is not an authorization source: verify its invitation and nonce again. */
export async function runQueuedDelegation(
  submission: AssignmentSubmission,
  dependencies: AssignmentDependencies,
): Promise<AssignmentActionResult> {
  const ref = reference(submission.privateMetadata);
  const bound = await boundInvitation(
    ref,
    submission.userId,
    submission.executionId,
    dependencies,
  );
  if (
    !bound || !ref?.nonce || ref.nonce !== bound.invitation.modalNonce ||
    submission.viewId !== bound.invitation.modalId
  ) return { ok: false, error: "This delegation form is no longer available." };
  const result = await handleAssignmentSubmission(submission, dependencies);
  if (!result.ok) {
    const access = await currentAccess(bound, dependencies);
    if (access) {
      const message = {
        channel: bound.invitation.channelId!,
        text: `${taskTitle(bound.task)}\n\n${
          result.error ?? "Delegation could not be completed. Open Delegate to retry."
        }`,
        unfurl_links: false,
        unfurl_media: false,
      };
      const sent = await dependencies.client.chat.postMessage({
        ...message,
        thread_ts: bound.invitation.messageTs!,
      });
      // The delegation may have committed and removed its source invitation
      // before a later notification failed. Still give the sender a recovery path.
      if (!sent.ok) {
        const fallback = await dependencies.client.chat.postMessage(message);
        if (!fallback.ok) throw new Error("Cannot report delegation failure.");
        if (fallback.ts) {
          await dependencies.rememberTask?.(
            message.channel,
            fallback.ts,
            submission.userId,
            bound.task.id,
          );
        }
      } else if (sent.ts) {
        await dependencies.rememberTask?.(
          message.channel,
          sent.ts,
          submission.userId,
          bound.task.id,
        );
      }
    }
  }
  return result;
}

/** Reauthenticate queued button actions against their original invitation. */
export async function runQueuedAssignmentAction(
  action: AssignmentAction,
  dependencies: AssignmentDependencies,
): Promise<AssignmentActionResult> {
  if (
    ![ASSIGNMENT_ACCEPT, ASSIGNMENT_REJECT, ASSIGNMENT_RETURN_DELETE].includes(
      action.actionId,
    )
  ) return { ok: false, error: "Unsupported queued response." };
  const bound = await boundInvitation(
    reference(action.value),
    action.userId,
    action.executionId,
    dependencies,
  );
  if (
    !bound || bound.invitation.channelId !== action.channelId ||
    bound.invitation.messageTs !== action.messageTs
  ) return { ok: false, error: "This assignment control is no longer available." };
  const result = await handleAssignmentAction(action, dependencies);
  if (!result.ok && await currentAccess(bound, dependencies)) {
    const sent = await dependencies.client.chat.postMessage({
      channel: action.channelId,
      text: `${taskTitle(bound.task)}\n\n${
        result.error ?? "Response could not be completed. Retry in the task's thread."
      }`,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (sent.ok && sent.ts) {
      await dependencies.rememberTask?.(
        action.channelId,
        sent.ts,
        action.userId,
        bound.task.id,
      );
    }
  }
  return result;
}
