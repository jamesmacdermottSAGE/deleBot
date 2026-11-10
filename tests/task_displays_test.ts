import { SlackTaskDisplays, taskDisplays } from "../delebot/slack/task_displays.ts";
import { createTask, respondToAssignment } from "../delebot/tasks/service.ts";
import { assert, MemoryTaskRepository } from "./task_fixtures.ts";
import {
  ASSIGNMENT_ACCEPT,
  ASSIGNMENT_DELEGATE,
  ASSIGNMENT_REJECT,
  type MessageBlocks,
  notifyTaskAssignments,
  SlackNotificationStore,
} from "../delebot/slack/notifications.ts";

async function fixture() {
  const repo = new MemoryTaskRepository();
  const { task } = await createTask(
    { name: "Live task", assignees: ["UALICE"] },
    { channelId: "DTEST", messageTs: "1.1", userId: "UCREATOR" },
    repo,
    { userId: "UCREATOR", teamIds: [] },
  );
  const records = new Map<string, Record<string, unknown>>();
  const updates: Array<{ channel: string; ts: string; text: string }> = [];
  const deleted: string[] = [];
  const client = {
    apps: {
      datastore: {
        get: () => Promise.resolve({ ok: true, item: {} }),
        put: ({ item }: { datastore: string; item: Record<string, unknown> }) => {
          records.set(item.id as string, item);
          return Promise.resolve({ ok: true });
        },
        query: ({ datastore }: { datastore: string }) =>
          Promise.resolve({
            ok: true,
            items: datastore === "assignment_notifications"
              ? []
              : datastore === "task_displays"
              ? [...records.values()]
              : [
                { id: "DOLD:9.1:UALICE", user_id: "UALICE", task_ids: [task.id] },
                { id: "DOLD:latest:UALICE", user_id: "UALICE", task_ids: [task.id] },
              ],
          }),
      },
    },
    chat: {
      update: (args: { channel: string; ts: string; text: string }) => {
        updates.push(args);
        return Promise.resolve({ ok: true });
      },
      delete: ({ channel, ts }: { channel: string; ts: string }) => {
        deleted.push(`${channel}:${ts}`);
        return Promise.resolve({ ok: true });
      },
    },
  };
  const displays = new SlackTaskDisplays(
    client,
    (_task, userId) => Promise.resolve({ userId, teamIds: [] }),
  );
  await displays.track(task.id, "DALICE", "2.1", "UALICE");
  await displays.track(task.id, "DCREATOR", "2.2", "UCREATOR");
  return { displays, client, task, repo, updates, deleted };
}

Deno.test("acceptance and completion refresh every tracked card and recover older DM copies", async () => {
  const f = await fixture();
  const accepted = await respondToAssignment(
    f.task,
    { kind: "accept" },
    { channelId: "DALICE", messageTs: "3.1", userId: "UALICE" },
    f.repo,
    { userId: "UALICE", teamIds: [] },
  );
  assert(await f.displays.refresh(accepted.task) === 0);
  assert(f.updates.length === 3);
  assert(
    f.updates.every((entry) =>
      entry.text.includes("<@UALICE> ✅") && !entry.text.includes("Pending")
    ),
  );
  f.updates.length = 0;
  await f.displays.refresh({ ...accepted.task, completed: true, status: "completed" });
  assert(
    f.updates.length === 3 &&
      f.updates.every((entry) => entry.text.includes("*Completed:* ✅")),
  );
});

Deno.test("display refresh removes revoked private copies and marks deleted tasks without retaining details", async () => {
  const f = await fixture();
  await f.displays.refresh({ ...f.task, viewPerms: ["UCREATOR"] });
  assert(f.deleted.includes("DALICE:2.1") && f.deleted.includes("DOLD:9.1"));
  assert(f.updates.length === 1 && f.updates[0].channel === "DCREATOR");
  f.updates.length = 0;
  await f.displays.refresh({ ...f.task, deleted: true });
  assert(
    f.updates.length === 3 &&
      f.updates.every((entry) => entry.text === "🗑️ Task deleted"),
  );
});

Deno.test("message-update failures are counted so callers cannot falsely claim every copy refreshed", async () => {
  const f = await fixture();
  f.client.chat.update = () => Promise.resolve({ ok: false });
  assert(await f.displays.refresh(f.task) === 3);
});

Deno.test("refresh preserves verified team handles on tracked and recovered cards", async () => {
  const f = await fixture();
  const displays = new SlackTaskDisplays(f.client, (_task, userId) =>
    Promise.resolve({
      userId,
      teamIds: ["SJSQUAD"],
      teamNames: { SJSQUAD: "jsquad" },
    }));
  const task = { ...f.task, assignees: ["SJSQUAD"], teams: ["SJSQUAD"] };
  assert(await displays.refresh(task) === 0);
  assert(f.updates.length === 3);
  assert(
    f.updates.every((update) =>
      update.text.includes("@jsquad ⏳ Pending") && !update.text.includes("Team SJSQUAD")
    ),
  );
});

Deno.test("short confirmations stored as conversation context are never promoted to task cards", async () => {
  const f = await fixture();
  const query = f.client.apps.datastore.query;
  f.client.apps.datastore.query = ({ datastore }) =>
    datastore === "task_conversations"
      ? Promise.resolve({
        ok: true,
        items: [
          {
            id: "DALICE:99.1:UALICE",
            user_id: "UALICE",
            task_ids: [f.task.id],
            message_kind: "context",
          },
        ],
      })
      : query({ datastore });
  assert(await f.displays.refresh(f.task) === 0);
  assert(!f.updates.some((entry) => entry.ts === "99.1"));
});

for (const variant of ["person", "team", "returned", "note"]) {
  const teamAssignment = variant === "team";
  Deno.test(`refresh preserves and repairs pending ${variant} invitation buttons recovered from DM context`, async () => {
    const repo = new MemoryTaskRepository();
    const { task } = await createTask(
      { name: "Invite", assignees: [teamAssignment ? "SJSQUAD" : "UALICE"] },
      { channelId: "DTEST", messageTs: "1.1", userId: "UCREATOR" },
      repo,
      { userId: "UCREATOR", teamIds: [] },
    );
    if (variant === "returned") {
      task.assignmentResponses!.UALICE = {
        status: "pending",
        returnedBy: "UBOB",
        returnTo: [],
      };
    }
    if (variant === "note") {
      task.assignmentResponses!.UALICE.note = "Review <changes> & reply.";
    }
    const stores = new Map<string, Map<string, Record<string, unknown>>>();
    const messages = new Map<string, { text: string; blocks?: MessageBlocks }>();
    let posts = 0;
    let membershipAvailable = true;
    let deletions = 0;
    let membershipCalls = 0;
    const client = {
      apps: {
        datastore: {
          put: (
            { datastore, item }: { datastore: string; item: Record<string, unknown> },
          ) => {
            if (!stores.has(datastore)) stores.set(datastore, new Map());
            stores.get(datastore)!.set(item.id as string, structuredClone(item));
            return Promise.resolve({ ok: true });
          },
          get: ({ datastore, id }: { datastore: string; id: string }) =>
            Promise.resolve({ ok: true, item: stores.get(datastore)?.get(id) ?? {} }),
          query: ({ datastore }: { datastore: string }) =>
            Promise.resolve({
              ok: true,
              items: [...stores.get(datastore)?.values() ?? []],
            }),
        },
      },
      conversations: {
        open: () => Promise.resolve({ ok: true, channel: { id: "DALICE" } }),
        info: () => Promise.resolve({ ok: true, channel: {} }),
      },
      usergroups: {
        list: () =>
          Promise.resolve({
            ok: true,
            usergroups: [{
              id: "SJSQUAD",
              handle: "jsquad",
              date_delete: 0,
              is_section: true,
            }],
          }),
        users: {
          list: ({ team_id }: { team_id?: string }) => {
            membershipCalls++;
            assert(
              team_id === "TTEST",
              "Refresh must reuse the saved delivery workspace",
            );
            return Promise.resolve({ ok: membershipAvailable, users: ["UALICE"] });
          },
        },
      },
      chat: {
        postMessage: (
          args: { channel: string; text: string; blocks?: MessageBlocks },
        ) => {
          posts++;
          messages.set("DALICE:10.1", args);
          return Promise.resolve({ ok: true, ts: "10.1" });
        },
        update: (
          args: { channel: string; ts: string; text: string; blocks: MessageBlocks },
        ) => {
          messages.set(`${args.channel}:${args.ts}`, args);
          return Promise.resolve({ ok: true });
        },
        delete: () => {
          deletions++;
          return Promise.resolve({ ok: true });
        },
      },
    };
    const loadAccess = (_task: unknown, userId: string) =>
      Promise.resolve({ userId, teamIds: ["SJSQUAD"], teamNames: { SJSQUAD: "jsquad" } });
    const result = await notifyTaskAssignments(
      task,
      "TTEST",
      client,
      new SlackNotificationStore(client),
      {
        executionId: "FXORIGINAL",
        loadAccess,
        rememberTask: (channel, ts, user, taskId) =>
          client.apps.datastore.put({
            datastore: "task_conversations",
            item: { id: `${channel}:${ts}:${user}`, user_id: user, task_ids: [taskId] },
          }).then(() => {}),
      },
    );
    assert(result.interactive && posts === 1);
    const originalText = messages.get("DALICE:10.1")!.text;
    const originalButtons = JSON.stringify(messages.get("DALICE:10.1")!.blocks);
    const displays = taskDisplays(
      client as unknown as Parameters<typeof taskDisplays>[0],
    );
    await displays.track(task.id, "DCREATOR", "11.1", "UCREATOR");
    assert(await displays.refresh(task) === 0);
    if (variant === "returned") {
      assert(messages.get("DALICE:10.1")!.text === originalText);
      assert(!originalText.includes("*Assignees:*"));
    }
    if (variant === "note") {
      assert(
        messages.get("DALICE:10.1")!.text.includes(
          "*Note:* Review &lt;changes&gt; &amp; reply.",
        ),
      );
    }
    if (teamAssignment) {
      for (const key of ["DALICE:10.1", "DCREATOR:11.1"]) {
        assert(messages.get(key)!.text.includes("@jsquad ⏳ Pending"));
        assert(!messages.get(key)!.text.includes("Team SJSQUAD"));
      }
    }
    const after = JSON.stringify(messages.get("DALICE:10.1")!.blocks);
    for (const action of [ASSIGNMENT_ACCEPT, ASSIGNMENT_REJECT, ASSIGNMENT_DELEGATE]) {
      assert(after.includes(action));
    }
    const originalValue = JSON.parse(originalButtons)[1].elements[0].value;
    assert(after.includes(originalValue.replaceAll('"', '\\"')));
    // Reproduce the old version stripping the controls, then recover on a list refresh.
    messages.set("DALICE:10.1", { text: "Plain task card", blocks: [] });
    assert(await displays.refresh(task) === 0);
    if (variant === "returned") {
      assert(messages.get("DALICE:10.1")!.text === originalText);
    }
    if (variant === "note") {
      assert(
        messages.get("DALICE:10.1")!.text.includes(
          "*Note:* Review &lt;changes&gt; &amp; reply.",
        ),
      );
    }
    assert(
      JSON.stringify(messages.get("DALICE:10.1")!.blocks).includes(ASSIGNMENT_ACCEPT),
    );
    assert(
      posts === 1,
      "Repair must update the same DM, preserving its execution binding",
    );
    assert(messages.get("DCREATOR:11.1")!.blocks?.length === 0);
    if (teamAssignment) {
      assert(membershipCalls > 0 && deletions === 0);
      membershipAvailable = false;
      assert(await displays.refresh(task) > 0);
      assert(
        deletions === 0,
        "A failed membership lookup must preserve pending invitations",
      );
      assert(
        JSON.stringify(messages.get("DALICE:10.1")!.blocks).includes(ASSIGNMENT_ACCEPT),
      );
      membershipAvailable = true;
      assert(await displays.refresh(task) === 0);
    }
  });
}
