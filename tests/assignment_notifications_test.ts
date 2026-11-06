import {
  AssignmentNotificationsDatastore,
  type NotificationBatch,
  type NotificationClient,
  type NotificationStore,
  type NotificationTask,
  notifyAssignments,
  notifyTaskAssignments,
  SlackNotificationStore,
} from "../delebot/slack/notifications.ts";
import { createTask, updateTask } from "../delebot/tasks/service.ts";
import { MemoryTaskRepository } from "./task_fixtures.ts";

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

class MemoryStore implements NotificationStore {
  rows = new Map<string, NotificationBatch>();
  writes = 0;
  failAtWrite = -1;
  get(id: string): Promise<NotificationBatch | null> {
    return Promise.resolve(structuredClone(this.rows.get(id) ?? null));
  }
  save(batch: NotificationBatch): Promise<void> {
    this.writes++;
    if (this.writes === this.failAtWrite) return Promise.reject(new Error("unavailable"));
    this.rows.set(batch.id, structuredClone(batch));
    return Promise.resolve();
  }
}

function fixture(assigned = ["UJAMES"] as string[]) {
  const task: NotificationTask = {
    id: "CTEST:1793690000.000001",
    number: 42,
    name: "Clean PRs",
    assignees: assigned,
    channelId: "CTEST",
    messageTs: "1793690000.000001",
  };
  const posts: Array<{ channel: string; text: string }> = [];
  const opens: string[] = [];
  const groups = new Map<string, unknown>();
  const groupCalls: Array<
    { usergroup: string; team_id?: string; include_disabled: boolean }
  > = [];
  const failedDm = new Set<string>();
  const failedSend = new Set<string>();
  const client: NotificationClient = {
    conversations: {
      open: ({ users }) => {
        opens.push(users);
        return Promise.resolve(
          failedDm.has(users)
            ? { ok: false, error: "cannot_open" }
            : { ok: true, channel: { id: `D${users}` } },
        );
      },
    },
    chat: {
      postMessage: (args) => {
        if (failedSend.has(args.channel)) {
          return Promise.resolve({ ok: false, error: "ratelimited" });
        }
        posts.push(args);
        return Promise.resolve({ ok: true, ts: "10.1" });
      },
      getPermalink: () =>
        Promise.resolve({
          ok: true,
          permalink: "https://example.slack.com/archives/CTEST/p1793690000000001",
        }),
    },
    usergroups: {
      users: {
        list: (args) => {
          groupCalls.push(args);
          return Promise.resolve(
            groups.has(args.usergroup)
              ? { ok: true, users: groups.get(args.usergroup) }
              : { ok: false, error: "usergroup_not_found" },
          );
        },
      },
    },
  };
  const store = new MemoryStore();
  const notify = (assigned = task.assignees) =>
    notifyAssignments(task, assigned, "event1", "TWORKSPACE", client, store);
  return {
    task,
    posts,
    opens,
    groups,
    groupCalls,
    failedDm,
    failedSend,
    client,
    store,
    notify,
  };
}

Deno.test("assignment notifications include task details and notify each directly assigned user once", async () => {
  const { task, posts, opens, store, notify } = fixture(["UJAMES", "UCREATOR", "UJAMES"]);
  task.name = "Review <!channel> & <@UOTHER>";
  const result = await notify();
  assert(result.failed.length === 0 && posts.length === 2);
  assert(opens.join() === "UJAMES,UCREATOR");
  assert(
    posts.every((post) => post.channel.startsWith("D") && post.text.includes("#42")),
  );
  assert(posts[0].text.includes("&lt;!channel&gt; &amp; &lt;@UOTHER&gt;"));
  assert(!posts[0].text.includes("<!channel>"));
  assert(
    !posts[0].text.includes("Open task thread") &&
      posts[0].text.includes("delegate @person"),
  );
  assert([...store.rows.values()][0].delivered.join() === "UJAMES,UCREATOR");
});

Deno.test("team assignments expand to actual members and deduplicate overlapping teams and people", async () => {
  const { groups, posts, groupCalls, notify } = fixture([
    "UJAMES",
    "SFRONTEND",
    "SBACKEND",
  ]);
  groups.set("SFRONTEND", ["UJAMES", "UALICE"]);
  groups.set("SBACKEND", ["UALICE", "WBOB"]);
  assert((await notify()).failed.length === 0);
  assert(posts.map((post) => post.channel).sort().join() === "DUALICE,DUJAMES,DWBOB");
  assert(
    groupCalls.every((args) =>
      args.team_id === "TWORKSPACE" && args.include_disabled === false
    ),
  );
  await notify([]);
  assert(posts.length === 3 && groupCalls.length === 2);
});

Deno.test("a replay resumes failed recipients without repeating successful notifications", async () => {
  const { failedSend, posts, notify, store } = fixture(["UJAMES", "UALICE"]);
  failedSend.add("DUALICE");
  assert((await notify()).failed.join() === "UALICE");
  assert(posts.length === 1 && posts[0].channel === "DUJAMES");
  failedSend.clear();
  assert((await notify([])).failed.length === 0);
  assert(Number(posts.length) === 2 && posts[1].channel === "DUALICE");
  assert([...store.rows.values()][0].delivered.length === 2);
  await notify([]);
  assert(Number(posts.length) === 2);
});

Deno.test("a later task update resumes failed assignment delivery without repeating successes", async () => {
  const { task, failedSend, posts, client, store } = fixture(["UJAMES", "UALICE"]);
  const repository = new MemoryTaskRepository();
  const context = {
    channelId: task.channelId,
    messageTs: task.messageTs,
    userId: "UCREATOR",
  };
  const access = { userId: context.userId, teamIds: [] };
  const created = await createTask(
    { name: task.name, assignees: task.assignees },
    context,
    repository,
    access,
  );
  failedSend.add("DUALICE");
  assert(
    (await notifyTaskAssignments(created.task, "TWORKSPACE", client, store))
      .failed.join() === "UALICE",
  );
  assert(posts.map((post) => post.channel).join() === "DUJAMES");

  const updated = await updateTask(
    created.task,
    { description: "Review the remaining changes." },
    { ...context, messageTs: "1793690001.000001" },
    repository,
    access,
  );
  assert(Object.keys(updated.task.assignmentEvents ?? {}).length === 2);
  failedSend.clear();
  assert(
    (await notifyTaskAssignments(updated.task, "TWORKSPACE", client, store))
      .failed.length === 0,
  );
  assert(posts.map((post) => post.channel).join() === "DUJAMES,DUALICE");
  assert(store.rows.size === 1, "A description update must not create a delivery batch.");

  const assigned = await updateTask(
    updated.task,
    { assignees: ["UBOB"] },
    { ...context, messageTs: "1793690002.000001" },
    repository,
    access,
  );
  assert(
    (await notifyTaskAssignments(assigned.task, "TWORKSPACE", client, store))
      .failed.length === 0,
  );
  assert(posts.map((post) => post.channel).join() === "DUJAMES,DUALICE,DUBOB");
  await notifyTaskAssignments(assigned.task, "TWORKSPACE", client, store);
  assert(Number(posts.length) === 3 && Number(store.rows.size) === 2);
});

Deno.test("later task updates cancel queued notifications for removed assignments", async () => {
  const { task, failedDm, posts, client, store } = fixture(["UJAMES"]);
  const repository = new MemoryTaskRepository();
  const context = {
    channelId: task.channelId,
    messageTs: task.messageTs,
    userId: "UCREATOR",
  };
  const access = { userId: context.userId, teamIds: [] };
  const created = await createTask(
    { name: task.name, assignees: task.assignees },
    context,
    repository,
    access,
  );
  failedDm.add("UJAMES");
  assert(
    (await notifyTaskAssignments(created.task, "TWORKSPACE", client, store))
      .failed.join() === "UJAMES",
  );
  const updated = await updateTask(
    created.task,
    { assignees: ["all"] },
    { ...context, messageTs: "1793690001.000001" },
    repository,
    access,
  );
  failedDm.clear();
  assert(
    (await notifyTaskAssignments(updated.task, "TWORKSPACE", client, store))
      .failed.length === 0,
  );
  assert(posts.length === 0 && store.rows.size === 1);
  assert([...store.rows.values()][0].cancelled.join() === "UJAMES");
});

Deno.test("task notification recovery deduplicates failures across assignment events", async () => {
  const { task, failedDm, posts, client, store } = fixture(["UJAMES"]);
  const created = await createTask(
    { name: task.name, assignees: task.assignees },
    { channelId: task.channelId, messageTs: task.messageTs, userId: "UCREATOR" },
    new MemoryTaskRepository(),
    { userId: "UCREATOR", teamIds: [] },
  );
  created.task.assignmentEvents = {
    event1: ["UJAMES"],
    event2: ["UJAMES"],
    event3: ["all"],
    event4: [],
  };
  failedDm.add("UJAMES");
  assert(
    (await notifyTaskAssignments(created.task, "TWORKSPACE", client, store))
      .failed.join() === "UJAMES",
  );
  assert(posts.length === 0 && store.rows.size === 2);
});

Deno.test("pending group expansion can retry while direct assignments are already delivered", async () => {
  const { groups, posts, notify } = fixture(["UJAMES", "SFRONTEND"]);
  assert((await notify()).failed.includes("SFRONTEND"));
  assert(posts.length === 1);
  groups.set("SFRONTEND", ["UJAMES", "UALICE"]);
  assert((await notify([])).failed.length === 0);
  assert(Number(posts.length) === 2 && posts[1].channel === "DUALICE");
});

Deno.test("revoked group members do not receive pending private assignment details", async () => {
  const { groups, failedDm, posts, store, notify } = fixture(["SFRONTEND"]);
  groups.set("SFRONTEND", ["UJAMES", "UALICE"]);
  failedDm.add("UALICE");
  assert((await notify()).failed.join() === "UALICE");
  groups.set("SFRONTEND", ["UJAMES"]);
  failedDm.clear();
  assert((await notify([])).failed.length === 0);
  assert(posts.length === 1 && posts[0].channel === "DUJAMES");
  assert([...store.rows.values()][0].cancelled.includes("UALICE"));
});

Deno.test("removed direct assignees do not receive a queued notification", async () => {
  const { task, failedDm, posts, notify } = fixture();
  failedDm.add("UJAMES");
  assert((await notify()).failed.join() === "UJAMES");
  task.assignees = ["UALICE"];
  failedDm.clear();
  assert((await notify([])).failed.length === 0 && posts.length === 0);
});

Deno.test("all does not broadcast DMs and an event without new assignments does not create an outbox", async () => {
  const { posts, store, notify } = fixture(["all"]);
  assert((await notify()).failed.length === 0);
  assert((await notify([])).failed.length === 0);
  assert(posts.length === 0 && store.rows.size === 0);
});

Deno.test("name-only task creation has no assignment delivery intent", async () => {
  const { task, posts, client, store } = fixture();
  const created = await createTask(
    { name: task.name },
    { channelId: task.channelId, messageTs: task.messageTs, userId: "UCREATOR" },
    new MemoryTaskRepository(),
    { userId: "UCREATOR", teamIds: [] },
  );
  assert(created.task.assignees.length === 0);
  assert(
    (await notifyTaskAssignments(created.task, "TWORKSPACE", client, store))
      .failed.length === 0,
  );
  assert(posts.length === 0 && store.rows.size === 0);
});

Deno.test("invalid or incomplete group membership fails closed", async () => {
  const { groups, posts, notify } = fixture(["SFRONTEND"]);
  groups.set("SFRONTEND", ["UJAMES", 2]);
  assert((await notify()).failed.includes("SFRONTEND"));
  assert(posts.length === 0);
});

Deno.test("unavailable delivery state prevents sends and errors never falsely report success", async () => {
  const { store, posts, notify } = fixture();
  store.get = () => Promise.reject(new Error("unavailable"));
  assert((await notify()).failed.includes("delivery_state") && posts.length === 0);
  const second = fixture();
  second.store.failAtWrite = 1;
  assert(
    (await second.notify()).failed.includes("delivery_state") &&
      second.posts.length === 0,
  );
});

Deno.test("a successful send with a failed marker write is reported as unconfirmed delivery", async () => {
  const { store, posts, notify } = fixture(["UJAMES", "UALICE"]);
  store.failAtWrite = 3;
  const result = await notify();
  assert(posts.length === 1);
  assert(result.failed.includes("UJAMES") && result.failed.includes("UALICE"));
  assert([...store.rows.values()][0].delivered.length === 0);
});

Deno.test("a non-DM channel response never receives assignment details", async () => {
  const { client, posts, notify } = fixture();
  client.conversations.open = () =>
    Promise.resolve({ ok: true, channel: { id: "CPUBLIC" } });
  assert((await notify()).failed.includes("UJAMES") && posts.length === 0);
});

Deno.test("explicit private viewing permissions fail closed without an access loader", async () => {
  const { task, posts, client, store } = fixture();
  task.viewPerms = ["UJAMES"];
  const result = await notifyAssignments(
    task,
    task.assignees,
    "event1",
    "TWORKSPACE",
    client,
    store,
    { executionId: "FXORIGIN" },
  );
  assert(result.failed.includes("UJAMES") && !result.interactive && posts.length === 0);
});

Deno.test("fresh viewing permission and current group assignment are both required before sending", async () => {
  const { task, posts, client, store, groups } = fixture(["SFRONTEND"]);
  task.viewPerms = ["all"];
  groups.set("SFRONTEND", ["UJAMES"]);
  const result = await notifyAssignments(
    task,
    task.assignees,
    "event1",
    "TWORKSPACE",
    client,
    store,
    {
      executionId: "FXORIGIN",
      loadAccess: (_task, userId) => Promise.resolve({ userId, teamIds: [] }),
    },
  );
  assert(!result.interactive && posts.length === 0);
  assert([...store.rows.values()][0].cancelled.includes("UJAMES"));
});

Deno.test("revoked viewing permission removes delivered invitations and retries cleanup failures", async () => {
  const { task, posts, client, store } = fixture();
  task.viewPerms = ["SREADERS"];
  let member = true;
  let failDelete = true;
  const deleted: string[] = [];
  client.chat.delete = ({ channel, ts }) => {
    deleted.push(`${channel}:${ts}`);
    return Promise.resolve(
      failDelete ? { ok: false, error: "ratelimited" } : { ok: true },
    );
  };
  const context = {
    executionId: "FXORIGIN",
    loadAccess: (_task: unknown, userId: string) =>
      Promise.resolve({ userId, teamIds: member ? ["SREADERS"] : [] }),
  };
  assert(
    (await notifyAssignments(
      task,
      task.assignees,
      "event1",
      "TWORKSPACE",
      client,
      store,
      context,
    )).interactive,
  );
  assert(posts.length === 1);
  member = false;
  const failed = await notifyAssignments(
    task,
    [],
    "event1",
    "TWORKSPACE",
    client,
    store,
    context,
  );
  assert(failed.failed.includes("UJAMES") && !failed.interactive);
  assert([...store.rows.values()][0].invitations?.UJAMES.status === "cancelled");
  failDelete = false;
  assert(
    (await notifyAssignments(task, [], "event1", "TWORKSPACE", client, store, context))
      .failed.length === 0,
  );
  assert(posts.length === 1 && deleted.join() === "DUJAMES:10.1,DUJAMES:10.1");
  assert([...store.rows.values()][0].invitations?.UJAMES.messageRemoved);
});

Deno.test("notification datastore round trips IDs and rejects corrupt or failed records", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  let failed = false;
  const store = new SlackNotificationStore({
    apps: {
      datastore: {
        get: ({ id }) => Promise.resolve({ ok: !failed, item: rows.get(id) ?? {} }),
        put: ({ datastore, item }) => {
          assert(datastore === AssignmentNotificationsDatastore.name);
          if (failed) return Promise.resolve({ ok: false });
          rows.set(item.id as string, structuredClone(item));
          return Promise.resolve({ ok: true });
        },
      },
    },
  });
  const batch: NotificationBatch = {
    id: "task:event",
    taskId: "task",
    eventKey: "event",
    assigned: ["SFRONTEND"],
    recipients: ["UJAMES"],
    delivered: ["UJAMES"],
    cancelled: [],
    resolvedGroups: ["SFRONTEND"],
  };
  assert(await store.get(batch.id) === null);
  await store.save(batch);
  const restored = await store.get(batch.id);
  assert(restored?.delivered.join() === "UJAMES");
  assert(!JSON.stringify(rows.get(batch.id)).includes("Clean PRs"));
  rows.set(batch.id, {
    id: batch.id,
    task_id: "task",
    event_key: "event",
    state: "invalid json",
  });
  let rejected = false;
  try {
    await store.get(batch.id);
  } catch {
    rejected = true;
  }
  assert(rejected);
  failed = true;
  rejected = false;
  try {
    await store.save(batch);
  } catch {
    rejected = true;
  }
  assert(rejected);
});
