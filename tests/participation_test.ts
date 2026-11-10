import {
  inviteCollaborators,
  isTaskCollaborator,
  parseParticipation,
  requestTaskAction,
  respondToCollaboration,
  respondToTaskAction,
  type TaskParticipation,
} from "../delebot/tasks/participation.ts";
import {
  createTask,
  TaskAccessError,
  TaskCommandError,
  type TaskContext,
} from "../delebot/tasks/service.ts";
import type { Task, TaskAccess } from "../delebot/tasks/models.ts";
import { assert, MemoryTaskRepository } from "./task_fixtures.ts";

type ParticipatingTask = Task & { participation?: TaskParticipation };
const context = (userId: string, ts: string): TaskContext => ({
  userId,
  channelId: `D${userId}`,
  messageTs: ts,
});
const access = (userId: string, teamIds: string[] = []): TaskAccess => ({
  userId,
  teamIds,
});

async function rejected(
  action: () => Promise<unknown>,
  errorClass: new (message?: string) => Error = Error,
) {
  try {
    await action();
  } catch (error) {
    assert(error instanceof errorClass, String(error));
    return;
  }
  throw new Error("Expected rejection");
}

async function fixture() {
  const repo = new MemoryTaskRepository();
  const { task } = await createTask(
    {
      name: "Participation",
      assignees: ["UALICE"],
      viewPerms: ["all"],
      editPerms: ["UADMIN"],
    },
    context("UCREATOR", "1.1"),
    repo,
    access("UCREATOR"),
  );
  task.assignmentResponses = {
    ...task.assignmentResponses,
    UALICE: { status: "accepted", returnTo: ["UCREATOR"] },
  };
  await repo.save(task);
  return { repo, task: task as ParticipatingTask };
}

Deno.test("accepted owner invites collaborators separately from assignment with one durable notification event", async () => {
  const { repo, task } = await fixture();
  const invitationContext = context("UALICE", "2.1");
  const result = await inviteCollaborators(
    task,
    ["UBOB", "UCAROL", "UBOB"],
    invitationContext,
    repo,
    access("UALICE"),
  );
  assert(result.updated && result.task.assignees.join() === "UALICE");
  assert(result.task.participation?.collaborators.UBOB.status === "pending");
  assert(result.task.participation.collaborators.UCAROL.invitedBy === "UALICE");
  assert(
    result.task.participation.deliveryEvents["DUALICE:2.1"].recipients.join() ===
      "UBOB,UCAROL",
  );
  assert(
    result.task.editPerms?.join() === "UADMIN" && result.task.viewPerms?.join() === "all",
  );
  const writes = repo.writes;
  const replay = await inviteCollaborators(
    result.task,
    ["UBOB", "UCAROL"],
    invitationContext,
    repo,
    access("UALICE"),
  );
  assert(!replay.updated && repo.writes === writes);
  const pendingAgain = await inviteCollaborators(
    result.task,
    ["UBOB"],
    context("UALICE", "2.2"),
    repo,
    access("UALICE"),
  );
  assert(!pendingAgain.updated && repo.writes === writes);
});

Deno.test("pending assignees, collaborators, and unrelated viewers cannot invite collaborators", async () => {
  const { repo, task } = await fixture();
  for (
    const candidate of [
      { task, user: "UBOB" },
      {
        task: {
          ...task,
          assignmentResponses: { UALICE: { status: "pending" as const } },
        },
        user: "UALICE",
      },
      {
        task: { ...task, completed: true, status: "completed" as const },
        user: "UALICE",
      },
    ]
  ) {
    repo.rows.set(task.id, candidate.task);
    const writes = repo.writes;
    await rejected(
      () =>
        inviteCollaborators(
          candidate.task,
          ["UCAROL"],
          context(candidate.user, "2.1"),
          repo,
          access(candidate.user),
        ),
      TaskAccessError,
    );
    assert(repo.writes === writes);
  }
});

Deno.test("collaboration invitation acceptance and rejection are recipient-specific and replay safe", async () => {
  const { repo, task } = await fixture();
  const invited = await inviteCollaborators(
    task,
    ["UBOB", "UCAROL"],
    context("UALICE", "2.1"),
    repo,
    access("UALICE"),
  );
  const accepted = await respondToCollaboration(
    invited.task,
    "accept",
    context("UBOB", "3.1"),
    repo,
    access("UBOB"),
  );
  assert(
    isTaskCollaborator(accepted.task, "UBOB") &&
      !isTaskCollaborator(accepted.task, "UCAROL"),
  );
  assert(accepted.task.assignees.join() === "UALICE");
  const declined = await respondToCollaboration(
    accepted.task,
    "reject",
    context("UCAROL", "3.2"),
    repo,
    access("UCAROL"),
  );
  assert(declined.task.participation?.collaborators.UCAROL.status === "rejected");
  assert(!isTaskCollaborator(declined.task, "UCAROL"));
  const writes = repo.writes;
  assert(
    !(await respondToCollaboration(
      declined.task,
      "reject",
      context("UCAROL", "3.2"),
      repo,
      access("UCAROL"),
    )).updated,
  );
  assert(repo.writes === writes);
  await rejected(
    () =>
      respondToCollaboration(
        declined.task,
        "accept",
        context("UOTHER", "3.3"),
        repo,
        access("UOTHER"),
      ),
    TaskCommandError,
  );
});

Deno.test("collaboration invitations do not bypass viewing permission or survive owner changes", async () => {
  const { repo, task } = await fixture();
  const invited = await inviteCollaborators(
    task,
    ["UBOB"],
    context("UALICE", "2.1"),
    repo,
    access("UALICE"),
  );
  const writes = repo.writes;
  repo.rows.set(task.id, { ...invited.task, viewPerms: ["UALICE"] });
  await rejected(
    () =>
      respondToCollaboration(
        { ...invited.task, viewPerms: ["UALICE"] },
        "accept",
        context("UBOB", "3.1"),
        repo,
        access("UBOB"),
      ),
    TaskAccessError,
  );
  repo.rows.set(task.id, { ...invited.task, assignees: ["UNEW"] });
  await rejected(
    () =>
      respondToCollaboration(
        { ...invited.task, assignees: ["UNEW"] },
        "accept",
        context("UBOB", "3.1"),
        repo,
        access("UBOB"),
      ),
    TaskAccessError,
  );
  await rejected(
    () =>
      respondToCollaboration(
        invited.task,
        "accept",
        context("UBOB", "3.1"),
        repo,
        access("UCAROL"),
      ),
    TaskAccessError,
  );
  assert(repo.writes === writes);
});

Deno.test("invalid collaboration targets do not save partial requests", async () => {
  const { repo, task } = await fixture();
  const writes = repo.writes;
  for (
    const targets of [
      [],
      ["UALICE"],
      ["SFRONTEND"],
      ["all"],
      ["UBOB", "bad"],
      Array.from({ length: 21 }, (_, index) => `U${index}`),
    ]
  ) {
    await rejected(
      () =>
        inviteCollaborators(
          task,
          targets,
          context("UALICE", "2.1"),
          repo,
          access("UALICE"),
        ),
      TaskCommandError,
    );
  }
  assert(repo.writes === writes);
});

Deno.test("completion and deletion requests notify access principals without changing the task", async () => {
  const { repo, task } = await fixture();
  const restricted = { ...task, editPerms: ["UADMIN", "SADMINS"] };
  repo.rows.set(task.id, restricted);
  const completion = await requestTaskAction(
    restricted,
    "complete",
    context("UBOB", "2.1"),
    repo,
    access("UBOB"),
  );
  assert(completion.updated && completion.requestId === "DUBOB:2.1");
  assert(!completion.task.completed && !completion.task.deleted);
  assert(
    completion.task.participation?.deliveryEvents[completion.requestId].recipients
      .join() === "UADMIN,SADMINS",
  );
  const deletion = await requestTaskAction(
    completion.task,
    "delete",
    context("UBOB", "2.2"),
    repo,
    access("UBOB"),
  );
  assert(
    !deletion.task.deleted &&
      deletion.task.participation?.requests[deletion.requestId].kind === "delete",
  );
  const writes = repo.writes;
  const replay = await requestTaskAction(
    deletion.task,
    "complete",
    context("UBOB", "2.1"),
    repo,
    access("UBOB"),
  );
  assert(
    !replay.updated && replay.requestId === completion.requestId &&
      repo.writes === writes,
  );
  const another = await requestTaskAction(
    deletion.task,
    "complete",
    context("UBOB", "2.3"),
    repo,
    access("UBOB"),
  );
  assert(
    !another.updated && another.requestId === completion.requestId &&
      repo.writes === writes,
  );
});

Deno.test("only fresh access holders can approve or decline a completion request", async () => {
  const { repo, task } = await fixture();
  const request = await requestTaskAction(
    task,
    "complete",
    context("UBOB", "2.1"),
    repo,
    access("UBOB"),
  );
  const writes = repo.writes;
  await rejected(
    () =>
      respondToTaskAction(
        request.task,
        request.requestId,
        "approve",
        context("UALICE", "3.1"),
        repo,
        access("UALICE"),
      ),
    TaskAccessError,
  );
  repo.rows.set(task.id, { ...request.task, editPerms: ["UNEW"] });
  await rejected(
    () =>
      respondToTaskAction(
        { ...request.task, editPerms: ["UNEW"] },
        request.requestId,
        "approve",
        context("UADMIN", "3.1"),
        repo,
        access("UADMIN"),
      ),
    TaskAccessError,
  );
  assert(repo.writes === writes);
  repo.rows.set(task.id, request.task);
  const approved = await respondToTaskAction(
    request.task,
    request.requestId,
    "approve",
    context("UADMIN", "3.1"),
    repo,
    access("UADMIN"),
  );
  assert(
    approved.updated && approved.task.completed && approved.task.status === "completed",
  );
  assert(approved.task.participation?.requests[request.requestId].status === "approved");
  const approvedWrites = repo.writes;
  assert(
    !(await respondToTaskAction(
      approved.task,
      request.requestId,
      "approve",
      context("UADMIN", "3.1"),
      repo,
      access("UADMIN"),
    )).updated,
  );
  assert(repo.writes === approvedWrites);
});

Deno.test("access group membership is verified when resolving a request", async () => {
  const { repo, task } = await fixture();
  repo.rows.set(task.id, { ...task, editPerms: ["SADMINS"] });
  const request = await requestTaskAction(
    { ...task, editPerms: ["SADMINS"] },
    "complete",
    context("UBOB", "2.1"),
    repo,
    access("UBOB"),
  );
  await rejected(
    () =>
      respondToTaskAction(
        request.task,
        request.requestId,
        "approve",
        context("UADMIN", "3.1"),
        repo,
        access("UADMIN"),
      ),
    TaskAccessError,
  );
  const declined = await respondToTaskAction(
    request.task,
    request.requestId,
    "reject",
    context("UADMIN", "3.1"),
    repo,
    access("UADMIN", ["SADMINS"]),
  );
  assert(
    !declined.task.completed &&
      declined.task.participation?.requests[request.requestId].status === "rejected",
  );
});

Deno.test("approved deletion leaves a durable tombstone and cancels obsolete requests", async () => {
  const { repo, task } = await fixture();
  const completion = await requestTaskAction(
    task,
    "complete",
    context("UBOB", "2.1"),
    repo,
    access("UBOB"),
  );
  const deletion = await requestTaskAction(
    completion.task,
    "delete",
    context("UCAROL", "2.2"),
    repo,
    access("UCAROL"),
  );
  const approved = await respondToTaskAction(
    deletion.task,
    deletion.requestId,
    "approve",
    context("UADMIN", "3.1"),
    repo,
    access("UADMIN"),
  );
  assert(approved.task.deleted && repo.rows.get(task.id)?.deleted);
  assert(approved.task.participation?.requests[deletion.requestId].status === "approved");
  assert(
    approved.task.participation.requests[completion.requestId].status === "cancelled",
  );
});

Deno.test("requests fail closed when no access holder exists or identity does not match", async () => {
  const { repo, task } = await fixture();
  const writes = repo.writes;
  repo.rows.set(task.id, { ...task, editPerms: [] });
  await rejected(
    () =>
      requestTaskAction(
        { ...task, editPerms: [] },
        "complete",
        context("UBOB", "2.1"),
        repo,
        access("UBOB"),
      ),
    TaskCommandError,
  );
  await rejected(
    () =>
      requestTaskAction(task, "delete", context("UBOB", "2.1"), repo, access("UCAROL")),
    TaskAccessError,
  );
  repo.rows.set(task.id, { ...task, viewPerms: ["UALICE"] });
  await rejected(
    () =>
      requestTaskAction(
        { ...task, viewPerms: ["UALICE"] },
        "delete",
        context("UBOB", "2.1"),
        repo,
        access("UBOB"),
      ),
    TaskAccessError,
  );
  assert(repo.writes === writes);
});

Deno.test("participation metadata validates round trips and rejects malformed authorization state", async () => {
  const { repo, task } = await fixture();
  const invite = await inviteCollaborators(
    task,
    ["UBOB"],
    context("UALICE", "2.1"),
    repo,
    access("UALICE"),
  );
  const request = await requestTaskAction(
    invite.task,
    "complete",
    context("UCAROL", "2.2"),
    repo,
    access("UCAROL"),
  );
  const valid = request.task.participation!;
  assert(JSON.stringify(parseParticipation(valid)) === JSON.stringify(valid));
  const bad = [
    {
      ...valid,
      collaborators: {
        "<!channel>": { status: "pending", invitedBy: "UALICE", eventKey: "x" },
      },
    },
    {
      ...valid,
      requests: {
        x: {
          kind: "delete",
          status: "approved",
          requestedBy: "UBOB",
          resolvedBy: "SADMINS",
          eventKey: "x",
        },
      },
    },
    {
      ...valid,
      deliveryEvents: {
        x: { kind: "approval", recipients: ["UADMIN"], reference: "missing" },
      },
    },
    {
      ...valid,
      deliveryEvents: {
        x: { kind: "collaboration", recipients: ["SADMINS"], reference: "x" },
      },
    },
  ];
  for (const candidate of bad) {
    let rejected = false;
    try {
      parseParticipation(candidate);
    } catch {
      rejected = true;
    }
    assert(rejected);
  }
});

Deno.test("concurrent collaboration responses reread pending state and commit only one decision", async () => {
  const { repo, task } = await fixture();
  const invited = await inviteCollaborators(
    task,
    ["UBOB"],
    context("UALICE", "2.1"),
    repo,
    access("UALICE"),
  );
  const writes = repo.writes;
  const responses = await Promise.allSettled([
    respondToCollaboration(
      invited.task,
      "accept",
      context("UBOB", "3.1"),
      repo,
      access("UBOB"),
    ),
    respondToCollaboration(
      invited.task,
      "reject",
      context("UBOB", "3.2"),
      repo,
      access("UBOB"),
    ),
  ]);
  assert(responses.filter((result) => result.status === "fulfilled").length === 1);
  assert(repo.writes === writes + 1);
  assert(
    (repo.rows.get(task.id) as ParticipatingTask).participation?.collaborators.UBOB
      .status === "accepted",
  );
});

Deno.test("concurrent requests for the same action by one requester produce a single approval event", async () => {
  const { repo, task } = await fixture();
  const requests = await Promise.all([
    requestTaskAction(task, "complete", context("UBOB", "2.1"), repo, access("UBOB")),
    requestTaskAction(task, "complete", context("UBOB", "2.2"), repo, access("UBOB")),
  ]);
  assert(requests.filter((result) => result.updated).length === 1);
  assert(requests[0].requestId === requests[1].requestId);
  const latest = repo.rows.get(task.id) as ParticipatingTask;
  assert(Object.keys(latest.participation!.deliveryEvents).length === 1);
});
