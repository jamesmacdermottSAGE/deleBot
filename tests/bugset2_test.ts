import { parseTaskCommand } from "../delebot/tasks/commands.ts";
import { createTask, respondToAssignment, updateTask } from "../delebot/tasks/service.ts";
import { TaskLockTimeoutError, withKeyLock } from "../delebot/tasks/mutation.ts";
import {
  assignmentInvitationKey,
  createAssignmentTree,
  pendingAssignmentNodes,
  respondInAssignmentTree,
} from "../delebot/tasks/assignment_tree.ts";
import { assert, MemoryTaskRepository } from "./task_fixtures.ts";

Deno.test("complete and incomplete support numbered and edit commands and completed list filters compose", () => {
  for (const text of ["complete", "123 complete", "edit complete"]) {
    const command = parseTaskCommand(text);
    assert(
      command.kind === "update" &&
        (command.patch.completed ?? command.patch.set?.completed) === true,
      text,
    );
  }
  for (const text of ["incomplete", "123 incomplete", "edit incomplete"]) {
    const command = parseTaskCommand(text);
    assert(
      command.kind === "update" &&
        (command.patch.completed ?? command.patch.set?.completed) === false,
      text,
    );
  }
  for (
    const text of [
      "ls complete",
      "ls me complete",
      "ls complete p1",
      "ls collab complete",
      "ls tasks complete",
      "ls task 123 complete",
    ]
  ) {
    const command = parseTaskCommand(text);
    assert(command.kind === "list" && command.query.completed === true, text);
  }
  assert(parseTaskCommand("complete incomplete").kind === "error");
  const quoted = parseTaskCommand('ls task "Almost complete now"');
  assert(
    quoted.kind === "list" && quoted.query.kind === "name" &&
      quoted.query.name === "Almost complete now",
  );
  const reopen = parseTaskCommand("123 approve incomplete");
  assert(reopen.kind === "approval-response" && reopen.kindOfAction === "incomplete");
});

Deno.test("returning directly to the creator rejects only that branch and waits for its sibling", () => {
  for (const siblings of [[], ["UBOB"]]) {
    const initial = createAssignmentTree("UCREATOR", ["UALICE", ...siblings]);
    const returned = respondInAssignmentTree(initial, {
      userId: "UALICE",
      kind: "delegate",
      assignees: ["UCREATOR"],
    });
    assert(
      Object.values(returned.tree.nodes).find((node) => node.principalId === "UALICE")
        ?.status === "rejected",
    );
    const users = pendingAssignmentNodes(returned.tree).map((node) => node.principalId);
    if (siblings.length) {
      assert(users.join() === "UBOB" && returned.inviteNodeIds.length === 0);
      const final = respondInAssignmentTree(returned.tree, {
        userId: "UBOB",
        kind: "reject",
      });
      assert(
        pendingAssignmentNodes(final.tree).map((node) => node.principalId).join() ===
          "UCREATOR",
      );
      assert(final.tree.nodes[final.tree.rootId].returned);
    } else {
      assert(users.join() === "UCREATOR");
      assert(returned.tree.nodes[returned.tree.rootId].returned);
    }
  }
});

Deno.test("repeated assign and adding another target preserve the original pending binding", async () => {
  const repository = new MemoryTaskRepository();
  const access = { userId: "UCREATOR", teamIds: [] };
  const context = { channelId: "DTEST", messageTs: "1.1", userId: access.userId };
  const { task } = await createTask(
    { name: "Preserve", assignees: ["UALICE"] },
    context,
    repository,
    access,
  );
  const key = assignmentInvitationKey(pendingAssignmentNodes(task.assignmentTree!)[0]);
  const repeated = await updateTask(
    task,
    { assignees: ["UALICE"] },
    { ...context, messageTs: "2.1" },
    repository,
    access,
  );
  assert(repeated.task.assignmentEvents?.["DTEST:2.1"].length === 0);
  const added = await updateTask(
    task,
    { assignees: ["UBOB"] },
    { ...context, messageTs: "2.2" },
    repository,
    access,
  );
  assert(added.task.assignmentEvents?.["DTEST:2.2"].join() === "UBOB");
  assert(
    pendingAssignmentNodes(added.task.assignmentTree!).some((node) =>
      node.principalId === "UALICE" && assignmentInvitationKey(node) === key
    ),
  );
});

Deno.test("assigning a new person after acceptance never reinvites the original owner", async () => {
  const repository = new MemoryTaskRepository();
  const access = { userId: "UCREATOR", teamIds: [] };
  const context = { channelId: "DTEST", messageTs: "1.1", userId: access.userId };
  const { task } = await createTask(
    { name: "Reassign", assignees: ["UALICE"] },
    context,
    repository,
    access,
  );
  await respondToAssignment(
    task,
    { kind: "accept" },
    { ...context, userId: "UALICE", messageTs: "2.1" },
    repository,
    { userId: "UALICE", teamIds: [] },
  );
  const reassigned = await updateTask(
    task,
    { assignees: ["UBOB"] },
    { ...context, messageTs: "2.2" },
    repository,
    access,
  );
  assert(reassigned.task.assignees.join() === "UBOB");
  assert(reassigned.task.assignmentEvents?.["DTEST:2.2"].join() === "UBOB");
  assert(
    !pendingAssignmentNodes(reassigned.task.assignmentTree!).some((node) =>
      node.principalId === "UALICE"
    ),
  );
});

Deno.test("simultaneous creation retries save once and preserve the first draft", async () => {
  const repository = new MemoryTaskRepository();
  const context = { channelId: "DTEST", messageTs: "1.1", userId: "UCREATOR" };
  const access = { userId: "UCREATOR", teamIds: [] };
  const results = await Promise.all([
    createTask({ name: "First" }, context, repository, access),
    createTask({ name: "Retry" }, context, repository, access),
  ]);
  assert(
    repository.writes === 1 && results.filter((result) => result.created).length === 1,
  );
  assert(results.every((result) => result.task.name === "First"));
});

Deno.test("lock timeout leaves successors queued behind the owner and failures release the lock", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = withKeyLock("busy-test", async () => {
    entered();
    await gate;
  });
  await started;
  let ran = false;
  const timed = await withKeyLock("busy-test", () => {
    ran = true;
    return Promise.resolve();
  }, 5).then(() => undefined, (error) => error);
  assert(timed instanceof TaskLockTimeoutError && !ran);
  const next = withKeyLock("busy-test", () => {
    ran = true;
    return Promise.resolve();
  });
  await withKeyLock("unrelated-test", () => Promise.resolve());
  assert(!ran);
  release();
  await Promise.all([owner, next]);
  assert(ran);
  await withKeyLock("failure-test", () => Promise.reject(new Error("Expected failure")))
    .catch(() => {});
  assert(
    await withKeyLock("failure-test", () => Promise.resolve("released")) === "released",
  );
});
