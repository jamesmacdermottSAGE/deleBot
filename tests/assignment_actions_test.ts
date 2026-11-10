import {
  type AssignmentAction,
  type AssignmentClient,
  type AssignmentDependencies,
  assignmentViewSubmissionHandler,
  handleAssignmentAction,
  handleAssignmentSubmission,
} from "../delebot/slack/actions.ts";
import {
  ASSIGNMENT_ACCEPT,
  ASSIGNMENT_DELEGATE,
  ASSIGNMENT_REJECT,
  invitationValue,
  type NotificationBatch,
  type NotificationStore,
  notifyTaskAssignments,
  SlackNotificationStore,
} from "../delebot/slack/notifications.ts";
import type { TaskInput } from "../delebot/tasks/models.ts";
import { SlackTaskRepository } from "../delebot/tasks/repository.ts";
import { createTask } from "../delebot/tasks/service.ts";
import { assert, MemoryTaskRepository } from "./task_fixtures.ts";

function mentions(...ids: string[]) {
  return {
    type: "rich_text",
    elements: [{
      type: "rich_text_section",
      elements: ids.map((id) =>
        id.startsWith("S")
          ? { type: "usergroup", usergroup_id: id }
          : { type: "user", user_id: id }
      ),
    }],
  };
}

async function submitRecipients(
  f: Awaited<ReturnType<typeof fixture>>,
  recipients: unknown,
  note = "",
) {
  assert(
    (await handleAssignmentAction(f.action(ASSIGNMENT_DELEGATE), f.dependencies)).ok,
  );
  return await handleAssignmentSubmission({
    privateMetadata:
      (f.views.at(-1)!.view as { private_metadata: string }).private_metadata,
    userId: "UALICE",
    viewId: `V${f.views.length}`,
    executionId: "FXORIGIN",
    recipients,
    note,
  }, f.dependencies);
}

async function fixture(patch: Partial<TaskInput> = {}) {
  const repository = new MemoryTaskRepository();
  const created = await createTask(
    { name: "Review <PRs>", assignees: ["UALICE"], ...patch },
    { channelId: "CTEST", messageTs: "1793690000.000001", userId: "UCREATOR" },
    repository,
    { userId: "UCREATOR", teamIds: [] },
  );
  const rows = new Map<string, NotificationBatch>();
  const store: NotificationStore = {
    get: (id) => Promise.resolve(structuredClone(rows.get(id) ?? null)),
    save: (batch) => {
      rows.set(batch.id, structuredClone(batch));
      return Promise.resolve();
    },
  };
  const posts: Array<Parameters<AssignmentClient["chat"]["postMessage"]>[0]> = [];
  const updates: Array<Parameters<AssignmentClient["chat"]["update"]>[0]> = [];
  const deleted: Array<{ channel: string; ts: string }> = [];
  const views: Array<Parameters<AssignmentClient["views"]["open"]>[0]> = [];
  const completed: string[] = [];
  const groups = new Map<string, string[]>([["SFRONTEND", ["UALICE", "UBOB"]], [
    "SBACKEND",
    ["UCAROL"],
  ]]);
  const client: AssignmentClient = {
    conversations: {
      open: ({ users }) => Promise.resolve({ ok: true, channel: { id: `D${users}` } }),
    },
    chat: {
      postMessage: (args) => {
        posts.push(args);
        return Promise.resolve({ ok: true, ts: `10.${posts.length}` });
      },
      update: (args) => {
        updates.push(args);
        return Promise.resolve({ ok: true });
      },
      delete: (args) => {
        deleted.push(args);
        return Promise.resolve({ ok: true });
      },
    },
    views: {
      open: (args) => {
        views.push(args);
        return Promise.resolve({ ok: true, view: { id: `V${views.length}` } });
      },
    },
    usergroups: {
      list: () =>
        Promise.resolve({
          ok: true,
          usergroups: [...groups].map(([id]) => ({
            id,
            handle: id === "SFRONTEND" ? "frontend" : "backend",
            date_delete: 0,
            is_section: id === "SBACKEND",
          })),
        }),
      users: {
        list: ({ usergroup }) =>
          Promise.resolve(
            groups.has(usergroup)
              ? { ok: true, users: groups.get(usergroup) }
              : { ok: false, error: "usergroup_not_found" },
          ),
      },
    },
    functions: {
      completeSuccess: ({ function_execution_id }) => {
        completed.push(function_execution_id);
        return Promise.resolve({ ok: true });
      },
    },
  };
  const dependencies: AssignmentDependencies = {
    client,
    repository,
    store,
    loadAccess: (_task, userId) =>
      Promise.resolve({
        userId,
        teamIds: [...groups].filter(([, members]) => members.includes(userId)).map((
          [id],
        ) => id),
      }),
  };
  const result = await notifyTaskAssignments(created.task, "TWORKSPACE", client, store, {
    executionId: "FXORIGIN",
    loadAccess: dependencies.loadAccess,
  });
  function invitation(userId = "UALICE") {
    const batch = [...rows.values()].reverse().find((row) => row.invitations?.[userId])!;
    assert(batch);
    return { batch, invitation: batch.invitations![userId] };
  }
  let actionCount = 0;
  function action(actionId: string, userId = "UALICE"): AssignmentAction {
    const bound = invitation(userId);
    return {
      actionId,
      value: invitationValue(bound.batch, bound.invitation),
      userId,
      channelId: bound.invitation.channelId!,
      messageTs: bound.invitation.messageTs!,
      executionId: bound.invitation.executionId,
      interactivityPointer: "pointer",
      actionTs: `1793690010.${String(++actionCount).padStart(6, "0")}`,
    };
  }
  async function delegate(users: string[], teamText = "", userId = "UALICE") {
    const opened = await handleAssignmentAction(
      action(ASSIGNMENT_DELEGATE, userId),
      dependencies,
    );
    assert(opened.ok);
    return await handleAssignmentSubmission({
      privateMetadata:
        (views.at(-1)!.view as { private_metadata: string }).private_metadata,
      userId,
      viewId: `V${views.length}`,
      executionId: "FXORIGIN",
      selectedUsers: users,
      teamText,
    }, dependencies);
  }
  return {
    task: created.task,
    result,
    rows,
    client,
    repository,
    store,
    dependencies,
    groups,
    posts,
    updates,
    deleted,
    views,
    completed,
    invitation,
    action,
    delegate,
  };
}

Deno.test("assignment DMs persist interactive controls and their exact recipient/message binding", async () => {
  const f = await fixture();
  assert(f.result.interactive && f.result.failed.length === 0 && f.posts.length === 1);
  const { batch, invitation } = f.invitation();
  assert(batch.workspaceId === "TWORKSPACE" && batch.sourceChannelId === "CTEST");
  assert(invitation.channelId === "DUALICE" && invitation.messageTs === "10.1");
  assert(invitation.executionId === "FXORIGIN" && invitation.status === "pending");
  const blocks = JSON.stringify(f.posts[0].blocks);
  assert(
    blocks.includes(ASSIGNMENT_ACCEPT) && blocks.includes(ASSIGNMENT_REJECT) &&
      blocks.includes(ASSIGNMENT_DELEGATE),
  );
  assert(
    blocks.includes("Accept") && blocks.includes("Reject") && blocks.includes("Delegate"),
  );
  assert(!JSON.stringify(batch).includes("Review"));
});

Deno.test("accept updates the original DM with task identity and completes only once", async () => {
  const f = await fixture();
  const refreshed: string[] = [];
  f.dependencies.displays = {
    track: () => Promise.resolve(),
    refresh: (task) => {
      refreshed.push(task.assignmentResponses?.UALICE?.status ?? "missing");
      return Promise.resolve(0);
    },
  };
  const action = f.action(ASSIGNMENT_ACCEPT);
  assert((await handleAssignmentAction(action, f.dependencies)).ok);
  assert(
    refreshed[0] === "accepted",
    "Acceptance must refresh earlier task cards with the saved response",
  );
  assert(f.invitation().invitation.status === "accepted");
  assert(
    f.updates.length === 1 && f.updates[0].channel === "DUALICE" &&
      f.updates[0].ts === "10.1",
  );
  assert(
    f.updates[0].text.includes("Accepted") &&
      f.updates[0].text.includes(`#${f.task.number}`),
  );
  assert(
    f.updates[0].text.includes("Review &lt;PRs&gt;") && f.updates[0].blocks.length === 0,
  );
  assert(f.repository.rows.get(f.task.id)!.assignees.join() === "UALICE");
  const writes = f.repository.writes;
  assert((await handleAssignmentAction(action, f.dependencies)).ok);
  assert(f.repository.writes === writes && f.completed.join() === "FXORIGIN");
});

Deno.test("reject returns a direct assignment to its creator with a fresh invitation", async () => {
  const f = await fixture();
  const action = f.action(ASSIGNMENT_REJECT);
  assert((await handleAssignmentAction(action, f.dependencies)).ok);
  assert(f.invitation().invitation.status === "rejected");
  assert(f.invitation().invitation.messageRemoved);
  assert(f.repository.rows.get(f.task.id)!.assignees.join() === "UCREATOR");
  assert(f.invitation("UCREATOR").invitation.status === "pending");
  assert(f.posts.length === 2 && f.posts[1].channel === "DUCREATOR");
  assert(
    f.posts[1].text.includes("returned to you") && f.posts[1].text.includes("<@UALICE>"),
  );
  assert(JSON.stringify(f.posts[1].blocks).includes("Delegate"));
  assert(
    f.deleted.length === 1 && f.deleted[0].channel === "DUALICE" &&
      f.deleted[0].ts === "10.1",
  );
  assert((await handleAssignmentAction(action, f.dependencies)).ok);
  assert(f.deleted.length === 1 && f.completed.length === 0 && f.posts.length === 2);
  assert(
    (await handleAssignmentAction(
      f.action(ASSIGNMENT_ACCEPT, "UCREATOR"),
      f.dependencies,
    )).ok,
  );
  assert(Number(f.completed.length) === 1);
});

Deno.test("rejecting a team invitation keeps the team assignment and other invitations active", async () => {
  const f = await fixture({ assignees: ["SFRONTEND"] });
  assert(f.posts.length === 2);
  assert((await handleAssignmentAction(f.action(ASSIGNMENT_REJECT), f.dependencies)).ok);
  assert(f.repository.rows.get(f.task.id)!.assignees.join() === "SFRONTEND,UCREATOR");
  assert(f.invitation("UCREATOR").invitation.status === "pending");
  assert(
    f.invitation("UBOB").invitation.status === "pending" && f.completed.length === 0,
  );
  assert(
    (await handleAssignmentAction(f.action(ASSIGNMENT_ACCEPT, "UBOB"), f.dependencies))
      .ok,
  );
  assert(f.completed.length === 0);
  assert(f.repository.rows.get(f.task.id)!.assignees.join() === "UCREATOR,UBOB");
  assert(f.repository.rows.get(f.task.id)!.teams.length === 0);
  assert(
    (await handleAssignmentAction(
      f.action(ASSIGNMENT_ACCEPT, "UCREATOR"),
      f.dependencies,
    )).ok,
  );
  assert(f.completed.join() === "FXORIGIN");
});

Deno.test("accepting a team invitation claims the task and cancels the other members' controls", async () => {
  const f = await fixture({ assignees: ["SFRONTEND"] });
  const otherAction = f.action(ASSIGNMENT_ACCEPT, "UBOB");
  const action = f.action(ASSIGNMENT_ACCEPT);
  assert((await handleAssignmentAction(action, f.dependencies)).ok);
  const saved = f.repository.rows.get(f.task.id)!;
  assert(saved.assignees.join() === "UALICE" && saved.teams.length === 0);
  assert(saved.assignmentResponses?.UALICE.status === "accepted");
  assert(f.invitation().invitation.status === "accepted");
  assert(f.invitation("UBOB").invitation.status === "cancelled");
  assert(f.invitation("UBOB").invitation.messageRemoved);
  assert(f.deleted.some((item) => item.channel === "DUBOB"));
  assert(f.completed.join() === "FXORIGIN");
  const writes = f.repository.writes;
  assert((await handleAssignmentAction(action, f.dependencies)).ok);
  await handleAssignmentAction(otherAction, f.dependencies);
  assert(f.repository.writes === writes && f.posts.length === 2);
  assert(f.repository.rows.get(f.task.id)!.assignees.join() === "UALICE");
  assert(Number(f.completed.length) === 1);
});

Deno.test("delegating a team invitation removes the squad and invites only the new assignee", async () => {
  const f = await fixture({ assignees: ["SFRONTEND"] });
  assert((await f.delegate(["UCAROL"])).ok);
  const saved = f.repository.rows.get(f.task.id)!;
  assert(saved.assignees.join() === "UCAROL" && saved.teams.length === 0);
  assert(saved.assignmentResponses?.UALICE.status === "delegated");
  assert(f.invitation().invitation.status === "delegated");
  assert(f.invitation("UBOB").invitation.status === "cancelled");
  assert(f.invitation("UBOB").invitation.messageRemoved);
  assert(f.posts.length === 3 && f.posts[2].channel === "DUCAROL");
  assert(JSON.stringify(f.posts[2].blocks).includes(ASSIGNMENT_ACCEPT));
  assert(f.completed.length === 0);
  assert(
    (await handleAssignmentAction(f.action(ASSIGNMENT_ACCEPT, "UCAROL"), f.dependencies))
      .ok,
  );
  assert(f.completed.join() === "FXORIGIN");
});

Deno.test("delegation updates its original DM and gives the new assignee an actionable DM", async () => {
  const f = await fixture();
  const result = await f.delegate(["UBOB"]);
  assert(result.ok && result.interactive);
  assert(f.repository.rows.get(f.task.id)!.assignees.join() === "UBOB");
  assert(f.invitation().invitation.status === "delegated");
  assert(
    f.updates[0].text.includes("Delegated to <@UBOB>") &&
      f.updates[0].text.includes(`#${f.task.number}`),
  );
  assert(
    f.posts.length === 2 && f.posts[1].channel === "DUBOB" &&
      JSON.stringify(f.posts[1].blocks).includes("Accept"),
  );
  assert(
    f.completed.length === 0,
    "The delegated invitation must keep the function active.",
  );
  assert(
    (await handleAssignmentAction(f.action(ASSIGNMENT_ACCEPT, "UBOB"), f.dependencies))
      .ok,
  );
  assert(f.completed.join() === "FXORIGIN");
});

Deno.test("delegation supports verified Slack team handles and notifies their members", async () => {
  const f = await fixture();
  assert((await f.delegate([], "@backend")).ok);
  assert(f.repository.rows.get(f.task.id)!.assignees.join() === "SBACKEND");
  assert(f.posts.length === 2 && f.posts[1].channel === "DUCAROL");
  assert(f.updates[0].text.includes("Delegated to <!subteam^SBACKEND>"));
});

Deno.test("delegation cannot hand a task to someone without viewing permission", async () => {
  const f = await fixture({ viewPerms: ["UALICE"], editPerms: ["UALICE"] });
  const writes = f.repository.writes;
  const result = await f.delegate(["UBOB"]);
  assert(!result.ok && result.error?.includes("viewing permission first"));
  assert(f.repository.writes === writes && f.posts.length === 1);
  assert(
    f.invitation().invitation.status === "pending" && !f.invitation().invitation.decision,
  );
});

for (const assignees of [["UALICE"], ["SFRONTEND"]]) {
  Deno.test(`rejected delegation from ${assignees[0]} returns to the delegator, who can delegate again`, async () => {
    const f = await fixture({ assignees });
    assert((await f.delegate(["UCAROL"])).ok);
    const originalInvitation = f.invitation().invitation.id;
    assert(
      (await handleAssignmentAction(
        f.action(ASSIGNMENT_REJECT, "UCAROL"),
        f.dependencies,
      )).ok,
    );
    const returned = f.repository.rows.get(f.task.id)!;
    assert(returned.assignees.join() === "UALICE" && returned.teams.length === 0);
    assert(returned.assignmentResponses?.UCAROL.status === "rejected");
    assert(returned.assignmentResponses?.UALICE.status === "pending");
    assert(returned.assignmentResponses?.UALICE.returnTo?.join() === "UCREATOR");
    assert(f.invitation().invitation.id !== originalInvitation);
    assert(f.posts.at(-1)!.channel === "DUALICE");
    assert(f.posts.at(-1)!.text.includes("<@UCAROL> rejected it"));
    assert(JSON.stringify(f.posts.at(-1)!.blocks).includes("Delegate"));
    assert(f.completed.length === 0);
    assert((await f.delegate(["UBOB"])).ok);
    assert(f.repository.rows.get(f.task.id)!.assignees.join() === "UBOB");
    assert(
      (await handleAssignmentAction(f.action(ASSIGNMENT_ACCEPT, "UBOB"), f.dependencies))
        .ok,
    );
    assert(f.completed.join() === "FXORIGIN");
    const view = f.views.at(-1)!.view as {
      title: { text: string };
      submit: { text: string };
    };
    assert(view.title.text === "Delegate task" && view.submit.text === "Delegate");
    assert(!JSON.stringify(f.posts).includes("Reassign"));
  });
}

Deno.test("creator rejection stops the return cycle without notifying the creator again", async () => {
  const f = await fixture();
  assert((await handleAssignmentAction(f.action(ASSIGNMENT_REJECT), f.dependencies)).ok);
  const creatorReject = f.action(ASSIGNMENT_REJECT, "UCREATOR");
  assert((await handleAssignmentAction(creatorReject, f.dependencies)).ok);
  const saved = f.repository.rows.get(f.task.id)!;
  assert(
    saved.assignees.length === 0 &&
      saved.assignmentResponses?.UCREATOR.status === "rejected",
  );
  assert(f.posts.length === 2 && f.completed.join() === "FXORIGIN");
  const writes = f.repository.writes;
  assert((await handleAssignmentAction(creatorReject, f.dependencies)).ok);
  assert(
    f.repository.writes === writes && f.posts.length === 2 && f.completed.length === 1,
  );
});

Deno.test("failed return delivery retries without repeating the rejection or a successful invitation", async () => {
  const f = await fixture();
  const send = f.client.chat.postMessage;
  let failReturn = true;
  f.client.chat.postMessage = (args) =>
    args.channel === "DUCREATOR" && failReturn
      ? Promise.resolve({ ok: false, error: "ratelimited" })
      : send(args);
  const rejection = f.action(ASSIGNMENT_REJECT);
  const failed = await handleAssignmentAction(rejection, f.dependencies);
  assert(
    !failed.ok && failed.interactive && failed.error?.includes("response was saved"),
  );
  assert(f.repository.rows.get(f.task.id)!.assignees.join() === "UCREATOR");
  assert(f.completed.length === 0 && f.posts.length === 1);
  const writes = f.repository.writes;
  failReturn = false;
  assert((await handleAssignmentAction(rejection, f.dependencies)).ok);
  assert(f.repository.writes === writes && Number(f.posts.length) === 2);
  assert((await handleAssignmentAction(rejection, f.dependencies)).ok);
  assert(f.repository.writes === writes && Number(f.posts.length) === 2);
  assert(f.invitation("UCREATOR").invitation.status === "pending");
});

Deno.test("returning to an already assigned creator sends a fresh pending invitation", async () => {
  const f = await fixture({ assignees: ["UALICE", "UCREATOR"] });
  assert(
    (await handleAssignmentAction(
      f.action(ASSIGNMENT_ACCEPT, "UCREATOR"),
      f.dependencies,
    )).ok,
  );
  const acceptedInvitation = f.invitation("UCREATOR").invitation.id;
  assert((await handleAssignmentAction(f.action(ASSIGNMENT_REJECT), f.dependencies)).ok);
  assert(f.posts.length === 3 && f.posts[2].channel === "DUCREATOR");
  assert(f.invitation("UCREATOR").invitation.id !== acceptedInvitation);
  assert(f.invitation("UCREATOR").invitation.status === "pending");
  assert(
    f.repository.rows.get(f.task.id)!.assignmentResponses?.UCREATOR.status === "pending",
  );
  assert(f.completed.length === 0);
});

Deno.test("combined delegation mentions support people and teams and forward a note once", async () => {
  const f = await fixture();
  f.client.usergroups.list = () =>
    Promise.reject(new Error("Native group mentions must not require handle discovery"));
  const result = await submitRecipients(
    f,
    mentions("UBOB", "SBACKEND", "UBOB"),
    "  Please review <@UALICE> & confirm.  ",
  );
  assert(result.ok && result.interactive);
  const task = f.repository.rows.get(f.task.id)!;
  assert(task.assignees.join() === "UBOB,SBACKEND");
  assert(
    task.assignmentResponses?.SBACKEND.note === "Please review <@UALICE> & confirm.",
  );
  assert(f.posts.length === 3);
  for (const post of f.posts.slice(1)) {
    assert(post.text.includes("*Note:* Please review &lt;@UALICE&gt; &amp; confirm."));
    assert(JSON.stringify(post.blocks).includes("Delegate"));
  }
  const modal = f.views[0]!.view as {
    blocks: Array<{ block_id: string; optional?: boolean; element: { type: string } }>;
  };
  assert(
    modal.blocks.length === 2 && modal.blocks[0].block_id === "delegation_recipients",
  );
  assert(modal.blocks[0].element.type === "rich_text_input" && !modal.blocks[0].optional);
  assert(modal.blocks[1].block_id === "delegation_note" && modal.blocks[1].optional);
  assert(f.invitation("UCAROL").invitation.note === "Please review <@UALICE> & confirm.");
});

Deno.test("blank delegation notes are omitted from invitations and stored responses", async () => {
  const f = await fixture();
  assert((await submitRecipients(f, mentions("UBOB"), " \n ")).ok);
  assert(!f.posts[1].text.includes("Note:"));
  assert(f.repository.rows.get(f.task.id)!.assignmentResponses?.UBOB.note === undefined);
  assert(f.invitation("UBOB").invitation.note === undefined);
});

Deno.test("empty, malformed, and oversized recipient selections never delegate a task", async () => {
  for (
    const recipients of [
      mentions(),
      {
        type: "rich_text",
        elements: [{
          type: "rich_text_section",
          elements: [{ type: "text", text: " \n , " }],
        }],
      },
      {
        type: "rich_text",
        elements: [{
          type: "rich_text_section",
          elements: [{ type: "broadcast", range: "everyone" }],
        }],
      },
      mentions(...Array.from({ length: 21 }, (_, i) => `U${i}`)),
      mentions("SUNKNOWN"),
    ]
  ) {
    const f = await fixture();
    const writes = f.repository.writes;
    const result = await submitRecipients(f, recipients);
    assert(!result.ok && f.repository.writes === writes && f.posts.length === 1);
    assert(f.invitation().invitation.status === "pending");
  }
});

Deno.test("oversized notes report an error on the note field without saving a delegation", async () => {
  const f = await fixture();
  const writes = f.repository.writes;
  const result = await submitRecipients(f, mentions("UBOB"), "x".repeat(2001));
  assert(!result.ok && result.errorField === "delegation_note");
  assert(f.repository.writes === writes && f.posts.length === 1);
});

Deno.test("Slack's submitted rich-text modal payload delegates to a team and forwards its note", async () => {
  const f = await fixture();
  assert(
    (await handleAssignmentAction(f.action(ASSIGNMENT_DELEGATE), f.dependencies)).ok,
  );
  const records = new Map<string, Map<string, Record<string, unknown>>>();
  const client = {
    ...f.client,
    conversations: {
      ...f.client.conversations,
      info: () =>
        Promise.resolve({ ok: true, channel: { context_team_id: "TWORKSPACE" } }),
    },
    usergroups: {
      ...f.client.usergroups,
      list: () =>
        Promise.resolve({
          ok: true,
          usergroups: [...f.groups].map(([id, users]) => ({
            id,
            users,
            user_count: users.length,
            date_delete: 0,
            handle: id === "SFRONTEND" ? "frontend" : "backend",
          })),
        }),
    },
    apps: {
      datastore: {
        put: (
          { datastore, item }: { datastore: string; item: Record<string, unknown> },
        ) => {
          if (!records.has(datastore)) records.set(datastore, new Map());
          records.get(datastore)!.set(item.id as string, structuredClone(item));
          return Promise.resolve({ ok: true });
        },
        get: ({ datastore, id }: { datastore: string; id: string }) =>
          Promise.resolve({
            ok: true,
            item: structuredClone(records.get(datastore)?.get(id) ?? {}),
          }),
        query: ({ datastore }: { datastore: string }) =>
          Promise.resolve({
            ok: true,
            items: [...records.get(datastore)?.values() ?? []],
          }),
      },
    },
  };
  const repository = new SlackTaskRepository(client);
  await repository.save(f.task);
  for (const batch of f.rows.values()) {
    await new SlackNotificationStore(client).save(batch);
  }
  const privateMetadata =
    (f.views.at(-1)!.view as { private_metadata: string }).private_metadata;
  const response = await assignmentViewSubmissionHandler(
    {
      client,
      body: { user: { id: "UALICE" }, function_data: { execution_id: "FXORIGIN" } },
      view: {
        id: "V1",
        private_metadata: privateMetadata,
        state: {
          values: {
            delegation_recipients: {
              recipients: {
                type: "rich_text_input",
                rich_text_value: mentions("SBACKEND"),
              },
            },
            delegation_note: {
              note: { type: "plain_text_input", value: "Please check this today." },
            },
          },
        },
      },
    } as unknown as Parameters<typeof assignmentViewSubmissionHandler>[0],
  );
  assert(response.response_action === "clear", JSON.stringify(response));
  assert((await repository.findById(f.task.id))?.assignees.join() === "SBACKEND");
  assert(f.posts.length === 2 && f.posts[1].channel === "DUCAROL");
  assert(f.posts[1].text.includes("*Note:* Please check this today."));
  assert(
    f.updates.some((update) =>
      update.channel === "DUCAROL" &&
      update.text.includes("*Note:* Please check this today.")
    ),
  );
});
