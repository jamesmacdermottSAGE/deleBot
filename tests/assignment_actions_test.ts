import {
  type AssignmentAction,
  type AssignmentClient,
  type AssignmentDependencies,
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
} from "../delebot/slack/notifications.ts";
import type { TaskInput } from "../delebot/tasks/models.ts";
import { createTask } from "../delebot/tasks/service.ts";
import { assert, MemoryTaskRepository } from "./task_fixtures.ts";

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
    const batch = [...rows.values()].find((row) => row.invitations?.[userId])!;
    assert(batch);
    return { batch, invitation: batch.invitations![userId] };
  }
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
      actionTs: "1793690010.000001",
    };
  }
  async function reassign(users: string[], teamText = "") {
    const opened = await handleAssignmentAction(
      action(ASSIGNMENT_DELEGATE),
      dependencies,
    );
    assert(opened.ok);
    return await handleAssignmentSubmission({
      privateMetadata:
        (views.at(-1)!.view as { private_metadata: string }).private_metadata,
      userId: "UALICE",
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
    reassign,
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
    blocks.includes("Accept") && blocks.includes("Reject") && blocks.includes("Reassign"),
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

Deno.test("reject removes a direct assignment and deletes the same invitation DM", async () => {
  const f = await fixture();
  const action = f.action(ASSIGNMENT_REJECT);
  assert((await handleAssignmentAction(action, f.dependencies)).ok);
  assert(f.invitation().invitation.status === "rejected");
  assert(f.invitation().invitation.messageRemoved);
  assert(f.repository.rows.get(f.task.id)!.assignees.length === 0);
  assert(
    f.deleted.length === 1 && f.deleted[0].channel === "DUALICE" &&
      f.deleted[0].ts === "10.1",
  );
  assert((await handleAssignmentAction(action, f.dependencies)).ok);
  assert(f.deleted.length === 1 && f.completed.length === 1);
});

Deno.test("rejecting a team invitation keeps the team assignment and other invitations active", async () => {
  const f = await fixture({ assignees: ["SFRONTEND"] });
  assert(f.posts.length === 2);
  assert((await handleAssignmentAction(f.action(ASSIGNMENT_REJECT), f.dependencies)).ok);
  assert(f.repository.rows.get(f.task.id)!.assignees.join() === "SFRONTEND");
  assert(
    f.invitation("UBOB").invitation.status === "pending" && f.completed.length === 0,
  );
  assert(
    (await handleAssignmentAction(f.action(ASSIGNMENT_ACCEPT, "UBOB"), f.dependencies))
      .ok,
  );
  assert(f.completed.join() === "FXORIGIN");
});

Deno.test("reassignment updates its original DM and gives the new assignee an actionable DM", async () => {
  const f = await fixture();
  const result = await f.reassign(["UBOB"]);
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

Deno.test("reassignment supports verified Slack team handles and notifies their members", async () => {
  const f = await fixture();
  assert((await f.reassign([], "@backend")).ok);
  assert(f.repository.rows.get(f.task.id)!.assignees.join() === "SBACKEND");
  assert(f.posts.length === 2 && f.posts[1].channel === "DUCAROL");
  assert(f.updates[0].text.includes("Delegated to <!subteam^SBACKEND>"));
});

Deno.test("reassignment cannot hand a task to someone without viewing permission", async () => {
  const f = await fixture({ viewPerms: ["UALICE"], editPerms: ["UALICE"] });
  const writes = f.repository.writes;
  const result = await f.reassign(["UBOB"]);
  assert(!result.ok && result.error?.includes("viewing permission first"));
  assert(f.repository.writes === writes && f.posts.length === 1);
  assert(
    f.invitation().invitation.status === "pending" && !f.invitation().invitation.decision,
  );
});
