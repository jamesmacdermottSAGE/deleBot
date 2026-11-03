import {
  handleMessage,
  type MessageClient,
  type MessageEvent,
} from "../delebot/slack/events.ts";
import { GREETING } from "../delebot/slack/messages.ts";

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function fixture() {
  const posts: Array<{ channel: string; text: string; thread_ts: string }> = [];
  const client: MessageClient = {
    auth: { test: () => Promise.resolve({ ok: true, user_id: "UBOT" }) },
    users: { info: () => Promise.resolve({ ok: true, user: { is_bot: false } }) },
    chat: {
      postMessage: (args) => {
        posts.push(args);
        return Promise.resolve({ ok: true, ts: "10.1" });
      },
    },
  };
  const event: MessageEvent = {
    channel_id: "CTEST",
    channel_type: "public",
    user_id: "UHUMAN",
    message_ts: "9.1",
    text: "<@UBOT> hello",
  };
  return { client, event, posts };
}

Deno.test("channel mention receives the original greeting in a thread", async () => {
  const { event, client, posts } = fixture();
  const result = await handleMessage(event, client);
  assert("outputs" in result && !result.outputs.ignored);
  assert(posts.length === 1);
  assert(posts[0].channel === event.channel_id);
  assert(posts[0].thread_ts === event.message_ts);
  assert(posts[0].text === GREETING);
});

Deno.test("reply stays in an existing thread", async () => {
  const { event, client, posts } = fixture();
  await handleMessage({ ...event, thread_ts: "1.1" }, client);
  assert(posts[0].thread_ts === "1.1");
});

Deno.test("null thread timestamp from Slack starts a reply thread on the message", async () => {
  const { event, client, posts } = fixture();
  await handleMessage(
    { ...event, thread_ts: null },
    client,
  );
  assert(posts[0].thread_ts === event.message_ts);
});

Deno.test("human DM does not require a bot mention", async () => {
  const { event, client, posts } = fixture();
  await handleMessage({ ...event, channel_type: "dm", text: "hello" }, client);
  assert(posts.length === 1);
});

Deno.test("private-channel mention receives a reply", async () => {
  const { event, client, posts } = fixture();
  await handleMessage({ ...event, channel_type: "private" }, client);
  assert(posts.length === 1);
});

Deno.test("ordinary channel messages and mentions of other people are ignored", async () => {
  const { event, client, posts } = fixture();
  for (const text of ["hello", "<@USOMEONE> hello", "<@UBOTOTHER> hello"]) {
    await handleMessage({ ...event, text }, client);
  }
  assert(posts.length === 0);
});

Deno.test("self messages, bot messages, edits, and group DMs are ignored", async () => {
  const { event, client, posts } = fixture();
  for (
    const override of [
      { user_id: "UBOT", channel_type: "dm" },
      { bot_id: "BBOT" },
      { subtype: "message_changed" },
      { channel_type: "mpdm" },
    ]
  ) {
    await handleMessage({ ...event, ...override }, client);
  }
  assert(posts.length === 0);
});

Deno.test("bot sender is ignored even when workflow event has no bot_id", async () => {
  const { event, client, posts } = fixture();
  client.users.info = () => Promise.resolve({ ok: true, user: { is_bot: true } });
  await handleMessage({ ...event, channel_type: "dm" }, client);
  assert(posts.length === 0);
});

Deno.test("sender lookup failure does not send a reply", async () => {
  const { event, client, posts } = fixture();
  client.users.info = () => Promise.resolve({ ok: false, error: "missing_scope" });
  const result = await handleMessage(event, client);
  assert("error" in result && result.error.includes("missing_scope"));
  assert(posts.length === 0);
});

Deno.test("identity lookup failure does not send a reply", async () => {
  const { event, client, posts } = fixture();
  client.auth.test = () => Promise.resolve({ ok: false, error: "invalid_auth" });
  const result = await handleMessage(event, client);
  assert("error" in result && result.error.includes("invalid_auth"));
  assert(posts.length === 0);
});

Deno.test("Slack send failures are reported rather than marked successful", async () => {
  const { event, client } = fixture();
  client.chat.postMessage = () => Promise.resolve({ ok: false, error: "not_in_channel" });
  const result = await handleMessage(event, client);
  assert("error" in result && result.error.includes("not_in_channel"));
});
