import { ASSIGNMENT_ACCEPT, ASSIGNMENT_REJECT } from "../delebot/slack/notifications.ts";
import { handleMessage, type MessageClient } from "../delebot/slack/events.ts";
import { SlackDmContexts } from "../delebot/slack/dm_context.ts";
import { SlackTaskDisplays } from "../delebot/slack/task_displays.ts";
import {
  type MessageBlocks,
  type NotificationClient,
  SlackNotificationStore,
} from "../delebot/slack/notifications.ts";
import { handleAssignmentAction } from "../delebot/slack/actions.ts";
import {
  COLLAB_REJECT,
  handleParticipationAction,
  REQUEST_APPROVE,
} from "../delebot/slack/participation_messages.ts";
import { parseTaskCommand } from "../delebot/tasks/commands.ts";
import { recipientMentions } from "../delebot/slack/delegation_input.ts";
import { assert, MemoryTaskRepository, teamDirectory } from "./task_fixtures.ts";

function fixture() {
  const repository = new MemoryTaskRepository();
  const records = new Map<string, Map<string, Record<string, unknown>>>();
  const table = (name: string) => {
    if (!records.has(name)) records.set(name, new Map());
    return records.get(name)!;
  };
  type Post = {
    channel: string;
    text: string;
    ts: string;
    thread_ts?: string;
    blocks?: MessageBlocks;
  };
  const posts: Post[] = [], updates: Post[] = [];
  const removed = new Set<string>();
  let failContext = false, refuseDm = false, clock = 0;
  const client = {
    auth: { test: () => Promise.resolve({ ok: true, user_id: "UBOT" }) },
    users: { info: () => Promise.resolve({ ok: true, user: {} }) },
    conversations: {
      info: () => Promise.resolve({ ok: true, channel: { context_team_id: "TTEST" } }),
      open: ({ users }: { users: string }) =>
        Promise.resolve({ ok: true, channel: { id: `D${users}` } }),
    },
    usergroups: {
      list: () => Promise.resolve({ ok: true, usergroups: [] }),
      users: { list: () => Promise.resolve({ ok: true, users: [] }) },
    },
    functions: { completeSuccess: () => Promise.resolve({ ok: true }) },
    apps: {
      datastore: {
        get: ({ datastore, id }: { datastore: string; id: string }) =>
          Promise.resolve({ ok: true, item: table(datastore).get(id) ?? {} }),
        put: (
          { datastore, item }: { datastore: string; item: Record<string, unknown> },
        ) => {
          if (failContext && datastore === "task_conversations") {
            return Promise.resolve({
              ok: false,
              error: "internal_error",
            });
          }
          table(datastore).set(item.id as string, structuredClone(item));
          return Promise.resolve({ ok: true });
        },
        query: (
          { datastore, expression_values }: {
            datastore: string;
            expression_values: Record<string, string>;
          },
        ) =>
          Promise.resolve({
            ok: true,
            items: [...table(datastore).values()].filter((item) =>
              datastore === "task_conversations"
                ? (item.task_ids as string[] | undefined)?.includes(
                  expression_values[":task"],
                )
                : item.task_id === expression_values[":task"]
            ),
          }),
      },
    },
    chat: {
      postEphemeral: () => Promise.resolve({ ok: true }),
      postMessage: (
        args: Parameters<MessageClient["chat"]["postMessage"]>[0] & {
          blocks?: MessageBlocks;
        },
      ) => {
        if (refuseDm && args.channel === "DOLD") {
          return Promise.resolve({
            ok: false,
            error: "restricted_action_read_only_channel",
          });
        }
        if (args.thread_ts && removed.has(`${args.channel}:${args.thread_ts}`)) {
          return Promise.resolve({ ok: false, error: "thread_not_found" });
        }
        const post = { ...args, ts: `100.${++clock}` };
        posts.push(post);
        return Promise.resolve({ ok: true, ts: post.ts });
      },
      update: (
        args: { channel: string; ts: string; text: string; blocks: MessageBlocks },
      ) => {
        updates.push(args);
        return Promise.resolve({ ok: true });
      },
      delete: ({ channel, ts }: { channel: string; ts: string }) => {
        removed.add(`${channel}:${ts}`);
        return Promise.resolve({ ok: true });
      },
    },
  };
  const contexts = new SlackDmContexts(client),
    store = new SlackNotificationStore(client);
  const loadAccess = (_task: unknown, userId: string) =>
    Promise.resolve({ userId, teamIds: [] });
  const rememberTask = async (
    channel: string,
    ts: string,
    user: string,
    taskId: string,
  ) => {
    await contexts.save(channel, ts, user, [taskId], "invitation");
  };
  const displays = new SlackTaskDisplays(
    client,
    loadAccess,
    (id) => repository.findById(id),
    rememberTask,
  );
  const dependencies = { client, repository, store, loadAccess, displays, rememberTask };
  async function command(
    user: string,
    text: string,
    thread?: string,
    channel = `D${user}`,
  ) {
    return await handleMessage(
      {
        channel_id: channel,
        channel_type: "dm",
        user_id: user,
        message_ts: `10.${++clock}`,
        text,
        ...(thread ? { thread_ts: thread } : {}),
      },
      client,
      repository,
      teamDirectory,
      {
        client: client as NotificationClient,
        store,
        context: { executionId: "FXTEST", loadAccess, rememberTask },
      },
      undefined,
      contexts,
      displays,
    );
  }
  const task = () => [...repository.rows.values()][0];
  async function assignment(user: string, actionId: string) {
    const batches = [...table("assignment_notifications").values()].map((item) =>
      store.fromRecord(item, item.id as string)
    );
    const batch = batches.findLast((batch) => batch.invitations?.[user])!,
      invitation = batch.invitations![user];
    return await handleAssignmentAction({
      actionId,
      value: JSON.stringify({
        batchId: batch.id,
        recipientId: user,
        invitationId: invitation.id,
      }),
      userId: user,
      channelId: invitation.channelId!,
      messageTs: invitation.messageTs!,
      executionId: invitation.executionId,
      actionTs: `20.${++clock}`,
    }, {
      ...dependencies,
      client: { ...client, views: { open: () => Promise.resolve({ ok: true }) } },
    });
  }
  async function participation(user: string, actionId: string, note?: string) {
    const delivery = Object.values(task().participation!.deliveryEvents).findLast((
      delivery,
    ) => delivery.deliveries?.[user])!;
    const binding = delivery.deliveries![user];
    const eventKey =
      Object.entries(task().participation!.deliveryEvents).find(([, value]) =>
        value.reference === delivery.reference
      )![0];
    return await handleParticipationAction({
      actionId,
      userId: user,
      channelId: binding.channelId!,
      messageTs: binding.messageTs!,
      executionId: binding.executionId,
      value: JSON.stringify({
        taskId: task().id,
        eventKey,
        recipientId: user,
        bindingId: binding.id,
      }),
      actionTs: `30.${++clock}`,
      note,
    }, { ...dependencies, notificationStore: store });
  }
  return {
    command,
    task,
    posts,
    updates,
    assignment,
    participation,
    contexts,
    client,
    displays,
    setFailContext: () => {
      failContext = true;
    },
    setRefuseDm: () => {
      refuseDm = true;
    },
  };
}

Deno.test("creator-only Access routes completion requests once and updates both original messages", async () => {
  const f = fixture();
  await f.command("UCREATOR", "task Approval assign <@UALICE> <@UBOB>");
  assert(f.task().editPerms?.join() === "UCREATOR");
  assert((await f.assignment("UALICE", ASSIGNMENT_ACCEPT)).ok);
  const accepted = f.updates.findLast((post) => post.channel === "DUALICE")!;
  assert(
    accepted.text.includes("Accepted") &&
      !JSON.stringify(accepted.blocks).includes(ASSIGNMENT_ACCEPT),
  );
  const before = f.posts.length;
  await f.command("UALICE", `${f.task().number} complete`);
  const requests = f.posts.slice(before);
  assert(
    requests.length === 2 &&
      requests.every((post) => !post.text.includes(`#${f.task().number}`)),
    JSON.stringify(requests),
  );
  assert(requests.filter((post) => post.channel === "DUCREATOR").length === 1);
  assert(requests.every((post) => post.channel !== "DUBOB"));
  await f.command("UALICE", `${f.task().number} complete`);
  assert(
    f.posts.length === before + 2,
    "A repeated request must reuse its confirmation and approver message",
  );
  const count = f.posts.length;
  assert((await f.participation("UCREATOR", REQUEST_APPROVE)).ok);
  assert(
    f.task().completed && f.posts.length === count,
    "Approval updates original messages only",
  );
  for (const post of requests) {
    assert(
      f.updates.some((update) =>
        update.ts === post.ts && update.text.includes("approved")
      ),
    );
  }
});

Deno.test("collaboration rejection updates both messages, keeps its reason, and posts no duplicate", async () => {
  const f = fixture();
  await f.command("UCREATOR", "task Collaboration assign me");
  await f.command("UCREATOR", `${f.task().number} collab <@UALICE>`);
  const count = f.posts.length;
  const result = await f.participation("UALICE", COLLAB_REJECT, "Busy <today>");
  assert(result.ok, JSON.stringify(result));
  assert(
    f.posts.length === count &&
      f.task().participation!.collaborators.UALICE.status === "rejected",
  );
  assert(
    f.updates.some((post) =>
      post.channel === "DUCREATOR" && post.text.includes("Busy &lt;today&gt;")
    ),
  );
  assert(
    f.updates.some((post) =>
      post.channel === "DUALICE" && post.text.includes("rejected")
    ),
  );
});

Deno.test("both assignee rejections produce a thread notice, and ls preserves the returned invitation", async () => {
  const f = fixture();
  await f.command("UCREATOR", "task Bounce assign <@UALICE> <@UBOB>");
  for (const user of ["UALICE", "UBOB"]) {
    const count = f.posts.length;
    const response = await f.assignment(user, ASSIGNMENT_REJECT);
    assert(response.ok, JSON.stringify(response));
    assert(
      f.posts.slice(count).some((post) =>
        post.channel === "DUCREATOR" && post.thread_ts &&
        post.text.includes(`<@${user}>`) && post.text.includes("rejected")
      ),
      user,
    );
  }
  assert(f.task().assignees.join() === "UCREATOR");
  const returned = f.posts.findLast((post) =>
    post.channel === "DUCREATOR" &&
    JSON.stringify(post.blocks ?? []).includes(ASSIGNMENT_ACCEPT)
  )!;
  const listed = await f.command("UCREATOR", "ls", returned.ts);
  assert("outputs" in listed);
  assert((await f.assignment("UCREATOR", ASSIGNMENT_ACCEPT)).ok);
  assert(f.task().assignmentTree?.acceptedBy === "UCREATOR");
});

Deno.test("deletion updates older cards and assignment messages with the actor, despite context storage failure", async () => {
  const f = fixture();
  await f.command("UCREATOR", "task Remove assign <@UALICE>");
  const originals = [...f.posts];
  f.setFailContext();
  const result = await f.command("UCREATOR", `${f.task().number} delete`);
  assert("outputs" in result, JSON.stringify(result));
  assert(f.task().deleted && f.task().deletedBy === "UCREATOR");
  for (const post of originals) {
    assert(
      f.updates.some((update) =>
        update.ts === post.ts && update.text.includes("Deleted by <@UCREATOR>") &&
        !JSON.stringify(update.blocks).includes(ASSIGNMENT_ACCEPT)
      ),
      post.ts,
    );
  }
});

Deno.test("a stale read-only DM is reopened and its reply is sent without an invalid cross-DM thread", async () => {
  const f = fixture();
  f.setRefuseDm();
  const result = await f.command("UCREATOR", "task Recovery", "1.1", "DOLD");
  assert("outputs" in result, JSON.stringify(result));
  assert(f.posts.at(-1)!.channel === "DUCREATOR" && !f.posts.at(-1)!.thread_ts);
});

Deno.test("space replaces clear, reopen aliases incomplete, and rejection notes parse", () => {
  assert(
    parseTaskCommand("space").kind === "space" &&
      parseTaskCommand("clear").kind === "unknown",
  );
  for (const text of ["reopen", "123 reopen", "edit reopen"]) {
    const parsed = parseTaskCommand(text);
    assert(
      parsed.kind === "update" &&
        (parsed.patch.completed ?? parsed.patch.set?.completed) === false,
    );
  }
  const rejection = parseTaskCommand("deny reopen More testing needed");
  assert(
    rejection.kind === "approval-response" && rejection.kindOfAction === "incomplete" &&
      rejection.note === "More testing needed",
  );
  const rich = (elements: unknown[]) => ({
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements }],
  });
  assert(recipientMentions(rich([{ type: "text", text: "<@UALICE>" }])) === undefined);
  assert(
    recipientMentions(
      rich([{ type: "user", user_id: "UALICE" }, { type: "text", text: ", " }, {
        type: "usergroup",
        usergroup_id: "STEAM",
      }]),
    ) === "<@UALICE> <!subteam^STEAM>",
  );
});

Deno.test("reopening and deletion denial reasons update requester confirmations, and space preserves tasks", async () => {
  const f = fixture();
  await f.command("UCREATOR", "task Decision assign me");
  await f.command("UCREATOR", `${f.task().number} complete`);
  for (const action of ["reopen", "delete"]) {
    await f.command("UALICE", `${f.task().number} ${action}`);
    const count = f.posts.length;
    await f.command("UCREATOR", `${f.task().number} deny ${action} More testing needed`);
    assert(f.posts.length === count, "Deny updates the original approval message");
    assert(f.task().completed && !f.task().deleted);
    assert(
      f.updates.some((post) =>
        post.channel === "DUALICE" && post.text.includes("request rejected") &&
        post.text.includes("More testing needed")
      ),
    );
  }
  await f.command("UCREATOR", "space");
  assert(f.posts.at(-1)!.text.split("\n").length > 40 && !f.posts.at(-1)!.thread_ts);
  assert(f.task().name === "Decision" && !f.task().deleted);
});

Deno.test("context writes retry temporary failures and empty selections round trip without stale task IDs", async () => {
  let attempts = 0;
  let item: Record<string, unknown> = {};
  const contexts = new SlackDmContexts({
    apps: {
      datastore: {
        put: (args) => {
          if (++attempts === 1) {
            return Promise.resolve({ ok: false, error: "service_unavailable" });
          }
          item = args.item;
          return Promise.resolve({ ok: true });
        },
        get: () => Promise.resolve({ ok: true, item }),
      },
    },
  });
  await contexts.save("DTEST", "latest", "UALICE", ["DTEST:1.1"]);
  assert(
    attempts === 2 &&
      (await contexts.get("DTEST", "latest", "UALICE")).join() === "DTEST:1.1",
  );
  await contexts.save("DTEST", "latest", "UALICE", []);
  assert((await contexts.get("DTEST", "latest", "UALICE")).length === 0);
});

Deno.test("rejection forms close after durable handoff, retain notes, and reject another user's submission", async () => {
  const { participationViewSubmissionHandler } = await import(
    "../delebot/slack/participation_messages.ts"
  );
  const action = { userId: "UALICE", actionId: COLLAB_REJECT, channelId: "DUALICE" };
  const submission = {
    body: { user: { id: "UALICE" } },
    view: {
      private_metadata: JSON.stringify({
        action,
        workerUrl: "https://hooks.slack.com/triggers/TEST",
      }),
      state: { values: { rejection_note: { note: { value: "Other priorities" } } } },
    },
  } as unknown as Parameters<typeof participationViewSubmissionHandler>[0];
  let payload: unknown;
  const dispatch = (_url: string, value: unknown) => {
    payload = value;
    return Promise.resolve();
  };
  const response = await participationViewSubmissionHandler(submission, dispatch);
  assert(response.response_action === "clear");
  assert(JSON.stringify(payload).includes("Other priorities"));
  payload = undefined;
  submission.body.user.id = "UBOB";
  assert(
    (await participationViewSubmissionHandler(submission, dispatch)).response_action ===
      "errors",
  );
  assert(payload === undefined);
});
