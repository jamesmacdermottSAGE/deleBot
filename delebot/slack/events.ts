import { DefineFunction, Schema, SlackFunction } from "deno-slack-sdk/mod.ts";
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
  TaskAccessError,
  TaskCommandError,
  updateTask,
} from "../tasks/service.ts";
import {
  type NotificationClient,
  type NotificationStore,
  notifyTaskAssignments,
  SlackNotificationStore,
} from "./notifications.ts";
import {
  formatTask,
  formatTaskList,
  GREETING,
  splitPrivateReply,
  splitTaskReply,
} from "./messages.ts";
import {
  membershipHelp,
  SlackTeamDirectory,
  type TeamDirectory,
  type TeamSnapshot,
} from "./teams.ts";
import { resolveWorkspace, type WorkspaceClient } from "./workspace.ts";
import { isPublicTask } from "../tasks/access.ts";

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
  | { outputs: { ignored: boolean; reply_ts?: string } }
  | { error: string };

/** Handle explicit task commands from human mentions and one-to-one DMs. */
export async function handleMessage(
  event: MessageEvent,
  client: MessageClient,
  repository?: TaskRepository,
  teamDirectory?: TeamDirectory,
  notifications?: { client: NotificationClient; store: NotificationStore },
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
  const text = rawText.startsWith(botMention)
    ? rawText.slice(botMention.length).trim()
    : rawText;
  const command = parseTaskCommand(text);
  // Help, validation errors and task results from list commands all stay in DMs.
  const directReply = /^(?:ls(?:\s|$)|tasks\s+ls(?:\s|$))/i.test(text);
  const context = {
    channelId: event.channel_id,
    messageTs: event.message_ts,
    userId: event.user_id,
    threadTs: event.thread_ts || event.message_ts,
  };
  let privateReply = false;
  let replies = [GREETING];
  if (command.kind === "help") {
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
    command.kind === "delete"
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
      const assignmentPatch = command.kind === "create" || command.kind === "update"
        ? command.patch.assignees
        : undefined;
      const selectedTeams = assignmentPatch?.filter((id) => /^S/.test(id)) ?? [];
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
        const tasks = await listTasks(command.query, access, repository);
        replies = command.query.kind === "number" || command.query.kind === "name"
          ? (tasks.length
            ? tasks.map((task) => formatTask(task, teamNames))
            : ["No matching task available to you."])
          : formatTaskList(tasks, teamNames);
      } else if (command.kind === "delete") {
        const target = await resolveTaskForUpdate(
          command.number,
          context,
          repository,
          access,
        );
        await deleteTask(target, context, repository, access);
        privateReply = !isDm && !isPublicTask(target);
        replies = [`Deleted task #${target.number}.`];
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
          const target = await resolveTaskForUpdate(
            command.number,
            context,
            repository,
            access,
          );
          const result = await updateTask(
            target,
            command.patch,
            context,
            repository,
            access,
          );
          task = result.task;
          acknowledgement = result.updated ? "Updated" : "Already applied to";
        }
        privateReply = !isDm && !isPublicTask(task);
        replies = [
          `${acknowledgement} task #${task.number}.\n\n${formatTask(task, teamNames)}`,
        ];
        const key = mutationKey(context);
        const assigned = task.assignmentEvents?.[key] ?? [];
        if (notifications) {
          try {
            const delivery = await notifyTaskAssignments(
              task,
              workspaceId,
              notifications.client,
              notifications.store,
            );
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
          `${membershipWarning} Team-only tasks may be hidden; creator and direct-assignee access still work.`,
        );
      }
    } catch (error) {
      replies = [
        error instanceof TaskAccessError || error instanceof TaskCommandError
          ? error.message
          : command.kind === "list"
          ? "I couldn't load tasks. Please try again shortly."
          : "I couldn't confirm that the changes were saved. Check the task before trying again.",
      ];
    }
  }

  let replyChannel = event.channel_id;
  const sourceThread = event.thread_ts || event.message_ts;
  let replyThread: string | undefined = sourceThread;
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
      };
    }
  }
  let replyTs: string | undefined;
  for (
    const reply of replies.flatMap(privateReply ? splitPrivateReply : splitTaskReply)
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
      return { error: `Cannot send reply: ${response.error ?? "unknown_error"}` };
    }
    replyTs = response.ts;
  }
  return { outputs: { ignored: false, reply_ts: replyTs } };
}

export const MessageProperties = {
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

export default SlackFunction(MessageFunction, async ({ inputs, client }) => {
  try {
    return await handleMessage(
      inputs,
      client,
      new SlackTaskRepository(client),
      new SlackTeamDirectory(client),
      { client, store: new SlackNotificationStore(client) },
    );
  } catch {
    // Do not log message contents or credentials in a workflow error.
    return {
      error: "Slack could not be reached. Check the app's workflow activity log.",
    };
  }
});
