import { type ClearClient, clearDmHistory } from "../delebot/slack/clear.ts";
import {
  type NotificationBatch,
  SlackNotificationStore,
} from "../delebot/slack/notifications.ts";
import { parseTaskCommand } from "../delebot/tasks/commands.ts";
import { handleMessage, type MessageClient } from "../delebot/slack/events.ts";
import { assert } from "./task_fixtures.ts";

async function fixture(otherPending = true) {
  const records = new Map<string, Map<string, Record<string, unknown>>>();
  for (
    const name of [
      "tasks",
      "task_displays",
      "task_conversations",
      "assignment_notifications",
    ]
  ) records.set(name, new Map());
  records.get("tasks")!.set("saved", { id: "saved", name: "Keep task" });
  for (const [channel, user] of [["DALICE", "UALICE"], ["DBOB", "UBOB"]]) {
    records.get("task_displays")!.set(`${channel}:5.1`, {
      id: `${channel}:5.1`,
      channel_id: channel,
      user_id: user,
      message_ts: "5.1",
    });
    records.get("task_conversations")!.set(`${channel}:latest:${user}`, {
      id: `${channel}:latest:${user}`,
      user_id: user,
      task_ids: ["saved"],
    });
  }
  const deleted: string[] = [];
  const removed = new Set<string>();
  const completed: string[] = [];
  const fail = new Set<string>();
  const client: ClearClient = {
    conversations: {
      history: ({ channel, latest, cursor }) => {
        assert(channel === "DALICE" && latest === "10.1");
        return Promise.resolve(
          !cursor
            ? {
              ok: true,
              messages: [],
              response_metadata: { next_cursor: "history-next" },
            }
            : {
              ok: true,
              messages: [
                { user: "UALICE", ts: "1.1", reply_count: 1 },
                { user: "UBOT", ts: "2.1", reply_count: 2 },
                { user: "UOTHERBOT", ts: "3.1" },
                { user: "UBOT", ts: "11.1" },
              ],
            },
        );
      },
      replies: ({ channel, ts, cursor }) => {
        assert(channel === "DALICE");
        return Promise.resolve(
          !cursor
            ? { ok: true, messages: [], response_metadata: { next_cursor: "reply-next" } }
            : {
              ok: true,
              messages: ts === "1.1" ? [{ user: "UBOT", ts: "1.2" }] : [
                { user: "UBOT", ts: "2.1" },
                { user: "UBOT", ts: "2.2" },
                { user: "UALICE", ts: "2.3" },
              ],
            },
        );
      },
    },
    chat: {
      delete: ({ channel, ts }) => {
        assert(channel === "DALICE");
        deleted.push(ts);
        if (fail.has(ts)) return Promise.resolve({ ok: false, error: "ratelimited" });
        if (removed.has(ts)) {
          return Promise.resolve({
            ok: false,
            error: "message_not_found",
          });
        }
        removed.add(ts);
        return Promise.resolve({ ok: true });
      },
    },
    apps: {
      datastore: {
        query: ({ datastore, cursor }) => {
          assert(datastore !== "tasks", "Clearing messages must not query tasks");
          return Promise.resolve(
            !cursor
              ? { ok: true, items: [], next_cursor: "records-next" }
              : { ok: true, items: [...records.get(datastore)!.values()] },
          );
        },
        get: ({ datastore, id }) =>
          Promise.resolve({ ok: true, item: records.get(datastore)!.get(id) ?? {} }),
        put: ({ datastore, item }) => {
          records.get(datastore)!.set(item.id as string, structuredClone(item));
          return Promise.resolve({ ok: true });
        },
        delete: ({ datastore, id }) => {
          assert(datastore !== "tasks");
          records.get(datastore)!.delete(id);
          return Promise.resolve({ ok: true });
        },
      },
    },
    functions: {
      completeSuccess: ({ function_execution_id }) => {
        completed.push(function_execution_id);
        return Promise.resolve({ ok: true });
      },
    },
  };
  const store = new SlackNotificationStore(client);
  const batch: NotificationBatch = {
    id: "task:event",
    taskId: "task",
    eventKey: "event",
    assigned: ["UALICE", "UBOB"],
    recipients: ["UALICE", "UBOB"],
    delivered: ["UALICE", "UBOB"],
    cancelled: [],
    resolvedGroups: [],
    invitations: {
      UALICE: {
        id: crypto.randomUUID(),
        recipientId: "UALICE",
        status: "pending",
        executionId: "FXTEST",
        channelId: "DALICE",
        messageTs: "4.1",
      },
      UBOB: {
        id: crypto.randomUUID(),
        recipientId: "UBOB",
        status: otherPending ? "pending" : "accepted",
        executionId: "FXTEST",
        channelId: "DBOB",
        messageTs: "4.2",
      },
    },
  };
  await store.save(batch);
  return { client, records, store, batch, deleted, removed, completed, fail };
}

Deno.test("clear removes only this bot's DM messages and threaded replies and cancels their stale controls", async () => {
  const f = await fixture();
  const result = await clearDmHistory(f.client, "DALICE", "UALICE", "UBOT", "10.1");
  assert(result.deleted === 5 && result.failed === 0);
  assert(f.deleted.join() === "5.1,4.1,2.2,2.1,1.2");
  assert(f.records.get("tasks")!.get("saved")!.name === "Keep task");
  assert(!f.records.get("task_displays")!.has("DALICE:5.1"));
  assert(f.records.get("task_displays")!.has("DBOB:5.1"));
  assert(!f.records.get("task_conversations")!.has("DALICE:latest:UALICE"));
  assert(f.records.get("task_conversations")!.has("DBOB:latest:UBOB"));
  const batch = await f.store.get(f.batch.id);
  assert(
    batch?.invitations?.UALICE.status === "cancelled" &&
      batch.invitations.UALICE.messageRemoved,
  );
  assert(
    batch.invitations.UBOB.status === "pending" && !batch.invitations.UBOB.messageRemoved,
  );
  assert(f.completed.length === 0, "Other recipients must keep their controls active");
});

Deno.test("clear retries failed deletions and completes an execution only when its last invitation is closed", async () => {
  const f = await fixture(false);
  f.fail.add("4.1");
  const first = await clearDmHistory(f.client, "DALICE", "UALICE", "UBOT", "10.1");
  assert(first.failed === 1 && first.deleted === 4);
  assert((await f.store.get(f.batch.id))?.invitations?.UALICE.status === "pending");
  assert(f.completed.length === 0);
  f.fail.clear();
  const second = await clearDmHistory(f.client, "DALICE", "UALICE", "UBOT", "10.1");
  assert(second.failed === 0 && second.deleted === 1);
  assert(f.completed.join() === "FXTEST");
  assert((await f.store.get(f.batch.id))?.completedExecutions?.join() === "FXTEST");
});

Deno.test("clear refuses unreadable or incomplete histories before deleting anything", async () => {
  for (const mode of ["failed-history", "cursor", "records"]) {
    const f = await fixture();
    if (mode === "failed-history") {
      f.client.conversations.replies = () => Promise.resolve({ ok: false });
    }
    if (mode === "cursor") {
      f.client.conversations.history = () =>
        Promise.resolve({ ok: true, messages: [], has_more: true });
    }
    if (mode === "records") {
      f.client.apps.datastore.query = () => Promise.resolve({ ok: false });
    }
    let failed = false;
    try {
      await clearDmHistory(f.client, "DALICE", "UALICE", "UBOT", "10.1");
    } catch {
      failed = true;
    }
    assert(failed && f.deleted.length === 0);
  }
});

Deno.test("clear is an exact DM-only command and never runs for bots or ordinary channel messages", async () => {
  assert(parseTaskCommand("CLEAR").kind === "clear-chat");
  for (const text of ["clear all", "123 clear", "task clear"]) {
    assert(parseTaskCommand(text).kind !== "clear-chat");
  }
  const posts: string[] = [];
  const client: MessageClient = {
    auth: { test: () => Promise.resolve({ ok: true, user_id: "UBOT" }) },
    users: { info: () => Promise.resolve({ ok: true, user: {} }) },
    conversations: {
      info: () => Promise.resolve({ ok: true }),
      open: () => Promise.resolve({ ok: true }),
    },
    chat: {
      postMessage: ({ text }) => {
        posts.push(text);
        return Promise.resolve({ ok: true, ts: "11.1" });
      },
      postEphemeral: () => Promise.resolve({ ok: true }),
    },
  };
  let clears = 0;
  const clear = (channel: string, user: string, bot: string, boundary: string) => {
    assert(
      channel === "DALICE" && user === "UALICE" && bot === "UBOT" && boundary === "10.1",
    );
    clears++;
    return Promise.resolve({ deleted: 7, failed: 0 });
  };
  const event = {
    channel_id: "DALICE",
    channel_type: "dm",
    user_id: "UALICE",
    message_ts: "10.1",
    text: "clear",
  };
  await handleMessage(
    { ...event, bot_id: "BOTHER" },
    client,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    clear,
  );
  await handleMessage(
    { ...event, channel_type: "public", channel_id: "CPUBLIC", text: "<@UBOT> clear" },
    client,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    clear,
  );
  assert(clears === 0 && posts[0].includes("direct message"));
  await handleMessage(
    event,
    client,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    clear,
  );
  assert(Number(clears) === 1 && posts[1].includes("Cleared 7 DeleBot messages"));
  assert(
    posts[1].includes("your messages remain") &&
      posts[1].includes("Saved tasks are unchanged"),
  );
});
