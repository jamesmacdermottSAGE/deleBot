import { withKeyLock } from "./mutation.ts";
import {
  canAccessTask,
  canManageTask,
  effectiveTaskViewPerms,
  isTaskAssignees,
} from "./access.ts";
import type { Task, TaskAccess } from "./models.ts";
import type { TaskRepository } from "./repository.ts";
import {
  mutationKey,
  TaskAccessError,
  TaskCommandError,
  type TaskContext,
} from "./service.ts";

export interface CollaborationInvitation {
  status: "pending" | "accepted" | "rejected";
  invitedBy: string;
  eventKey: string;
}

export interface TaskActionRequest {
  kind: "complete" | "incomplete" | "delete";
  requestedBy: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  eventKey: string;
  resolvedBy?: string;
  confirmations?: Array<{ channelId: string; messageTs: string; userId: string }>;
}

export interface ParticipationDelivery {
  kind: "collaboration" | "approval";
  /** Slack people or user groups; expanded and verified again at delivery time. */
  recipients: string[];
  reference: string;
  deliveries?: Record<string, ParticipationBinding>;
  workspaceId?: string;
  confirmations?: Array<{ channelId: string; messageTs: string; userId: string }>;
}

export interface ParticipationBinding {
  id: string;
  executionId: string;
  status: "pending" | "accepted" | "rejected" | "approved" | "cancelled";
  channelId?: string;
  messageTs?: string;
  contextSaved?: boolean;
}

export interface TaskParticipation {
  collaborators: Record<string, CollaborationInvitation>;
  requests: Record<string, TaskActionRequest>;
  deliveryEvents: Record<string, ParticipationDelivery>;
  completedExecutions?: string[];
}

type ParticipatingTask = Task & { participation?: TaskParticipation };
type MutationResult = { task: ParticipatingTask; updated: boolean };

const isUser = (value: unknown): value is string =>
  typeof value === "string" && /^[UW][A-Z0-9]+$/.test(value);
const isKey = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 400;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Persisted participation metadata must never create privileges when malformed. */
export function parseParticipation(value: unknown): TaskParticipation {
  if (
    !record(value) || !record(value.collaborators) || !record(value.requests) ||
    !record(value.deliveryEvents)
  ) {
    throw new Error("Invalid task participation metadata.");
  }
  if (
    value.completedExecutions !== undefined &&
    (!Array.isArray(value.completedExecutions) ||
      !value.completedExecutions.every(isKey) ||
      new Set(value.completedExecutions).size !== value.completedExecutions.length)
  ) throw new Error("Invalid participation execution state.");
  for (const [id, entry] of Object.entries(value.collaborators)) {
    if (
      !isUser(id) || !record(entry) ||
      !["pending", "accepted", "rejected"].includes(entry.status as string) ||
      !isUser(entry.invitedBy) || !isKey(entry.eventKey)
    ) {
      throw new Error("Invalid collaboration invitation.");
    }
  }
  for (const [id, entry] of Object.entries(value.requests)) {
    if (
      !isKey(id) || !record(entry) ||
      !["complete", "incomplete", "delete"].includes(entry.kind as string) ||
      !["pending", "approved", "rejected", "cancelled"].includes(
        entry.status as string,
      ) || !isUser(entry.requestedBy) || !isKey(entry.eventKey) ||
      (entry.resolvedBy !== undefined && !isUser(entry.resolvedBy))
    ) {
      throw new Error("Invalid task action request.");
    }
  }
  for (const entry of Object.values(value.requests)) {
    const request = entry as Record<string, unknown>;
    if (
      request.confirmations !== undefined &&
      (!Array.isArray(request.confirmations) ||
        !request.confirmations.every((message) =>
          record(message) && typeof message.channelId === "string" &&
          /^[CDG][A-Z0-9]+$/.test(message.channelId) &&
          typeof message.messageTs === "string" && /^\d+\.\d+$/.test(message.messageTs) &&
          isUser(message.userId) && message.userId === request.requestedBy
        ))
    ) throw new Error("Invalid task request confirmation.");
  }
  for (const [id, entry] of Object.entries(value.deliveryEvents)) {
    if (
      !isKey(id) || !record(entry) ||
      !["collaboration", "approval"].includes(entry.kind as string) ||
      !isTaskAssignees(entry.recipients) || !entry.recipients.length ||
      new Set(entry.recipients).size !== entry.recipients.length ||
      !isKey(entry.reference)
    ) {
      throw new Error("Invalid participation delivery event.");
    }
    if (
      entry.workspaceId !== undefined &&
      (typeof entry.workspaceId !== "string" || !/^T[A-Z0-9]+$/.test(entry.workspaceId))
    ) throw new Error("Invalid participation workspace.");
    if (entry.kind === "approval" && !Object.hasOwn(value.requests, entry.reference)) {
      throw new Error("Invalid approval delivery reference.");
    }
    if (
      entry.kind === "collaboration" && entry.recipients.some((user) => !isUser(user))
    ) {
      throw new Error("Invalid collaboration delivery recipients.");
    }
    if (
      entry.confirmations !== undefined &&
      (!Array.isArray(entry.confirmations) ||
        !entry.confirmations.every((message) =>
          record(message) && typeof message.channelId === "string" &&
          /^[CDG][A-Z0-9]+$/.test(message.channelId) &&
          typeof message.messageTs === "string" && /^\d+\.\d+$/.test(message.messageTs) &&
          isUser(message.userId)
        ))
    ) {
      throw new Error("Invalid collaboration confirmation.");
    }
    if (entry.deliveries !== undefined) {
      if (!record(entry.deliveries)) throw new Error("Invalid participation bindings.");
      for (const [user, binding] of Object.entries(entry.deliveries)) {
        if (
          !isUser(user) || !record(binding) || typeof binding.id !== "string" ||
          !/^[a-f0-9-]{36}$/.test(binding.id) || !isKey(binding.executionId) ||
          !["pending", "accepted", "rejected", "approved", "cancelled"].includes(
            binding.status as string,
          ) ||
          (binding.channelId !== undefined &&
            (typeof binding.channelId !== "string" ||
              !/^D[A-Z0-9]+$/.test(binding.channelId))) ||
          (binding.contextSaved !== undefined &&
            typeof binding.contextSaved !== "boolean") ||
          (binding.messageTs !== undefined &&
            (typeof binding.messageTs !== "string" ||
              !/^\d+\.\d{1,6}$/.test(binding.messageTs)))
        ) throw new Error("Invalid participation binding.");
      }
    }
  }
  return structuredClone(value) as unknown as TaskParticipation;
}

function metadata(task: ParticipatingTask): TaskParticipation {
  return task.participation
    ? parseParticipation(task.participation)
    : { collaborators: {}, requests: {}, deliveryEvents: {} };
}

function authorizeViewer(
  task: ParticipatingTask,
  context: TaskContext,
  access: TaskAccess,
): string {
  if (
    !isUser(context.userId) || context.userId !== access.userId ||
    !canAccessTask(task, access)
  ) {
    throw new TaskAccessError("This task is not available to you.");
  }
  return mutationKey(context);
}

export function taskCanCollaborate(task: ParticipatingTask, userId: string): boolean {
  return !task.deleted && !task.completed && task.assignees.includes(userId) &&
    task.assignmentResponses?.[userId]?.status === "accepted";
}

export function isTaskCollaborator(task: ParticipatingTask, userId: string): boolean {
  return task.participation?.collaborators[userId]?.status === "accepted";
}

/** Only the current accepted owner invites collaborators; collaboration never changes ownership or access. */
async function inviteCollaboratorsUnlocked(
  task: ParticipatingTask,
  users: string[],
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
): Promise<MutationResult> {
  const key = authorizeViewer(task, context, access);
  if (task.appliedEvents?.includes(key)) return { task, updated: false };
  if (!taskCanCollaborate(task, context.userId)) {
    throw new TaskAccessError("Only the accepted assignee can invite collaborators.");
  }
  if (
    !Array.isArray(users) || !users.length || users.length > 20 || !users.every(isUser) ||
    users.includes(context.userId)
  ) {
    throw new TaskCommandError(
      "Choose one or more other people to collaborate, up to 20.",
    );
  }
  const participation = metadata(task);
  const invited = [...new Set(users)].filter((user) =>
    !["pending", "accepted"].includes(participation.collaborators[user]?.status ?? "")
  );
  if (!invited.length) return { task, updated: false };
  for (const user of invited) {
    participation.collaborators[user] = {
      status: "pending",
      invitedBy: context.userId,
      eventKey: key,
    };
  }
  participation.deliveryEvents[key] = {
    kind: "collaboration",
    recipients: invited,
    reference: key,
  };
  const next: ParticipatingTask = {
    ...task,
    participation,
    appliedEvents: [...task.appliedEvents ?? [], key],
  };
  await repository.save(next);
  return { task: next, updated: true };
}

/** Recipients answer their own collaboration invitation without accepting the task assignment. */
async function respondToCollaborationUnlocked(
  task: ParticipatingTask,
  decision: "accept" | "reject",
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
): Promise<MutationResult> {
  const key = authorizeViewer(task, context, access);
  if (task.appliedEvents?.includes(key)) return { task, updated: false };
  if (!["accept", "reject"].includes(decision)) {
    throw new TaskCommandError(
      "Choose accept or reject for the collaboration invitation.",
    );
  }
  const participation = metadata(task);
  const invitation = participation.collaborators[context.userId];
  if (!invitation || invitation.status !== "pending") {
    throw new TaskCommandError(
      "You do not have a pending collaboration invitation for this task.",
    );
  }
  if (!taskCanCollaborate(task, invitation.invitedBy)) {
    throw new TaskAccessError(
      "This collaboration invitation is no longer available because the inviting assignee changed.",
    );
  }
  invitation.status = decision === "accept" ? "accepted" : "rejected";
  const next: ParticipatingTask = {
    ...task,
    participation,
    appliedEvents: [...task.appliedEvents ?? [], key],
  };
  await repository.save(next);
  return { task: next, updated: true };
}

/** Access recipients use the explicit access field, with the original legacy policy as fallback. */
export function taskActionApprovers(task: ParticipatingTask): string[] {
  const principals = task.editPerms ??
    effectiveTaskViewPerms({ ...task, viewPerms: undefined });
  return isTaskAssignees(principals) ? [...new Set(principals)] : [];
}

/** An unauthorized viewer asks permitted people to complete or delete; the task stays unchanged until approval. */
async function requestTaskActionUnlocked(
  task: ParticipatingTask,
  kind: "complete" | "incomplete" | "delete",
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
): Promise<MutationResult & { requestId: string }> {
  const key = authorizeViewer(task, context, access);
  const participation = metadata(task);
  if (task.appliedEvents?.includes(key)) {
    return {
      task,
      updated: false,
      requestId: participation.deliveryEvents[key]?.reference ?? key,
    };
  }
  if (!["complete", "incomplete", "delete"].includes(kind)) {
    throw new TaskCommandError("Choose completion or deletion.");
  }
  if (canManageTask(task, access)) {
    throw new TaskCommandError(
      "You already have access to perform this action directly.",
    );
  }
  if (kind === "complete" && task.completed) {
    throw new TaskCommandError("This task is already complete.");
  }
  if (kind === "incomplete" && !task.completed) {
    throw new TaskCommandError("This task is already incomplete.");
  }
  const existing = Object.entries(participation.requests).find(([, request]) =>
    request.kind === kind && request.requestedBy === context.userId &&
    request.status === "pending"
  );
  if (existing) return { task, updated: false, requestId: existing[0] };
  const recipients = taskActionApprovers(task);
  if (!recipients.length || recipients.includes("all")) {
    throw new TaskCommandError(
      "No eligible access holders could be identified. Update the task's access field before requesting this action.",
    );
  }
  participation.requests[key] = {
    kind,
    requestedBy: context.userId,
    status: "pending",
    eventKey: key,
  };
  participation.deliveryEvents[key] = { kind: "approval", recipients, reference: key };
  const next: ParticipatingTask = {
    ...task,
    participation,
    appliedEvents: [...task.appliedEvents ?? [], key],
  };
  await repository.save(next);
  return { task: next, updated: true, requestId: key };
}

/** Fresh access is checked for every response, including retries; old buttons never retain revoked authority. */
async function respondToTaskActionUnlocked(
  task: ParticipatingTask,
  requestId: string,
  decision: "approve" | "reject",
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
): Promise<MutationResult> {
  const key = authorizeViewer(task, context, access);
  if (!canManageTask(task, access)) {
    throw new TaskAccessError(
      "Only people in the task's access field can approve or reject this request.",
    );
  }
  if (task.appliedEvents?.includes(key)) return { task, updated: false };
  if (!["approve", "reject"].includes(decision)) {
    throw new TaskCommandError("Choose approve or reject for this request.");
  }
  const participation = metadata(task);
  const request = participation.requests[requestId];
  if (!request || request.status !== "pending") {
    throw new TaskCommandError("That request is no longer pending.");
  }
  request.status = decision === "approve" ? "approved" : "rejected";
  request.resolvedBy = context.userId;
  const next: ParticipatingTask = {
    ...task,
    participation,
    appliedEvents: [...task.appliedEvents ?? [], key],
  };
  if (decision === "approve") {
    if (request.kind === "complete" || request.kind === "incomplete") {
      next.completed = request.kind === "complete";
      next.status = next.completed ? "completed" : "open";
    } else next.deleted = true;
    for (const other of Object.values(participation.requests)) {
      if (other.status !== "pending") continue;
      if (other.kind === request.kind) {
        other.status = "approved";
        other.resolvedBy = context.userId;
      } else if (next.deleted) {
        other.status = "cancelled";
        other.resolvedBy = context.userId;
      }
    }
  }
  await repository.save(next);
  return { task: next, updated: true };
}

async function freshMutation<T>(
  task: ParticipatingTask,
  repository: TaskRepository,
  mutate: (current: ParticipatingTask) => Promise<T>,
): Promise<T> {
  return await withKeyLock(task.id, async () => {
    const current = await repository.findById(task.id);
    if (!current) throw new TaskCommandError("This task is no longer available.");
    return await mutate(current);
  });
}

export async function inviteCollaborators(
  task: ParticipatingTask,
  users: string[],
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
): Promise<MutationResult> {
  return await freshMutation(
    task,
    repository,
    (current) => inviteCollaboratorsUnlocked(current, users, context, repository, access),
  );
}

export async function respondToCollaboration(
  task: ParticipatingTask,
  decision: "accept" | "reject",
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
  invitationEventKey?: string,
): Promise<MutationResult> {
  return await freshMutation(task, repository, (current) => {
    if (
      invitationEventKey &&
      current.participation?.collaborators[access.userId]?.eventKey !== invitationEventKey
    ) throw new TaskCommandError("This collaboration invitation has been replaced.");
    return respondToCollaborationUnlocked(current, decision, context, repository, access);
  });
}

export async function requestTaskAction(
  task: ParticipatingTask,
  kind: "complete" | "incomplete" | "delete",
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
): Promise<MutationResult & { requestId: string }> {
  return await freshMutation(
    task,
    repository,
    (current) => requestTaskActionUnlocked(current, kind, context, repository, access),
  );
}

export async function respondToTaskAction(
  task: ParticipatingTask,
  requestId: string,
  decision: "approve" | "reject",
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
): Promise<MutationResult> {
  return await freshMutation(
    task,
    repository,
    (current) =>
      respondToTaskActionUnlocked(
        current,
        requestId,
        decision,
        context,
        repository,
        access,
      ),
  );
}

/** Record the requester's acknowledgement so a later decision updates that same message. */
export async function rememberRequestConfirmation(
  task: Task,
  requestId: string,
  message: { channelId: string; messageTs: string; userId: string },
  repository: TaskRepository,
): Promise<Task> {
  return await freshMutation(task, repository, async (current) => {
    const participation = metadata(current);
    const request = participation.requests[requestId];
    if (!request || request.requestedBy !== message.userId) {
      throw new TaskCommandError("This request confirmation is not available.");
    }
    request.confirmations ??= [];
    if (
      !request.confirmations.some((entry) =>
        entry.channelId === message.channelId && entry.messageTs === message.messageTs
      )
    ) request.confirmations.push(message);
    const next = { ...current, participation };
    await repository.save(next);
    return next;
  });
}

/** Remember the inviter's request so it reflects every invitee's eventual answer. */
export async function rememberCollaborationConfirmation(
  task: Task,
  eventKey: string,
  message: { channelId: string; messageTs: string; userId: string },
  repository: TaskRepository,
): Promise<Task> {
  return await freshMutation(task, repository, async (current) => {
    const participation = metadata(current);
    const delivery = participation.deliveryEvents[eventKey];
    if (
      delivery?.kind !== "collaboration" ||
      !delivery.recipients.every((user) =>
        participation.collaborators[user]?.eventKey === eventKey &&
        participation.collaborators[user]?.invitedBy === message.userId
      )
    ) {
      throw new TaskCommandError("This collaboration confirmation is not available.");
    }
    delivery.confirmations ??= [];
    if (
      !delivery.confirmations.some((entry) =>
        entry.channelId === message.channelId && entry.messageTs === message.messageTs
      )
    ) delivery.confirmations.push(message);
    const next = { ...current, participation };
    await repository.save(next);
    return next;
  });
}
