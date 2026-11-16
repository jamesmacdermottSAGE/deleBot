import { TaskLockTimeoutError } from "../tasks/mutation.ts";
import { describeTaskChanges } from "./task_changes.ts";
import { delegationEndpoint } from "./delegation_dispatch.ts";
import {
  productionDependencies,
  runQueuedAssignmentAction,
  runQueuedDelegation,
} from "./actions.ts";
import type { AssignmentSubmission } from "./actions.ts";
import { DefineFunction, Schema, SlackFunction } from "deno-slack-sdk/mod.ts";
import { resetTaskDatabase } from "../tasks/reset.ts";
import { clearDmHistory } from "./clear.ts";
import { taskAccessLoader } from "./access_context.ts";
import { SlackAPI } from "deno-slack-api/mod.ts";
import { canManageTask } from "../tasks/access.ts";
import {
  inviteCollaborators,
  rememberCollaborationConfirmation,
  rememberRequestConfirmation,
  requestTaskAction,
  respondToCollaboration,
  respondToTaskAction,
} from "../tasks/participation.ts";
import {
  collaborationStatusText,
  handleParticipationAction,
  notifyParticipation,
  PARTICIPATION_ACTION_IDS,
  type ParticipationClient,
  requestStatusText,
} from "./participation_messages.ts";
import { type TaskDisplays, taskDisplays } from "./task_displays.ts";
import { type DmContexts, expandTeamHandles, SlackDmContexts } from "./dm_context.ts";
import type { TaskAccess } from "../tasks/models.ts";
import type { Task } from "../tasks/models.ts";
import type { TaskContext } from "../tasks/service.ts";

async function resolveDmTarget(
  number: number | undefined,
  context: TaskContext,
  repository: TaskRepository,
  access: TaskAccess,
  conversations?: DmContexts,
  key = "latest",
) {
  if (number === undefined && conversations) {
    const personal = await conversations.get(context.channelId, key, context.userId);
    const ids = personal.length || key === "latest"
      ? personal
      : await conversations.get(context.channelId, key, "*");
    if (ids.length > 1) {
      throw new TaskCommandError(
        "Several tasks were shown. Use a task number, e.g. 123 complete, or use ls task Name to select one.",
      );
    }
    if (ids.length === 1) {
      const task = await repository.findById(ids[0]);
      if (!task || !canAccessTask(task, access)) {
        throw new TaskCommandError(
          "That task is no longer available to you. List your tasks again.",
        );
      }
      return task;
    }
  }
  return await resolveTaskForUpdate(number, context, repository, access);
}
import {
  parseTaskCommand,
  TASK_CREATE_USAGE,
  TASK_LIST_USAGE,
} from "../tasks/commands.ts";
import {
  SlackTaskRepository,
  TaskReferenceError,
  type TaskRepository,
} from "../tasks/repository.ts";
import {
  createTask,
  deleteTask,
  listTasks,
  mutationKey,
  resolveTaskForUpdate,
  respondToAssignment,
  TaskAccessError,
  TaskCommandError,
  updateTask,
} from "../tasks/service.ts";
import {
  type NotificationClient,
  type NotificationContext,
  type NotificationStore,
  notifyTaskAssignments,
  SlackNotificationStore,
} from "./notifications.ts";
import {
  formatTask,
  GREETING,
  splitPrivateReply,
  splitTaskReply,
  taskTitle,
  UNKNOWN_COMMAND,
} from "./messages.ts";
import {
  membershipHelp,
  SlackTeamDirectory,
  type TeamDirectory,
  type TeamSnapshot,
} from "./teams.ts";
import { resolveWorkspace, type WorkspaceClient } from "./workspace.ts";
import { canAccessTask, isPublicTask } from "../tasks/access.ts";
import {
  ASSIGNMENT_ACTION_IDS,
  ASSIGNMENT_DELEGATE_VIEW,
  assignmentBlockActionHandler,
  assignmentViewSubmissionHandler,
} from "./actions.ts";

/** MessagePosted trigger fields; IDs and timestamps are passed through unchanged. */
export interface MessageEvent {
  channel_id: string;
  channel_type: string;
  user_id: string;
  message_ts: string;
  text?: string;
  thread_ts?: string | null;
  bot_id?: string;
  subtype?: string;
}

interface ApiResult {
  ok: boolean;
  error?: string;
}

/** A small API boundary keeps message rules testable without contacting Slack. */
export interface MessageClient extends WorkspaceClient {
  conversations: WorkspaceClient["conversations"] & {
    open(args: { users: string }): Promise<ApiResult & { channel?: { id?: string } }>;
  };
  auth: { test(): Promise<ApiResult & { user_id?: string }> };
  users: {
    info(args: { user: string }): Promise<
      ApiResult & {
        user?: {
          is_bot?: boolean;
          is_app_user?: boolean;
          team_id?: string;
          enterprise_user?: { teams?: string[] };
        };
      }
    >;
  };
  chat: {
    postEphemeral(args: {
      channel: string;
      user: string;
      text: string;
      thread_ts: string;
    }): Promise<ApiResult & { message_ts?: string }>;
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts?: string;
      unfurl_links: boolean;
      unfurl_media: boolean;
    }): Promise<ApiResult & { ts?: string }>;
  };
}

export type MessageResult =
  | { outputs: { ignored: boolean; reply_ts?: string }; interactive?: boolean }
  | { error: string; interactive?: boolean };

/** Handle explicit task commands from human mentions and one-to-one DMs. */
export async function handleMessage(
  event: MessageEvent,
  client: MessageClient,
  repository?: TaskRepository,
  teamDirectory?: TeamDirectory,
  notifications?: {
    client: NotificationClient;
    store: NotificationStore;
    context?: NotificationContext;
  },
  resetDatabase?: () => Promise<{ tasks: number; notifications: number }>,
  dmContexts?: DmContexts,
  displays?: TaskDisplays,
  clearConversation?: (
    channel: string,
    userId: string,
    botUserId: string,
    boundary: string,
    threadTs?: string,
  ) => Promise<
    {
      deleted: number;
      failed: number;
      remaining?: boolean;
      userMessagesRemaining?: boolean;
    }
  >,
): Promise<MessageResult> {
  const ignored = { outputs: { ignored: true } };
  if (event.bot_id || event.subtype || !event.user_id || !event.message_ts) {
    return ignored;
  }
  const isDm = event.channel_type === "dm" || event.channel_type === "im";
  const isChannel = event.channel_type === "public" || event.channel_type === "private";
  if (!isDm && !isChannel) return ignored;

  const identity = await client.auth.test();
  if (!identity.ok || !identity.user_id) {
    return {
      error: `Cannot identify DeleBot: ${identity.error ?? "missing_bot_identity"}`,
    };
  }
  if (event.user_id === identity.user_id) return ignored;
  if (!isDm && !(event.text ?? "").includes(`<@${identity.user_id}>`)) return ignored;

  // Workflow events do not always carry bot_id/subtype. Check the sender too,
  // especially in DMs, so the bot cannot respond to itself or other bots forever.
  const sender = await client.users.info({ user: event.user_id });
  if (!sender.ok || !sender.user) {
    return { error: `Cannot check message sender: ${sender.error ?? "missing_user"}` };
  }
  if (sender.user.is_bot || sender.user.is_app_user) return ignored;

  const rawText = (event.text ?? "").trim();
  const botMention = `<@${identity.user_id}>`;
  let text = rawText.startsWith(botMention)
    ? rawText.slice(botMention.length).trim()
    : rawText;
  let teamMenu: string | undefined;
  if (teamDirectory && (/^teams\s*$/i.test(text) || /(^|\s)@[a-z0-9_-]+/i.test(text))) {
    try {
      const workspace = await resolveWorkspace(client, event.channel_id, sender.user);
      const snapshot = await teamDirectory.load(
        event.user_id,
        workspace,
        await repository?.referencedTeamIds() ?? [],
        true,
      );
      text = expandTeamHandles(text, snapshot.teamNames);
      if (/^teams\s*$/i.test(text)) {
        teamMenu = Object.values(snapshot.teamNames).length
          ? `👥 *Teams*\n\n${
            [...new Set(Object.values(snapshot.teamNames))].map((name) =>
              `• @${name.replace(/^@/, "")}`
            ).join("\n")
          }\n\nType a handle directly, e.g. \`assign @alphateam\` or \`ls @alphateam\`.`
          : "No team handles were returned by Slack for this workspace.";
      }
    } catch {
      teamMenu = "I couldn't load team handles. Please try again shortly.";
    }
  }
  const command = parseTaskCommand(text);
  // Help, validation errors and task results from list commands all stay in DMs.
  const directReply = /^(?:ls(?:\s|$|<@|@)|tasks\s+ls(?:\s|$))/i.test(text);
  const context: TaskContext = {
    channelId: event.channel_id,
    messageTs: event.message_ts,
    userId: event.user_id,
    threadTs: event.thread_ts || event.message_ts,
  };
  let privateReply = false;
  let interactive = false;
  let shownTaskIds: string[] | undefined;
  let replyTaskIds: string[][] | undefined;
  let changedTask: Task | undefined;
  let identifiedTask: Task | undefined;
  let includeTaskIdentity = true;
  let requestConfirmationId: string | undefined;
  let listedTasks: Task[] = [];
  let threadList = false;
  let updateNotice: string | undefined;
  let replies = [text ? UNKNOWN_COMMAND : GREETING];
  let hasTaskCards = false;
  let replyWorkspaceId: string | undefined;
  if (teamMenu) {
    replies = [teamMenu];
  } else if (command.kind === "clear-chat") {
    if (!isDm) {
      replies = [
        "Use `clear` in your direct message with DeleBot to remove its messages from that chat.",
      ];
    } else if (!clearConversation) replies = ["Chat clearing is not configured."];
    else {
      try {
        const result = await clearConversation(
          event.channel_id,
          event.user_id,
          identity.user_id,
          event.message_ts,
          event.thread_ts && event.thread_ts !== event.message_ts
            ? event.thread_ts
            : undefined,
        );
        shownTaskIds = [];
        replies = [
          `Cleared ${result.deleted} messages from this ${
            event.thread_ts && event.thread_ts !== event.message_ts ? "DM thread" : "DM"
          }. ${
            result.userMessagesRemaining !== false
              ? "User messages require your Slack user authorization and remain until it is configured. "
              : ""
          }Saved tasks are unchanged.${
            result.remaining
              ? " More history remains; send clear again to continue from the saved position."
              : ""
          }${
            result.failed
              ? " Some messages or cleanup records could not be cleared; run clear again to retry."
              : ""
          }`,
        ];
      } catch {
        replies = [
          "I couldn't finish clearing this DM. Run `clear` again to retry. Slack only lets me delete DeleBot's own messages; your messages and saved tasks remain.",
        ];
      }
    }
  } else if (command.kind === "reset") {
    if (!resetDatabase) {
      replies = ["Database reset is not configured."];
    } else {
      try {
        const result = await resetDatabase();
        shownTaskIds = [];
        replies = [
          `Task database reset: deleted ${result.tasks} task records and ${result.notifications} assignment records. Existing Slack messages remain.`,
        ];
      } catch {
        replies = [
          "The database reset could not be completed. Some records may have been deleted; run delete all again to finish.",
        ];
      }
    }
  } else if (command.kind === "help") {
    replies = [
      command.topic === "create"
        ? TASK_CREATE_USAGE
        : command.topic === "list"
        ? TASK_LIST_USAGE
        : GREETING,
    ];
  } else if (command.kind === "error") {
    replies = [command.message];
  } else if (
    command.kind === "create" || command.kind === "list" || command.kind === "update" ||
    command.kind === "delete" || command.kind === "response" ||
    command.kind === "print" ||
    command.kind === "collaborate" || command.kind === "collaboration-response" ||
    command.kind === "approval-response"
  ) {
    if (!repository || !teamDirectory) {
      return { error: "Task storage and team membership must be configured." };
    }
    let membershipWarning: string | undefined;
    let workspaceId: string | undefined;
    try {
      let snapshot: TeamSnapshot = {
        access: { userId: event.user_id, teamIds: [] },
        knownTeamIds: [],
        teamNames: {},
      };
      const patch = command.kind === "create" || command.kind === "update"
        ? command.patch
        : undefined;
      const selectedTeams = [
        ...new Set([
          ...patch?.assignees ?? [],
          ...patch?.viewPerms ?? [],
          ...patch?.editPerms ?? [],
          ...patch?.set?.assignees ?? [],
          ...patch?.set?.viewPerms ?? [],
          ...patch?.set?.editPerms ?? [],
          ...(command.kind === "response" ? command.decision.assignees ?? [] : []),
        ].filter((id) => /^S/.test(id))),
      ];
      const skipTeams = command.kind === "create"
        ? !selectedTeams.length
        : command.kind === "list" && command.query.kind === "team" &&
          command.query.teamId === "all";
      if (!skipTeams) {
        try {
          workspaceId = await resolveWorkspace(client, event.channel_id, sender.user);
          const references = command.kind === "create" ? selectedTeams : [
            ...await repository.referencedTeamIds(),
            ...selectedTeams,
            ...(command.kind === "list" && command.query.kind === "team"
              ? [command.query.teamId]
              : []),
            ...(command.kind === "list" && command.query.kind === "filters"
              ? command.query.targets?.flatMap((target) =>
                target.kind === "team" ? [target.teamId] : []
              ) ?? []
              : []),
          ];
          snapshot = await teamDirectory.load(event.user_id, workspaceId, references);
        } catch (error) {
          membershipWarning = error instanceof TaskReferenceError
            ? "I couldn't read the teams attached to saved tasks."
            : `I couldn't verify your team membership. ${membershipHelp(error)}`;
          if (selectedTeams.length) {
            throw new TaskAccessError(`${membershipWarning} No changes were made.`);
          }
        }
      }
      const { access, knownTeamIds, teamNames, disabledTeamIds = [] } = snapshot;
      context.groupMembers = snapshot.teamMembers;
      replyWorkspaceId = workspaceId;
      if (access.userId !== event.user_id) {
        throw new TaskAccessError("Membership verification did not match the requester.");
      }
      if (selectedTeams.some((id) => disabledTeamIds.includes(id))) {
        throw new TaskAccessError(
          "That mention points to a disabled Slack group. Select the active group again. No changes were made.",
        );
      }
      if (selectedTeams.some((id) => !knownTeamIds.includes(id))) {
        throw new TaskAccessError(
          "Slack could not verify the selected group in this workspace. No changes were made.",
        );
      }
      if (command.kind === "list") {
        hasTaskCards = true;
        let tasks: Task[];
        if (
          event.thread_ts && event.thread_ts !== event.message_ts &&
          command.query.kind !== "number" && command.query.kind !== "name"
        ) {
          try {
            const target = await resolveDmTarget(
              undefined,
              context,
              repository,
              access,
              dmContexts,
              event.thread_ts,
            );
            tasks = target.completed === (command.query.completed ?? false)
              ? [target]
              : [];
            threadList = true;
          } catch (error) {
            if (
              !(error instanceof TaskCommandError) ||
              !error.message.startsWith("No task available in this thread")
            ) throw error;
            tasks = await listTasks(command.query, access, repository);
          }
        } else tasks = await listTasks(command.query, access, repository);
        listedTasks = tasks;
        shownTaskIds = tasks.map((task) => task.id);
        replies = command.query.kind === "number" || command.query.kind === "name"
          ? (tasks.length
            ? tasks.map((task) => formatTask(task, teamNames))
            : ["No matching task available to you."])
          : (tasks.length
            ? tasks.map((task) => formatTask(task, teamNames))
            : ["No tasks found."]);
        replyTaskIds = tasks.map((task) => [task.id]);
      } else if (command.kind === "print") {
        const task = await resolveDmTarget(
          command.number,
          context,
          repository,
          access,
          dmContexts,
          event.thread_ts && event.thread_ts !== event.message_ts
            ? event.thread_ts
            : isDm
            ? "latest"
            : event.message_ts,
        );
        shownTaskIds = [task.id];
        listedTasks = [task];
        hasTaskCards = true;
        replies = [formatTask(task, teamNames)];
      } else if (command.kind === "delete") {
        const target = await resolveDmTarget(
          command.number,
          context,
          repository,
          access,
          dmContexts,
          event.thread_ts && event.thread_ts !== event.message_ts
            ? event.thread_ts
            : isDm
            ? "latest"
            : event.message_ts,
        );
        identifiedTask = target;
        shownTaskIds = [target.id];
        if (!canManageTask(target, access)) {
          const request = await requestTaskAction(
            target,
            "delete",
            context,
            repository,
            access,
          );
          changedTask = request.task;
          requestConfirmationId = request.requestId;
          replies = [
            requestStatusText(
              request.task,
              request.task.participation!.requests[request.requestId],
            ),
          ];
        } else {
          await deleteTask(target, context, repository, access);
          changedTask = { ...target, deleted: true };
          privateReply = !isDm && !isPublicTask(target);
          replies = [`✅ ${taskTitle(target)} Deleted.`];
          shownTaskIds = [target.id];
          if (notifications) {
            try {
              const cleanup = await notifyTaskAssignments(
                { ...target, deleted: true },
                workspaceId,
                notifications.client,
                notifications.store,
                notifications.context,
              );
              if (cleanup.failed.length) {
                replies.push(
                  "The task was deleted, but some assignment messages could not be removed. Their task controls can no longer change the deleted task.",
                );
              }
            } catch {
              replies.push(
                "The task was deleted, but assignment-message cleanup could not be confirmed.",
              );
            }
          }
        }
        updateNotice = replies[0];
      } else {
        let task;
        let acknowledgement: string;
        if (command.kind === "create") {
          const result = await createTask(
            {
              name: command.name,
              ...command.patch,
              ...(command.patch.assignees?.length === 0
                ? { assignees: [event.user_id] }
                : {}),
            },
            context,
            repository,
            access,
          );
          task = result.task;
          acknowledgement = result.created ? "Created" : "Already saved";
        } else {
          const target = await resolveDmTarget(
            command.number,
            context,
            repository,
            access,
            dmContexts,
            event.thread_ts && event.thread_ts !== event.message_ts
              ? event.thread_ts
              : isDm
              ? "latest"
              : event.message_ts,
          );
          identifiedTask = target;
          shownTaskIds = [target.id];
          if (
            command.kind === "update" && !canManageTask(target, access) &&
            (command.patch.completed !== undefined ||
              command.patch.set?.completed !== undefined ||
              command.patch.clear?.includes("completed")) &&
            (!Object.keys(command.patch).every((key) =>
              ["completed", "set", "clear"].includes(key)
            ) ||
              !Object.keys(command.patch.set ?? {}).every((key) => key === "completed") ||
              !(command.patch.clear ?? []).every((key) => key === "completed"))
          ) {
            throw new TaskCommandError(
              "Send complete or incomplete separately from other edits when requesting approval.",
            );
          }
          const approvalRequestId = command.kind === "approval-response"
            ? command.requestId ?? uniqueRequest(target, command.kindOfAction)
            : undefined;
          const result = command.kind === "collaborate"
            ? await inviteCollaborators(
              target,
              command.users,
              context,
              repository,
              access,
            )
            : command.kind === "collaboration-response"
            ? await respondToCollaboration(
              target,
              command.accept ? "accept" : "reject",
              context,
              repository,
              access,
            )
            : command.kind === "approval-response"
            ? await respondToTaskAction(
              target,
              approvalRequestId!,
              command.approve ? "approve" : "reject",
              context,
              repository,
              access,
            )
            : command.kind === "update" &&
                (command.patch.completed !== undefined ||
                  command.patch.set?.completed !== undefined ||
                  command.patch.clear?.includes("completed")) &&
                !canManageTask(target, access)
            ? await requestTaskAction(
              target,
              (command.patch.completed ?? command.patch.set?.completed ?? false)
                ? "complete"
                : "incomplete",
              context,
              repository,
              access,
            )
            : command.kind === "response"
            ? await respondToAssignment(
              target,
              command.decision,
              context,
              repository,
              access,
            )
            : await updateTask(
              target,
              command.patch,
              context,
              repository,
              access,
            );
          task = result.task;
          acknowledgement = result.updated
            ? describeTaskChanges(target, task)
            : "Already applied";
          if ("requestId" in result && typeof result.requestId === "string") {
            requestConfirmationId = result.requestId;
          }
          if (command.kind === "approval-response") {
            const request = task.participation!.requests[approvalRequestId!];
            acknowledgement = `${
              request.kind === "complete"
                ? "Completion"
                : request.kind === "incomplete"
                ? "Reopening"
                : "Deletion"
            } request ${request.status}`;
          } else if (command.kind === "collaboration-response") {
            acknowledgement = `Collaboration ${command.accept ? "accepted" : "rejected"}`;
          } else if (command.kind === "collaborate") {
            acknowledgement = "Collaboration requested";
          } else if (
            command.kind === "update" && acknowledgement === "No fields changed" &&
            (command.patch.assignees !== undefined ||
              command.patch.set?.assignees !== undefined)
          ) {
            acknowledgement =
              "Already assigned to these recipients. Existing responses kept";
          } else if (command.kind === "response") {
            const response = task.assignmentResponses?.[event.user_id];
            acknowledgement = response?.status === "rejected"
              ? "Assignment rejected"
              : command.decision.kind === "accept"
              ? "Assignment accepted"
              : command.decision.kind === "delegate"
              ? "Assignment delegated"
              : "Assignment rejected";
          }
        }
        const stillVisible = canAccessTask(task, access);
        const quiet = command.kind !== "create" && !!event.thread_ts &&
          event.thread_ts !== event.message_ts;
        const shortReply = quiet || !!requestConfirmationId ||
          command.kind === "approval-response" ||
          command.kind === "collaboration-response" || command.kind === "collaborate" ||
          command.kind === "update";
        includeTaskIdentity = stillVisible || !!task.deleted;
        hasTaskCards = stillVisible && !shortReply;
        changedTask = task;
        shownTaskIds = stillVisible ? [task.id] : [];
        privateReply = !isDm && (!stillVisible || !isPublicTask(task));
        replies = stillVisible
          ? [
            shortReply
              ? requestConfirmationId
                ? requestStatusText(
                  task,
                  task.participation!.requests[requestConfirmationId],
                )
                : `${
                  (command.kind === "approval-response" && !command.approve) ||
                    (command.kind === "collaboration-response" && !command.accept)
                    ? "❌"
                    : "✅"
                } ${taskTitle(task)} ${acknowledgement}.`
              : `${acknowledgement} task #${task.number}.\n\n${
                formatTask(task, teamNames)
              }`,
          ]
          : [
            task.deleted
              ? (command.kind === "response" && command.decision.kind === "reject"
                ? `${
                  taskTitle(task)
                } — Deleted after its creator rejected the returned assignment.`
                : `${taskTitle(task)} — Deleted.`)
              : "Changes saved. Your viewing permissions no longer include this task.",
          ];
        if (command.kind !== "create") updateNotice = replies[0];
        const key = mutationKey(context);
        const assigned = task.assignmentEvents?.[key] ?? [];
        if (notifications) {
          try {
            if (!workspaceId && assigned.some((id) => id !== "all")) {
              try {
                workspaceId = await resolveWorkspace(
                  client,
                  event.channel_id,
                  sender.user,
                );
              } catch {
                // Direct recipients can respond without group membership; group actions
                // resolve the source workspace again if it is unavailable here.
              }
            }
            const delivery = await notifyTaskAssignments(
              task,
              workspaceId,
              notifications.client,
              notifications.store,
              notifications.context,
            );
            interactive ||= delivery.interactive;
            if (delivery.failed.length) {
              replies.push(
                "The task was saved, but some assignment notifications could not be delivered. DeleBot will retry pending notifications when you next update this task.",
              );
            }
          } catch {
            replies.push(
              "The task was saved, but assignment notifications could not be confirmed.",
            );
          }
        } else if (assigned.some((id) => id !== "all")) {
          replies.push(
            "The task was saved, but assignment notifications are not configured.",
          );
        }
      }
      if (membershipWarning) {
        replies.push(
          `${membershipWarning} Team-only tasks may be hidden until group membership can be verified.`,
        );
      }
    } catch (error) {
      if (
        !(error instanceof TaskAccessError) && !(error instanceof TaskCommandError) &&
        !(error instanceof TaskLockTimeoutError)
      ) {
        console.error(
          JSON.stringify({
            event: "task_command_failed",
            command: command.kind,
            errorType: error instanceof Error ? error.name : "unknown",
            frames: error instanceof Error
              ? error.stack?.split("\n").slice(1, 5)
              : undefined,
          }),
        );
      }
      replies = [
        error instanceof TaskAccessError || error instanceof TaskCommandError ||
          error instanceof TaskLockTimeoutError
          ? error.message
          : command.kind === "list"
          ? "I couldn't load tasks. Please try again shortly."
          : "I couldn't confirm that the changes were saved. Check the task before trying again.",
      ];
    }
  }

  if (changedTask?.participation && notifications?.client.chat.update && repository) {
    try {
      const delivery = await notifyParticipation(
        changedTask,
        replyWorkspaceId,
        notifications.client as ParticipationClient,
        notifications.context ?? {},
        repository,
      );
      interactive ||= delivery.interactive;
      changedTask = await repository.findById(changedTask.id) ?? changedTask;
      if (delivery.failed.length) {
        replies.push(
          "Your change was saved, but some collaboration or approval messages could not be delivered. Update the task to retry.",
        );
      }
    } catch {
      replies.push("Your change was saved, but request delivery could not be confirmed.");
    }
  }

  if (displays && (changedTask || listedTasks.length)) {
    try {
      let failed = 0;
      for (const task of changedTask ? [changedTask] : listedTasks) {
        failed += await displays.refresh(
          task,
          updateNotice
            ? {
              eventKey: mutationKey(context),
              text: updateNotice,
              sourceChannel: event.channel_id,
              sourceThread: context.threadTs!,
            }
            : undefined,
        );
      }
      if (failed) {
        replies.push(
          "Task saved. Some earlier task messages could not be refreshed; list the task again for its latest state.",
        );
      }
    } catch {
      replies.push(
        "Task saved. Earlier task messages could not be refreshed; list the task again for its latest state.",
      );
    }
  }
  // Even a validation/error response inside a known task conversation retains
  // its task identity and can itself be used as the next thread root.
  if (!identifiedTask && !changedTask && event.thread_ts && dmContexts && repository) {
    try {
      const personal = await dmContexts.get(
        event.channel_id,
        event.thread_ts,
        event.user_id,
      );
      const ids = personal.length
        ? personal
        : await dmContexts.get(event.channel_id, event.thread_ts, "*");
      const candidates = ids.length === 1
        ? [await repository.findById(ids[0])]
        : ids.length
        ? []
        : await repository.findInThread(event.channel_id, event.thread_ts);
      if (candidates.length === 1 && candidates[0]) {
        const candidate = candidates[0];
        const access = notifications?.context?.loadAccess
          ? await notifications.context.loadAccess(
            candidate,
            event.user_id,
            replyWorkspaceId,
          )
          : { userId: event.user_id, teamIds: [] };
        if (canAccessTask(candidate, access)) {
          identifiedTask = candidate;
          shownTaskIds = [candidate.id];
          privateReply = !isDm && !isPublicTask(candidate);
        }
      }
    } catch { /* Never expose a private task based only on a stale thread binding. */ }
  }
  const namedTask = changedTask ?? identifiedTask;
  if (namedTask && includeTaskIdentity) {
    replies = replies.map((reply) =>
      reply.includes(taskTitle(namedTask)) ? reply : `${taskTitle(namedTask)}\n\n${reply}`
    );
  }
  let replyChannel = event.channel_id;
  const sourceThread = event.thread_ts || event.message_ts;
  let replyThread: string | undefined = sourceThread;
  if (command.kind === "clear-chat") replyThread = undefined;
  // Lists are task pickers in the main DM; individual lookups and mutations
  // create or continue the thread of the user's message.
  if (
    command.kind === "list" && command.query.kind !== "name" &&
    command.query.kind !== "number" && !threadList
  ) replyThread = undefined;
  if (directReply && !isDm) {
    try {
      const opened = await client.conversations.open({ users: event.user_id });
      if (!opened.ok || !opened.channel?.id || !/^D[A-Z0-9]+$/.test(opened.channel.id)) {
        return { error: "Cannot open a direct message for task results." };
      }
      replyChannel = opened.channel.id;
      // A channel timestamp cannot be used as a thread inside a different DM.
      replyThread = undefined;
    } catch {
      return { error: "Cannot open a direct message for task results." };
    }
  }
  if (privateReply) {
    // Slack only displays threaded ephemeral messages in an active thread.
    // Establish that thread with an acknowledgement containing no task details.
    const acknowledgement = await client.chat.postMessage({
      channel: replyChannel,
      thread_ts: sourceThread,
      text: "Task results are shown only to you in this thread.",
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!acknowledgement.ok) {
      return {
        error: `Cannot start reply thread: ${acknowledgement.error ?? "unknown_error"}`,
        ...(interactive ? { interactive: true } : {}),
      };
    }
    if (acknowledgement.ts && shownTaskIds?.length && dmContexts) {
      await dmContexts.save(
        replyChannel,
        acknowledgement.ts,
        "*",
        shownTaskIds,
        "context",
      );
    }
  }
  let replyTs: string | undefined;
  const parts = new Map<string, number>();
  for (
    const [reply, ids] of replies.flatMap((text, index) =>
      (privateReply ? splitPrivateReply(text) : splitTaskReply(text)).map((part) =>
        [part, replyTaskIds?.[index] ?? shownTaskIds] as const
      )
    )
  ) {
    if (privateReply) {
      const response = await client.chat.postEphemeral({
        channel: replyChannel,
        user: event.user_id,
        text: reply,
        thread_ts: sourceThread,
      });
      if (!response.ok) {
        // Never broadcast restricted data if private delivery fails.
        return {
          error: `Cannot send private reply: ${response.error ?? "unknown_error"}`,
          ...(interactive ? { interactive: true } : {}),
        };
      }
      replyTs = response.message_ts;
      continue;
    }
    const response = await client.chat.postMessage({
      channel: replyChannel,
      text: reply,
      ...(replyThread ? { thread_ts: replyThread } : {}),
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!response.ok) {
      return {
        error: `Cannot send reply: ${response.error ?? "unknown_error"}`,
        ...(interactive ? { interactive: true } : {}),
      };
    }
    replyTs = response.ts;
    if (
      hasTaskCards && displays && ids?.length === 1 && replyTs && (isDm || directReply)
    ) {
      try {
        const part = parts.get(ids[0]) ?? 0;
        await displays.track(
          ids[0],
          replyChannel,
          replyTs,
          event.user_id,
          part,
          replyThread,
        );
        parts.set(ids[0], part + 1);
      } catch {
        return {
          error:
            "Task reply sent, but automatic message refresh could not be enabled. List the task again to retry.",
          ...(interactive ? { interactive: true } : {}),
        };
      }
    }
    if (dmContexts && shownTaskIds !== undefined) {
      try {
        for (
          const key of new Set([
            ...(isDm || directReply ? ["latest"] : []),
            sourceThread,
            ...(replyTs ? [replyTs] : []),
          ])
        ) {
          await dmContexts.save(
            replyChannel,
            key,
            event.user_id,
            key === replyTs ? ids ?? [] : shownTaskIds,
            key === replyTs && hasTaskCards ? "card" : "context",
          );
        }
        if (replyTs && ids?.length) {
          await dmContexts.save(replyChannel, replyTs, "*", ids, "context");
        }
      } catch {
        return {
          error:
            "Reply sent, but I couldn't remember its task context. Use the task number for your next update.",
          ...(interactive ? { interactive: true } : {}),
        };
      }
    }
    if (
      command.kind === "collaborate" && changedTask && replyTs && !privateReply &&
      repository &&
      changedTask.participation?.deliveryEvents[mutationKey(context)]?.kind ===
        "collaboration"
    ) {
      const current = await rememberCollaborationConfirmation(
        changedTask,
        mutationKey(context),
        { channelId: replyChannel, messageTs: replyTs, userId: event.user_id },
        repository,
      );
      if (notifications?.client.chat.update) {
        await notifications.client.chat.update({
          channel: replyChannel,
          ts: replyTs,
          text: collaborationStatusText(
            current,
            current.participation!.deliveryEvents[mutationKey(context)],
          ),
          blocks: [],
        });
      }
    }
    if (requestConfirmationId && changedTask && replyTs && !privateReply && repository) {
      const current = await rememberRequestConfirmation(
        changedTask,
        requestConfirmationId,
        { channelId: replyChannel, messageTs: replyTs, userId: event.user_id },
        repository,
      );
      const request = current.participation!.requests[requestConfirmationId];
      if (request.status !== "pending" && notifications?.client.chat.update) {
        await notifications.client.chat.update({
          channel: replyChannel,
          ts: replyTs,
          text: requestStatusText(current, request),
          blocks: [],
        });
      }
    }
  }
  return {
    outputs: { ignored: false, reply_ts: replyTs },
    ...(interactive ? { interactive: true } : {}),
  };
}

export const MessageProperties = {
  delegation_submission: { type: Schema.types.string },
  channel_id: { type: Schema.slack.types.channel_id },
  channel_type: { type: Schema.types.string },
  user_id: { type: Schema.slack.types.user_id },
  message_ts: { type: Schema.types.string },
  text: { type: Schema.types.string },
  // Triggers always supply the root timestamp: message_ts for new messages,
  // thread_ts for replies. Optional in code for defensive fallback only.
  thread_ts: { type: Schema.types.string },
};

export const MessageFunction = DefineFunction({
  callback_id: "delebot_handle_message",
  title: "Handle a DeleBot task command",
  description: "Create and find tasks from mentions or direct messages",
  source_file: "delebot/slack/events.ts",
  input_parameters: {
    properties: MessageProperties,
    required: ["channel_id", "channel_type", "user_id", "message_ts"],
  },
  output_parameters: {
    properties: {
      ignored: { type: Schema.types.boolean },
      reply_ts: { type: Schema.types.string },
    },
    required: ["ignored"],
  },
});

export default SlackFunction(MessageFunction, async ({ inputs, client, event, env }) => {
  try {
    if (inputs.delegation_submission) {
      const payload = JSON.parse(inputs.delegation_submission);
      const dependencies = productionDependencies(client);
      dependencies.deliveryExecutionId = event.function_execution_id;
      let result;
      if (payload?.kind === "assignment_action") {
        const action = payload.action;
        if (
          !action || action.userId !== inputs.user_id ||
          typeof action.value !== "string" || typeof action.actionId !== "string"
        ) return { error: "Invalid assignment response." };
        result = await runQueuedAssignmentAction(action, dependencies);
      } else {
        const submission = payload as AssignmentSubmission;
        if (
          !submission || submission.userId !== inputs.user_id ||
          typeof submission.privateMetadata !== "string" ||
          typeof submission.executionId !== "string" ||
          typeof submission.viewId !== "string"
        ) return { error: "Invalid delegation submission." };
        result = await runQueuedDelegation(submission, dependencies);
      }
      if (result.interactive) return { completed: false };
      return { outputs: { ignored: !result.ok } };
    }
    const repository = new SlackTaskRepository(client);
    const directory = new SlackTeamDirectory(client);
    let delegationReady: Promise<string> | undefined;
    const result = await handleMessage(
      inputs,
      client,
      repository,
      directory,
      {
        client,
        store: new SlackNotificationStore(client),
        context: {
          prepareInteractivity: async () => {
            await (delegationReady ??= delegationEndpoint(client));
          },
          loadTask: (id) => repository.findById(id),
          rememberTask: async (channel, ts, user, id) => {
            const store = new SlackDmContexts(client);
            await store.save(channel, ts, user, [id], "invitation");
            await store.save(channel, ts, "*", [id], "context");
            await store.save(channel, "latest", user, [id]);
          },
          executionId: event.function_execution_id,
          loadAccess: taskAccessLoader(client),
        },
      },
      () => resetTaskDatabase(client),
      new SlackDmContexts(client),
      taskDisplays(client),
      (channel, userId, botUserId, boundary, threadTs) => {
        const configured: unknown = env.SLACK_CLEAR_USER_TOKENS
          ? JSON.parse(env.SLACK_CLEAR_USER_TOKENS)
          : {};
        const token =
          configured && typeof configured === "object" && !Array.isArray(configured)
            ? (configured as Record<string, unknown>)[userId]
            : undefined;
        if (
          token !== undefined && (typeof token !== "string" || !token.startsWith("xoxp-"))
        ) throw new Error("Invalid requester authorization configuration.");
        return clearDmHistory(
          client,
          channel,
          userId,
          botUserId,
          boundary,
          threadTs,
          typeof token === "string" ? SlackAPI(token) : undefined,
        );
      },
    );
    // Interactive assignment messages remain active until their recipients respond.
    if (result.interactive) return { completed: false };
    return "outputs" in result ? { outputs: result.outputs } : { error: result.error };
  } catch {
    // Do not log message contents or credentials in a workflow error.
    return {
      error: "Slack could not be reached. Check the app's workflow activity log.",
    };
  }
}).addBlockActionsHandler(ASSIGNMENT_ACTION_IDS, assignmentBlockActionHandler)
  .addBlockActionsHandler(PARTICIPATION_ACTION_IDS, async ({ body, action, client }) => {
    const repository = new SlackTaskRepository(client);
    const raw = action as unknown as {
      action_id?: string;
      value?: string;
      action_ts?: string;
    };
    const container = body.container as { channel_id?: string; message_ts?: string };
    const result = await handleParticipationAction({
      actionId: raw.action_id ?? "",
      value: raw.value ?? "",
      userId: body.user.id,
      channelId: container.channel_id ?? "",
      messageTs: container.message_ts ?? "",
      executionId: body.function_data.execution_id,
      actionTs: raw.action_ts,
    }, {
      client,
      repository,
      displays: taskDisplays(client),
      notificationStore: new SlackNotificationStore(client),
      loadAccess: taskAccessLoader(client),
      rememberTask: async (channel, ts, userId, taskId) => {
        await new SlackDmContexts(client).save(
          channel,
          ts,
          userId,
          [taskId],
          "invitation",
        );
      },
    });
    if (!result.ok && result.error && container.channel_id) {
      await client.chat.postEphemeral({
        channel: container.channel_id,
        user: body.user.id,
        text: result.error,
      });
    }
  })
  .addViewSubmissionHandler(ASSIGNMENT_DELEGATE_VIEW, assignmentViewSubmissionHandler);

function uniqueRequest(task: Task, kind: "complete" | "incomplete" | "delete"): string {
  const ids = Object.entries(task.participation?.requests ?? {}).filter(([, request]) =>
    request.kind === kind && request.status === "pending"
  ).map(([id]) => id);
  if (ids.length !== 1) {
    throw new TaskCommandError("Choose a specific pending request using its request ID.");
  }
  return ids[0];
}
