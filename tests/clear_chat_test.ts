import {
  type ClearClient,
  clearDmHistory,
  type UserDeletionClient,
} from "../delebot/slack/clear.ts";
import {
  type NotificationBatch,
  SlackNotificationStore,
} from "../delebot/slack/notifications.ts";
import { parseTaskCommand } from "../delebot/tasks/commands.ts";
import { handleMessage, type MessageClient } from "../delebot/slack/events.ts";
import { assert } from "./task_fixtures.ts";

async function fixture() {
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
    for (const ts of ["1.2", "2.1", "2.2", "4.1", "5.1"]) {
      records.get("task_displays")!.set(`${channel}:${ts}`, {
        id: `${channel}:${ts}`,
        channel_id: channel,
        user_id: user,
        message_ts: ts,
      });
      records.get("task_conversations")!.set(`${channel}:${ts}:${user}`, {
        id: `${channel}:${ts}:${user}`,
        user_id: user,
        task_ids: ["saved"],
      });
    }
    records.get("task_conversations")!.set(`${channel}:latest:${user}`, {
      id: `${channel}:latest:${user}`,
      user_id: user,
      task_ids: ["saved"],
    });
  }
  const deleted: string[] = [];
  const userDeleted: string[] = [];
  const removed = new Set<string>();
  const fail = new Set<string>();
  const calls = { history: 0, replies: 0, query: 0, get: [] as string[] };
  const deletion = (sink: string[], ts: string) => {
    sink.push(ts);
    if (fail.has(ts)) return Promise.resolve({ ok: false, error: "ratelimited" });
    if (removed.has(ts)) {
      return Promise.resolve({ ok: false, error: "message_not_found" });
    }
    removed.add(ts);
    return Promise.resolve({ ok: true });
  };
  const client: ClearClient = {
    conversations: {
      history: ({ channel, latest, cursor }) => {
        calls.history++;
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
                { user: "UBOT", ts: "4.1" },
                { user: "UBOT", ts: "5.1" },
                { user: "UALICE", ts: "10.1" },
                { user: "UBOT", ts: "11.1" },
              ],
            },
        );
      },
      replies: ({ channel, ts, cursor }) => {
        calls.replies++;
        assert(channel === "DALICE");
        return Promise.resolve(
          !cursor
            ? { ok: true, messages: [], response_metadata: { next_cursor: "reply-next" } }
            : {
              ok: true,
              messages: ts === "1.1"
                ? [{ user: "UALICE", ts: "1.1" }, { user: "UBOT", ts: "1.2" }]
                : [
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
        return deletion(deleted, ts);
      },
    },
    apps: {
      datastore: {
        query: ({ datastore, expression, expression_values }) => {
          calls.query++;
          assert(
            datastore === "assignment_notifications",
            "Only invitation records for cleared message IDs need a query",
          );
          assert(
            expression?.includes("contains(#state, :channel)") &&
              expression_values?.[":channel"] === '"channelId":"DALICE"',
          );
          return Promise.resolve({
            ok: true,
            items: [...records.get(datastore)!.values()],
          });
        },
        get: ({ datastore, id }) => {
          calls.get.push(`${datastore}:${id}`);
          return Promise.resolve({
            ok: true,
            item: structuredClone(records.get(datastore)!.get(id) ?? {}),
          });
        },
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
  };
  const userClient: UserDeletionClient = {
    auth: { test: () => Promise.resolve({ ok: true, user_id: "UALICE" }) },
    chat: {
      delete: ({ channel, ts }) => {
        assert(channel === "DALICE");
        return deletion(userDeleted, ts);
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
        status: "pending",
        executionId: "FXTEST",
        channelId: "DBOB",
        messageTs: "4.2",
      },
    },
  };
  await store.save(batch);
  return {
    client,
    userClient,
    records,
    store,
    batch,
    deleted,
    userDeleted,
    removed,
    fail,
    calls,
  };
}
async function finish(
  f: Awaited<ReturnType<typeof fixture>>,
  threadTs?: string,
  userClient?: UserDeletionClient,
) {
  let total = 0;
  let result;
  for (let attempt = 0; attempt < 30; attempt++) {
    result = await clearDmHistory(
      f.client,
      "DALICE",
      "UALICE",
      "UBOT",
      "10.1",
      threadTs,
      userClient,
    );
    total += result.deleted;
    assert(result.failed === 0);
    if (!result.remaining) return { ...result, deleted: total };
  }
  throw new Error("Clear did not make bounded progress");
}

Deno.test("clear makes bounded progress through DM pages and threads without workspace scans", async () => {
  const f = await fixture();
  const first = await clearDmHistory(f.client, "DALICE", "UALICE", "UBOT", "10.1");
  assert(first.deleted === 2 && first.remaining && first.userMessagesRemaining);
  assert(f.calls.history === 2 && f.calls.replies === 0);
  assert(
    f.calls.get.every((id) => id.includes(":clear-job:")),
    "No network GET per invitation",
  );
  const rest = await finish(f);
  assert(first.deleted + rest.deleted === 5 && !rest.remaining);
  assert(
    f.deleted.includes("1.2") && f.deleted.includes("2.2") && f.deleted.includes("2.1"),
  );
  assert(
    !f.deleted.includes("1.1") && !f.deleted.includes("10.1") &&
      !f.deleted.includes("11.1"),
  );
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
});

Deno.test("thread clear never reads whole-DM history or touches messages outside that thread", async () => {
  const f = await fixture();
  const result = await finish(f, "2.1");
  assert(result.deleted === 2 && result.userMessagesRemaining);
  assert(f.calls.history === 0 && f.deleted.join() === "2.2,2.1");
  assert(f.records.get("task_displays")!.has("DALICE:5.1"));
  assert((await f.store.get(f.batch.id))?.invitations?.UALICE.status === "pending");
});

Deno.test("requester-authorized user deletion removes their own thread messages alongside bot replies", async () => {
  const f = await fixture();
  const result = await finish(f, "2.1", f.userClient);
  assert(result.deleted === 3 && !result.userMessagesRemaining);
  assert(f.userDeleted.join() === "2.3");
  assert(f.deleted.join() === "2.2,2.1");
});

Deno.test("a different user's deletion token is rejected before any read or mutation", async () => {
  const f = await fixture();
  f.userClient.auth.test = () => Promise.resolve({ ok: true, user_id: "UBOB" });
  let rejected = false;
  try {
    await clearDmHistory(
      f.client,
      "DALICE",
      "UALICE",
      "UBOT",
      "10.1",
      "2.1",
      f.userClient,
    );
  } catch {
    rejected = true;
  }
  assert(
    rejected && !f.calls.history && !f.calls.replies && !f.deleted.length &&
      !f.userDeleted.length,
  );
});

Deno.test("failed deletes remain in the saved queue and retry without counting successful deletions twice", async () => {
  const f = await fixture();
  f.fail.add("4.1");
  const first = await clearDmHistory(f.client, "DALICE", "UALICE", "UBOT", "10.1");
  assert(first.failed === 1 && first.deleted === 1 && first.remaining);
  assert((await f.store.get(f.batch.id))?.invitations?.UALICE.status === "pending");
  f.fail.clear();
  const rest = await finish(f);
  assert(first.deleted + rest.deleted === 5);
  assert(f.deleted.filter((ts) => ts === "5.1").length === 1);
});

Deno.test("clear preserves progress across user-only history pages", async () => {
  const f = await fixture();
  const cursors: string[] = [];
  f.client.conversations.history = ({ cursor }) => {
    cursors.push(cursor ?? "");
    const index = cursor ? Number(cursor) : 0;
    return Promise.resolve(
      index < 5
        ? {
          ok: true,
          messages: [{ user: "UALICE", ts: `${index + 1}.1` }],
          response_metadata: { next_cursor: String(index + 1) },
        }
        : { ok: true, messages: [{ user: "UBOT", ts: "8.1" }] },
    );
  };
  const result = await finish(f);
  assert(result.deleted === 1 && cursors.join() === ",1,2,3,4,5");
});

Deno.test("large histories delete at most eight messages per invocation and resume the saved queue", async () => {
  const f = await fixture();
  f.client.conversations.history = () =>
    Promise.resolve({
      ok: true,
      messages: Array.from(
        { length: 40 },
        (_, index) => ({ user: "UBOT", ts: `8.${String(index + 1).padStart(6, "0")}` }),
      ),
    });
  const first = await clearDmHistory(f.client, "DALICE", "UALICE", "UBOT", "10.1");
  assert(first.deleted === 8 && first.remaining && f.calls.replies === 0);
  const rest = await finish(f);
  assert(first.deleted + rest.deleted === 40 && f.deleted.length === 40);
});

Deno.test("a saved cleanup failure resumes bookkeeping without deleting successful messages again", async () => {
  const f = await fixture();
  const query = f.client.apps.datastore.query;
  let unavailable = true;
  f.client.apps.datastore.query = (args) =>
    unavailable ? Promise.resolve({ ok: false }) : query(args);
  const first = await clearDmHistory(f.client, "DALICE", "UALICE", "UBOT", "10.1");
  assert(first.deleted === 2 && first.failed === 1 && first.remaining);
  unavailable = false;
  const rest = await finish(f);
  assert(first.deleted + rest.deleted === 5);
  assert(f.deleted.filter((ts) => ts === "4.1").length === 1);
  assert((await f.store.get(f.batch.id))?.invitations?.UALICE.messageRemoved);
});

Deno.test("authorized thread clearing deletes a user-written parent only after its bot reply", async () => {
  const f = await fixture();
  const result = await finish(f, "1.1", f.userClient);
  assert(result.deleted === 2 && !result.userMessagesRemaining);
  assert(f.deleted.join() === "1.2" && f.userDeleted.join() === "1.1");
  assert(f.calls.history === 0);
});

Deno.test("unreadable and incomplete pages fail safely before deleting messages", async () => {
  for (const mode of ["failed-history", "cursor"]) {
    const f = await fixture();
    if (mode === "failed-history") {
      f.client.conversations.history = () => Promise.resolve({ ok: false });
    } else {f.client.conversations.history = () =>
        Promise.resolve({ ok: true, messages: [], has_more: true });}
    let failed = false;
    try {
      await clearDmHistory(f.client, "DALICE", "UALICE", "UBOT", "10.1");
    } catch {
      failed = true;
    }
    assert(failed && f.deleted.length === 0);
  }
});

Deno.test("clear remains DM-only at the command boundary", async () => {
  assert(parseTaskCommand("CLEAR").kind === "clear-chat");
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
  const clear = () => {
    clears++;
    return Promise.resolve({
      deleted: 7,
      failed: 0,
      remaining: false,
      userMessagesRemaining: true,
    });
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
});
