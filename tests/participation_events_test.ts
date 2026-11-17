import {
  handleParticipationAction,
  REQUEST_REJECT,
} from "../delebot/slack/participation_messages.ts";
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
  async function command(
    userId: string,
    text: string,
    thread?: string,
    channelId = `D${userId}`,
  ) {
    const event: MessageEvent = {
      channel_id: channelId,
      channel_type: channelId.startsWith("D") ? "dm" : "public",
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
      post.channel === `D${userId}` && JSON.stringify(post.blocks ?? []).includes(action)
    ).at(-1)!;
  const task = () => [...repository.rows.values()][0];
  return {
    repository,
    command,
    posts,
    updates,
    invitation,
    task,
    client,
    dmContexts,
    store,
  };
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

Deno.test("access me adds the requester, edit access me replaces Access, and both return short named confirmations", async () => {
  const f = fixture();
  const created = await f.command("UCREATOR", "task SelfAccess");
  await f.command("UCREATOR", "access me", created.message_ts);
  assert(f.task().editPerms?.join() === "UCREATOR");
  const reply = f.posts.at(-1)!;
  assert(
    reply.text.includes(`SelfAccess`) &&
      reply.text.includes("No fields changed") && reply.text.length < 250,
  );
  await f.command("UCREATOR", "access <@UMANAGER>", reply.ts);
  assert(f.task().editPerms?.includes("UMANAGER"));
  await f.command("UCREATOR", "edit access me", reply.ts);
  assert(f.task().editPerms?.join() === "UCREATOR");
  await f.command("UCREATOR", "access", reply.ts);
  assert(
    f.posts.at(-1)!.text.length < 500 &&
      f.posts.at(-1)!.text.includes(`SelfAccess`),
  );
  const errorReply = f.posts.at(-1)!;
  await f.command("UCREATOR", "assign <@UBOB>", errorReply.ts);
  assert(f.task().assignees.join() === "UBOB");
});

Deno.test("access me cannot grant a pending assignee editing privileges", async () => {
  const f = fixture();
  await f.command("UCREATOR", "task Restricted assign <@UALICE> access <@UMANAGER>");
  const invite = f.invitation("UALICE", "delebot_assignment_accept");
  await f.command("UALICE", "access me", invite.ts);
  assert(f.task().editPerms?.join() === "UMANAGER");
  assert(
    f.posts.at(-1)!.text.includes("You need Access") &&
      f.posts.at(-1)!.text.includes(`Restricted`),
  );
});

Deno.test("request rejections update requester confirmations and remain usable as task threads", async () => {
  for (const kind of ["complete", "delete"] as const) {
    const f = fixture();
    const created = await f.command("UCREATOR", "task Approval access <@UMANAGER>");
    await f.command(
      "UCREATOR",
      kind === "complete" ? "done" : "delete",
      created.message_ts,
    );
    const confirmation = f.posts.at(-1)!;
    const request = Object.values(f.task().participation!.requests)[0];
    assert(
      request.confirmations?.some((message) => message.messageTs === confirmation.ts),
    );
    assert(
      confirmation.text.includes(`Approval`) &&
        !confirmation.text.includes("*Assignees:*"),
    );
    const managerInvite = f.invitation("UMANAGER", "delebot_request_approve");
    await f.command("UMANAGER", `deny ${kind}`, managerInvite.ts);
    const rejection = f.updates.filter((update) => update.ts === confirmation.ts).at(-1)!;
    assert(
      rejection.text.includes(
        `${kind === "complete" ? "Completion" : "Deletion"} request rejected`,
      ) && rejection.text.includes(`Approval`),
    );
    assert(
      f.updates.at(-1)!.text.includes("request rejected") &&
        f.posts.at(-1)!.text.includes(`Approval`),
    );
    assert(!f.task().deleted && !f.task().completed);
    const originalId = f.task().id;
    await f.command("UCREATOR", "task Other");
    await f.command("UCREATOR", "assign <@UBOB>", rejection.ts);
    assert(f.repository.rows.get(originalId)!.assignees.join() === "UBOB");
    assert(
      [...f.repository.rows.values()].find((task) => task.name === "Other")!.assignees
        .length === 0,
    );
  }
});

Deno.test("reject-request buttons update both named messages and preserve the requester's reply context", async () => {
  for (const kind of ["complete", "delete"] as const) {
    const f = fixture();
    await f.command("UCREATOR", "task ButtonDecision access <@UMANAGER>");
    await f.command(
      "UCREATOR",
      `${f.task().number} ${kind === "complete" ? "done" : "delete"}`,
    );
    const confirmation = f.posts.at(-1)!;
    const invite = f.invitation("UMANAGER", "delebot_request_approve");
    const delivery = Object.values(f.task().participation!.deliveryEvents).find((event) =>
      event.kind === "approval"
    )!;
    const result = await handleParticipationAction({
      actionId: REQUEST_REJECT,
      value: invite.blocks![1].elements[1].value,
      userId: "UMANAGER",
      channelId: invite.channel,
      messageTs: invite.ts,
      executionId: delivery.deliveries!.UMANAGER.executionId,
      actionTs: "25.1",
    }, {
      client: f.client,
      repository: f.repository,
      notificationStore: f.store,
      loadAccess: (_task, userId) => Promise.resolve({ userId, teamIds: [] }),
      rememberTask: (channel, ts, user, id) =>
        f.dmContexts.save(channel, ts, user, [id], "context"),
    });
    assert(result.ok, JSON.stringify(result));
    for (const ts of [confirmation.ts, invite.ts]) {
      const update = f.updates.filter((message) => message.ts === ts).at(-1)!;
      assert(
        update.text.includes(`ButtonDecision`) &&
          update.text.includes("request rejected"),
      );
    }
    await f.command("UCREATOR", "task Other");
    await f.command("UCREATOR", "assign <@UBOB>", confirmation.ts);
    assert(f.task().assignees.join() === "UBOB");
  }
});

Deno.test("task-related channel messages support replies from another authorized participant", async () => {
  const f = fixture();
  await f.command(
    "UCREATOR",
    "<@UBOT> task ChannelTask assign <@UALICE> access all",
    undefined,
    "CTEST",
  );
  const card = f.posts.filter((message) => message.channel === "CTEST").at(-1)!;
  await f.command("UALICE", "<@UBOT> accept", card.ts, "CTEST");
  assert(f.task().assignmentTree?.acceptedBy === "UALICE");
  const accepted = f.posts.filter((message) => message.channel === "CTEST").at(-1)!;
  assert(accepted.text.includes(`ChannelTask`));
  await f.command("UALICE", "<@UBOT> p 2", accepted.ts, "CTEST");
  assert(f.task().priority === 2);
  await f.command("UOTHER", "<@UBOT> p 3", accepted.ts, "CTEST");
  assert(
    f.task().priority === 3 && f.posts.at(-1)!.text.includes("Priority updated to 3"),
  );
});

Deno.test("private-channel task acknowledgements retain context without granting other viewers access", async () => {
  const f = fixture();
  await f.command(
    "UCREATOR",
    "<@UBOT> task Secret viewPerms <@UCREATOR>",
    undefined,
    "CPRIVATE",
  );
  const acknowledgement = f.posts.at(-1)!;
  assert(!acknowledgement.text.includes("Secret"));
  await f.command("UCREATOR", "<@UBOT> p 1", acknowledgement.ts, "CPRIVATE");
  assert(f.task().priority === 1);
  await f.command("UOTHER", "<@UBOT> p 3", acknowledgement.ts, "CPRIVATE");
  assert(f.task().priority === 1 && !f.posts.at(-1)!.text.includes("Secret"));
});

Deno.test("incomplete requests leave completion in place until an Access holder approves", async () => {
  const f = fixture();
  await f.command("UCREATOR", 'task "Reopen" access <@UMANAGER>');
  const number = f.task().number;
  await f.command("UMANAGER", `${number} complete`);
  assert(f.task().completed);
  await f.command("UBOB", `${number} incomplete`);
  const request = Object.values(f.task().participation!.requests)[0];
  assert(
    request.kind === "incomplete" && request.status === "pending" && f.task().completed,
  );
  const approval = f.invitation("UMANAGER", "delebot_request_approve");
  assert(approval.text.includes("reopening"));
  await f.command("UOTHER", `${number} approve incomplete`);
  assert(f.task().completed && request.status === "pending");
  await f.command("UMANAGER", "approve incomplete", approval.ts);
  assert(!f.task().completed && f.task().status === "open");
  assert(
    f.updates.some((update) => update.text.includes("✅ Reopening request approved")),
  );
});

Deno.test("an incomplete request rejection has an X and preserves completion", async () => {
  const f = fixture();
  await f.command("UCREATOR", 'task "Reopen" access <@UMANAGER>');
  const number = f.task().number;
  await f.command("UMANAGER", `${number} complete`);
  await f.command("UBOB", `${number} edit incomplete`);
  const approval = f.invitation("UMANAGER", "delebot_request_approve");
  await f.command("UMANAGER", "deny incomplete", approval.ts);
  assert(f.task().completed);
  assert(
    f.updates.some((update) => update.text.includes("❌ Reopening request rejected")),
  );
});

Deno.test("ls stays on the task of the current thread and complete selects completed tasks", async () => {
  const f = fixture();
  const created = await f.command("UCREATOR", "task First");
  const first = f.task();
  await f.command("UCREATOR", "task Second");
  const before = f.posts.length;
  await f.command("UCREATOR", "ls", created.message_ts);
  const listed = f.posts.slice(before);
  assert(
    listed.length === 1 && listed[0].text.includes("First") &&
      !listed[0].text.includes("Second"),
  );
  assert(listed[0].thread_ts === created.message_ts);
  await f.command("UCREATOR", `${first.number} complete`);
  await f.command("UCREATOR", "ls complete", created.message_ts);
  assert(
    f.posts.at(-1)!.text.includes("First") &&
      f.posts.at(-1)!.text.includes("*Completed:* ✅"),
  );
  await f.command("UCREATOR", "ls");
  assert(
    f.posts.at(-1)!.text.includes("Second") && !f.posts.at(-1)!.text.includes("First"),
  );
  await f.command("UCREATOR", "ls complete");
  assert(
    f.posts.at(-1)!.text.includes("First") && !f.posts.at(-1)!.text.includes("Second"),
  );
});

Deno.test("the inviter's collaboration request updates for acceptance and rejection", async () => {
  const f = fixture();
  await f.command("UCREATOR", "task Together assign <@UALICE>");
  const ownerInvite = f.invitation("UALICE", "delebot_assignment_accept");
  await f.command("UALICE", "accept", ownerInvite.ts);
  await f.command("UALICE", "collab <@UBOB> <@UCAROL>", ownerInvite.ts);
  const confirmation = f.posts.filter((post) => post.channel === "DUALICE").at(-1)!;
  const bob = f.invitation("UBOB", "delebot_collab_accept");
  const carol = f.invitation("UCAROL", "delebot_collab_reject");
  await f.command("UBOB", "collab accept", bob.ts);
  await f.command("UCAROL", "collab reject", carol.ts);
  const updated = f.updates.filter((entry) =>
    entry.channel === confirmation.channel && entry.ts === confirmation.ts
  ).at(-1)!;
  assert(
    updated.text.includes("<@UBOB> ✅ accepted") &&
      updated.text.includes("<@UCAROL> ❌ rejected"),
  );
  assert(
    f.updates.some((entry) =>
      entry.ts === bob.ts && entry.text.includes("Collaboration accepted") &&
      entry.blocks.length === 0
    ),
  );
});

Deno.test("assigning an already assigned person gives a distinct response and keeps existing invitations", async () => {
  const f = fixture();
  const created = await f.command("UCREATOR", "task Assigned assign <@UALICE>");
  const invitation = f.invitation("UALICE", "delebot_assignment_accept");
  await f.command("UCREATOR", "assign <@UALICE>", created.message_ts);
  assert(f.posts.at(-1)!.text.includes("Already assigned to these recipients"));
  assert(f.posts.filter((post) => post.channel === "DUALICE").length === 1);
  assert(f.invitation("UALICE", "delebot_assignment_accept").ts === invitation.ts);
});
