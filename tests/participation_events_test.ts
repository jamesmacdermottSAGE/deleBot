import {
  handleMessage,
  type MessageClient,
  type MessageEvent,
} from "../delebot/slack/events.ts";
import {
  type MessageBlocks,
  type NotificationBatch,
  type NotificationClient,
  type NotificationStore,
} from "../delebot/slack/notifications.ts";
import type { DmContexts } from "../delebot/slack/dm_context.ts";
import type { TeamDirectory } from "../delebot/slack/teams.ts";
import { assert, MemoryTaskRepository } from "./task_fixtures.ts";

function fixture() {
  const repository = new MemoryTaskRepository();
  const contexts = new Map<string, string[]>();
  const dmContexts: DmContexts = {
    get: (channel, thread, user) =>
      Promise.resolve(contexts.get(`${channel}:${thread}:${user}`) ?? []),
    save: (channel, thread, user, ids) => {
      contexts.set(`${channel}:${thread}:${user}`, [...ids]);
      return Promise.resolve();
    },
  };
  const posts: Array<
    {
      channel: string;
      text: string;
      ts: string;
      thread_ts?: string;
      blocks?: MessageBlocks;
    }
  > = [];
  const updates: Array<
    { channel: string; ts: string; text: string; blocks: MessageBlocks }
  > = [];
  const batches = new Map<string, NotificationBatch>();
  const store: NotificationStore = {
    get: (id) => Promise.resolve(structuredClone(batches.get(id) ?? null)),
    save: (batch) => {
      batches.set(batch.id, structuredClone(batch));
      return Promise.resolve();
    },
  };
  const client: MessageClient & NotificationClient & {
    chat: MessageClient["chat"] & NotificationClient["chat"] & {
      update(
        args: { channel: string; ts: string; text: string; blocks: MessageBlocks },
      ): Promise<{ ok: boolean }>;
    };
  } = {
    auth: { test: () => Promise.resolve({ ok: true, user_id: "UBOT" }) },
    users: { info: () => Promise.resolve({ ok: true, user: { is_bot: false } }) },
    conversations: {
      info: () =>
        Promise.resolve({ ok: true, channel: { context_team_id: "TWORKSPACE" } }),
      open: ({ users }) => Promise.resolve({ ok: true, channel: { id: `D${users}` } }),
    },
    chat: {
      postMessage: (args) => {
        const ts = `100.${posts.length + 1}`;
        posts.push({ ...args, ts });
        return Promise.resolve({ ok: true, ts });
      },
      postEphemeral: () => Promise.resolve({ ok: true }),
      update: (args) => {
        updates.push(args);
        return Promise.resolve({ ok: true });
      },
      delete: () => Promise.resolve({ ok: true }),
    },
    usergroups: { users: { list: () => Promise.resolve({ ok: true, users: [] }) } },
    functions: { completeSuccess: () => Promise.resolve({ ok: true }) },
  };
  const directory: TeamDirectory = {
    load: (userId) =>
      Promise.resolve({
        access: { userId, teamIds: [] },
        knownTeamIds: [],
        teamNames: {},
        teamMembers: {},
      }),
  };
  let counter = 0;
  async function command(userId: string, text: string, thread?: string) {
    const event: MessageEvent = {
      channel_id: `D${userId}`,
      channel_type: "dm",
      user_id: userId,
      message_ts: `10.${++counter}`,
      text,
      ...(thread ? { thread_ts: thread } : {}),
    };
    const result = await handleMessage(
      event,
      client,
      repository,
      directory,
      {
        client,
        store,
        context: {
          executionId: `FX${counter}`,
          loadAccess: (_task, recipient) =>
            Promise.resolve({ userId: recipient, teamIds: [] }),
          rememberTask: async (channel, ts, user, taskId) => {
            await dmContexts.save(channel, ts, user, [taskId], "invitation");
          },
        },
      },
      undefined,
      dmContexts,
    );
    assert("outputs" in result && !result.outputs.ignored, JSON.stringify(result));
    return event;
  }
  const invitation = (userId: string, action: string) =>
    posts.filter((post) =>
      post.channel === `D${userId}` && JSON.stringify(post.blocks).includes(action)
    ).at(-1)!;
  const task = () => [...repository.rows.values()][0];
  return { repository, command, posts, updates, invitation, task };
}

Deno.test("DM task messages support accepted-owner collaboration and ls collab without changing assignment", async () => {
  const f = fixture();
  await f.command("UCREATOR", "task Review assign <@UALICE> access <@UMANAGER>");
  const ownerInvite = f.invitation("UALICE", "delebot_assignment_accept");
  assert(ownerInvite);
  await f.command("UALICE", "accept", ownerInvite.ts);
  assert(
    f.task().assignees.join() === "UALICE" &&
      f.task().assignmentResponses?.UALICE.status === "accepted",
  );
  await f.command("UALICE", "collab <@UBOB>", ownerInvite.ts);
  const collab = f.invitation("UBOB", "delebot_collab_accept");
  assert(collab && collab.text.includes("invited you to collaborate"));
  await f.command("UBOB", "collab accept", collab.ts);
  assert(f.task().participation?.collaborators.UBOB.status === "accepted");
  assert(f.task().assignees.join() === "UALICE");
  const before = f.posts.length;
  await f.command("UBOB", "ls collab");
  assert(
    f.posts.slice(before).some((post) =>
      post.text.includes("Review") && post.text.includes("Collaborators")
    ),
  );
  await f.command("UOTHER", "ls collab");
  assert(f.posts.at(-1)!.text === "No tasks found.");
});

Deno.test("unauthorized done and delete send requests to access holders, who approve through task threads", async () => {
  for (const kind of ["complete", "delete"] as const) {
    const f = fixture();
    await f.command("UCREATOR", "task Approval assign <@UALICE> access <@UMANAGER>");
    const number = f.task().number;
    await f.command("UBOB", `${number} ${kind === "complete" ? "done" : "delete"}`);
    assert(!f.task().completed && !f.task().deleted);
    const request = Object.values(f.task().participation?.requests ?? {})[0];
    assert(request?.kind === kind && request.status === "pending");
    const managerInvite = f.invitation("UMANAGER", "delebot_request_approve");
    assert(managerInvite && managerInvite.text.includes("<@UBOB> requests"));
    await f.command("UOTHER", `${number} approve ${kind}`);
    assert(!f.task().completed && !f.task().deleted);
    await f.command("UMANAGER", `approve ${kind}`, managerInvite.ts);
    if (kind === "complete") {
      assert(f.task().completed && f.task().status === "completed");
    } else assert(f.task().deleted);
  }
});

Deno.test("access people added in a task thread can subsequently complete that task", async () => {
  const f = fixture();
  const created = await f.command(
    "UCREATOR",
    'task "Access" assign <@UALICE> access <@UMANAGER>',
  );
  await f.command("UCREATOR", "access <@UBOB>", created.message_ts);
  assert(
    f.task().editPerms?.includes("UBOB") && f.task().editPerms?.includes("UMANAGER"),
  );
  await f.command("UBOB", `${f.task().number} done`);
  assert(
    f.task().completed && !Object.values(f.task().participation?.requests ?? {}).length,
  );
});
