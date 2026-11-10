import {
  type NotificationBatch,
  type NotificationClient,
  type NotificationContext,
  type NotificationStore,
  notifyAssignments,
} from "../delebot/slack/notifications.ts";
import {
  assignmentInvitationKey,
  createAssignmentTree,
  pendingAssignmentNodes,
  respondInAssignmentTree,
} from "../delebot/tasks/assignment_tree.ts";
import type { Task } from "../delebot/tasks/models.ts";
import { assert } from "./task_fixtures.ts";

let fixtureNumber = 0;
function fixture(recipients = ["UALICE"]) {
  const sequence = ++fixtureNumber;
  const tree = createAssignmentTree("UCREATOR", recipients);
  const task: Task = {
    id: `CDELIVERY${sequence}:1700000000.000001`,
    number: sequence,
    name: "Delivery review",
    links: [],
    assignees: [...recipients],
    description: "",
    dueDate: null,
    priority: null,
    completed: false,
    viewPerms: ["all"],
    editPerms: ["all"],
    teams: [],
    assignmentBased: true,
    createdBy: "UCREATOR",
    createdAt: "2023-11-14T22:13:20.000Z",
    channelId: `CDELIVERY${sequence}`,
    messageTs: "1700000000.000001",
    threadTs: "1700000000.000001",
    status: "open",
    assignmentTree: tree,
    assignmentEvents: { event1: [...recipients] },
    assignmentEventNodes: {
      event1: pendingAssignmentNodes(tree).map(assignmentInvitationKey),
    },
  };
  const batches = new Map<string, NotificationBatch>();
  let failDeliveredOnce = false;
  const store: NotificationStore = {
    get: async (id) => {
      await Promise.resolve();
      return structuredClone(batches.get(id) ?? null);
    },
    save: async (batch) => {
      await Promise.resolve();
      if (failDeliveredOnce && batch.delivered.length) {
        failDeliveredOnce = false;
        throw new Error("Temporary delivered-marker write failure");
      }
      batches.set(batch.id, structuredClone(batch));
    },
  };
  type Post = Parameters<NotificationClient["chat"]["postMessage"]>[0];
  type Update = Parameters<NonNullable<NotificationClient["chat"]["update"]>>[0];
  const posted: Array<Post & { ts: string }> = [];
  const updated: Update[] = [];
  const deleted: Array<{ channel: string; ts: string }> = [];
  let historyCalls = 0;
  const client: NotificationClient = {
    conversations: {
      open: async ({ users }) => {
        await Promise.resolve();
        return { ok: true, channel: { id: `D${users}` } };
      },
      history: ({ channel, include_all_metadata }) => {
        historyCalls++;
        assert(include_all_metadata);
        return Promise.resolve({
          ok: true,
          messages: posted.filter((message) => message.channel === channel).map((
            message,
          ) => ({
            ts: message.ts,
            metadata: message.metadata,
          })),
        });
      },
    },
    chat: {
      postMessage: async (args) => {
        await Promise.resolve();
        const ts = `10.${posted.length + 1}`;
        posted.push({ ...args, ts });
        return { ok: true, ts };
      },
      update: (args) => {
        updated.push(args);
        return Promise.resolve({ ok: true });
      },
      delete: (args) => {
        deleted.push(args);
        return Promise.resolve({ ok: true });
      },
    },
    usergroups: {
      users: { list: () => Promise.resolve({ ok: true, users: [] }) },
    },
  };
  const context: NotificationContext = {
    executionId: "FXA",
    loadAccess: (_task, userId) => Promise.resolve({ userId, teamIds: [] }),
  };
  const notify = (supplied = task, overrides: NotificationContext = {}) =>
    notifyAssignments(
      supplied,
      recipients,
      "event1",
      "TWORKSPACE",
      client,
      store,
      { ...context, ...overrides },
    );
  return {
    task,
    batches,
    store,
    client,
    posted,
    updated,
    deleted,
    notify,
    failNextDeliveredMarker() {
      failDeliveredOnce = true;
    },
    historyCalls: () => historyCalls,
  };
}

Deno.test("concurrent delivery retries for the same task event post one invitation", async () => {
  const f = fixture();
  const results = await Promise.all([f.notify(), f.notify(), f.notify()]);
  assert(results.every((result) => result.failed.length === 0));
  assert(f.posted.length === 1, "Runtime serialization must prevent competing sends");
  assert(results.filter((result) => result.interactive).length === 1);
  const batch = f.batches.get(`${f.task.id}:event1`)!;
  assert(batch.delivered.join() === "UALICE");
  assert(batch.invitations?.UALICE.messageTs === f.posted[0].ts);
});

Deno.test("a successful send with a lost delivery marker recovers its message metadata instead of reposting", async () => {
  const f = fixture();
  f.failNextDeliveredMarker();
  const failed = await f.notify();
  assert(failed.failed.includes("UALICE") && failed.interactive);
  assert(f.posted.length === 1);
  assert(f.batches.get(`${f.task.id}:event1`)!.delivered.length === 0);
  const recovered = await f.notify();
  assert(recovered.failed.length === 0 && recovered.interactive);
  assert(f.historyCalls() === 1 && f.posted.length === 1);
  const batch = f.batches.get(`${f.task.id}:event1`)!;
  assert(batch.delivered.join() === "UALICE");
  assert(batch.invitations?.UALICE.messageTs === f.posted[0].ts);
  assert(batch.invitations.UALICE.executionId === "FXA");
  await f.notify();
  assert(f.posted.length === 1 && f.historyCalls() === 1);
});

Deno.test("cross-execution recovery retains the original button execution binding", async () => {
  const f = fixture();
  f.failNextDeliveredMarker();
  await f.notify();
  const originalValue = JSON.stringify(f.posted[0].blocks);
  const recovered = await f.notify(f.task, { executionId: "FXB" });
  assert(recovered.failed.length === 0);
  assert(
    !recovered.interactive,
    "Recovering FXA's message must not keep the new FXB execution open",
  );
  assert(f.posted.length === 1 && JSON.stringify(f.posted[0].blocks) === originalValue);
  const batch = f.batches.get(`${f.task.id}:event1`)!;
  assert(batch.invitations?.UALICE.executionId === "FXA");
  assert(batch.invitations.UALICE.messageTs === f.posted[0].ts);
});

Deno.test("a stale task snapshot cannot send pending invitations after fresh acceptance", async () => {
  const f = fixture(["UALICE", "UBOB"]);
  const latest = structuredClone(f.task);
  latest.assignmentTree = respondInAssignmentTree(latest.assignmentTree!, {
    userId: "UALICE",
    kind: "accept",
  }).tree;
  latest.assignees = ["UALICE"];
  const result = await f.notify(f.task, { loadTask: () => Promise.resolve(latest) });
  assert(result.failed.length === 0 && !result.interactive);
  assert(f.posted.length === 0);
});

Deno.test("a stale invitation generation cannot send an invitation for a newer delegation round", async () => {
  const f = fixture();
  const latest = structuredClone(f.task);
  const member = pendingAssignmentNodes(latest.assignmentTree!)[0];
  member.generation++;
  const result = await f.notify(f.task, { loadTask: () => Promise.resolve(latest) });
  assert(result.failed.length === 0 && !result.interactive);
  assert(f.posted.length === 0);
  assert(f.batches.get(`${f.task.id}:event1`)!.cancelled.includes("UALICE"));
});

Deno.test("global acceptance updates every competing pending DM to a closed accepted-by summary", async () => {
  const f = fixture(["UALICE", "UBOB", "UCAROL"]);
  assert((await f.notify()).failed.length === 0 && f.posted.length === 3);
  const accepted = structuredClone(f.task);
  accepted.assignmentTree = respondInAssignmentTree(accepted.assignmentTree!, {
    userId: "UALICE",
    kind: "accept",
  }).tree;
  accepted.assignees = ["UALICE"];
  const result = await f.notify(f.task, { loadTask: () => Promise.resolve(accepted) });
  assert(result.failed.length === 0 && f.posted.length === 3);
  for (const userId of ["UBOB", "UCAROL"]) {
    const changed = f.updated.find((message) => message.channel === `D${userId}`);
    assert(changed && changed.text.includes("Accepted by <@UALICE>"));
    assert(changed.blocks.length === 0, "Other recipients must lose all action buttons");
  }
  const batch = f.batches.get(`${f.task.id}:event1`)!;
  assert(
    batch.invitations?.UBOB.status === "cancelled" &&
      batch.invitations.UBOB.closedBy === "UALICE",
  );
  assert(
    batch.invitations.UCAROL.status === "cancelled" &&
      batch.invitations.UCAROL.closedBy === "UALICE",
  );
  const updates = f.updated.length;
  await f.notify(accepted);
  assert(
    f.updated.length === updates,
    "Repeating delivery must not rewrite closed summaries",
  );
  assert(
    f.deleted.length === 0,
    "Accepted-by summaries remain visible to the other recipients",
  );
});
