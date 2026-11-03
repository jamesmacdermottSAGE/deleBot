import { DefineFunction, Schema, SlackFunction } from "deno-slack-sdk/mod.ts";
import { GREETING } from "./messages.ts";

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
export interface MessageClient {
  auth: { test(): Promise<ApiResult & { user_id?: string }> };
  users: {
    info(args: { user: string }): Promise<
      ApiResult & { user?: { is_bot?: boolean; is_app_user?: boolean } }
    >;
  };
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      thread_ts: string;
      unfurl_links: boolean;
      unfurl_media: boolean;
    }): Promise<ApiResult & { ts?: string }>;
  };
}

export type MessageResult =
  | { outputs: { ignored: boolean; reply_ts?: string } }
  | { error: string };

/** Preserve the Python starter's greeting for human mentions and one-to-one DMs. */
export async function handleMessage(
  event: MessageEvent,
  client: MessageClient,
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

  const response = await client.chat.postMessage({
    channel: event.channel_id,
    text: GREETING,
    thread_ts: event.thread_ts || event.message_ts,
    unfurl_links: false,
    unfurl_media: false,
  });
  if (!response.ok) {
    return { error: `Cannot send reply: ${response.error ?? "unknown_error"}` };
  }
  return { outputs: { ignored: false, reply_ts: response.ts } };
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
  title: "Reply to a DeleBot message",
  description: "Greet people who mention DeleBot or send it a direct message",
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
    return await handleMessage(inputs, client);
  } catch {
    // Do not log message contents or credentials in a workflow error.
    return {
      error: "Slack could not be reached. Check the app's workflow activity log.",
    };
  }
});
