import {
  createTask,
  deleteTask,
  listTasks,
  mutationKey,
  resolveTaskForUpdate,
  TaskAccessError,
  TaskCommandError,
  taskNumber,
  updateTask,
} from "../delebot/tasks/service.ts";
import type { TaskAccess, TaskQuery } from "../delebot/tasks/models.ts";
import type { TaskPatch } from "../delebot/tasks/commands.ts";
import { assert, input, MemoryTaskRepository } from "./task_fixtures.ts";

const context = {
  channelId: "CTEST",
  messageTs: "1793690000.000001",
  userId: "UCREATOR",
};
const access: TaskAccess = { userId: "UCREATOR", teamIds: ["SFRONTEND"] };

function reply(messageTs: string, userId = context.userId) {
  return { ...context, messageTs, userId, threadTs: context.messageTs };
}

async function rejection(action: () => Promise<unknown>): Promise<Error> {
  try {
    await action();
  } catch (error) {
    assert(error instanceof Error);
    return error;
  }
  throw new Error("Expected this operation to reject");
}

Deno.test("creation preserves fields, leaves empty assignments unassigned and stores completion", async () => {
  const repo = new MemoryTaskRepository();
  const { task } = await createTask(
    { ...input, assignees: [], completed: true },
    context,
    repo,
    access,
  );
  assert(task.assignees.length === 0 && task.teams.length === 0);
  assert(task.assignmentEvents?.[mutationKey(context)].length === 0);
  assert(task.completed && task.status === "completed" && task.assignmentBased);
  assert(task.description === input.description && task.links[0] === input.links[0]);
  assert(task.createdAt === "2026-11-03T07:13:20.000Z");
  assert(task.number === await taskNumber(context.channelId, context.messageTs));
});

Deno.test("mixed assignment deduplicates people and teams and permits delegation", async () => {
  const repo = new MemoryTaskRepository();
  const { task } = await createTask(
    { ...input, assignees: ["UJAMES", "SFRONTEND", "SBACKEND", "UJAMES"] },
    context,
    repo,
    access,
  );
  assert(task.assignees.join() === "UJAMES,SFRONTEND,SBACKEND");
  assert(task.teams.join() === "SFRONTEND,SBACKEND");
  const delegated = await createTask(
    { ...input, assignees: ["UALICE"] },
    { ...context, messageTs: "9.1" },
    repo,
    access,
  );
  assert(delegated.created);
  assert(
    (await listTasks({ kind: "number", number: delegated.task.number }, access, repo))
      .length === 1,
  );
  assert(
    (await listTasks({ kind: "number", number: delegated.task.number }, {
      userId: "UALICE",
      teamIds: [],
    }, repo)).length === 1,
  );
});

Deno.test("replayed and concurrent events preserve stable references without duplicate task rows", async () => {
  const repo = new MemoryTaskRepository();
  const results = await Promise.all([
    createTask(input, context, repo, access),
    createTask(input, context, repo, access),
    createTask(input, { ...context, channelId: "COTHER" }, repo, access),
  ]);
  assert(repo.rows.size === 2 && results[0].task.number === results[1].task.number);
  assert(results[0].task.number !== results[2].task.number);
  const writes = repo.writes;
  const retried = await createTask({ ...input, completed: true }, context, repo, access);
  assert(!retried.created && !retried.task.completed && writes === repo.writes);
});

Deno.test("assignments and creator grant access but every selector excludes strangers", async () => {
  const repo = new MemoryTaskRepository();
  const { task } = await createTask(
    { ...input, assignees: ["UJAMES", "SBACKEND"] },
    context,
    repo,
    access,
  );
  assert(
    (await listTasks({ kind: "all" }, { userId: "UJAMES", teamIds: [] }, repo)).length ===
      1,
  );
  assert(
    (await listTasks({ kind: "all" }, { userId: "UOTHER", teamIds: ["SBACKEND"] }, repo))
      .length === 1,
  );
  // A faulty repository must still not expose records through any selector.
  repo.list = () => Promise.resolve([task]);
  const queries: TaskQuery[] = [
    { kind: "all" },
    { kind: "number", number: task.number },
    { kind: "name", name: task.name },
    { kind: "assignee", userId: "UJAMES" },
    { kind: "team", teamId: "SBACKEND" },
    { kind: "completed", completed: false },
    { kind: "due", dueDate: "2026-11-06" },
    { kind: "priority", priority: 2 },
    { kind: "filters", targets: [{ kind: "user", userId: "UJAMES" }] },
    { kind: "filters", targets: [{ kind: "my-teams" }], priority: 2 },
    { kind: "filters", soon: true },
  ];
  for (const query of queries) {
    assert(
      (await listTasks(query, { userId: "USTRANGER", teamIds: [] }, repo)).length === 0,
    );
  }
});

Deno.test("every filter including completed matches authorized tasks across channels", async () => {
  const repo = new MemoryTaskRepository();
  const first = await createTask(
    { ...input, assignees: ["UCREATOR", "SFRONTEND"] },
    context,
    repo,
    access,
  );
  const second = await createTask(
    {
      ...input,
      name: "Release",
      assignees: ["all"],
      completed: true,
      priority: 1,
      dueDate: "2026-11-07",
    },
    { ...context, channelId: "COTHER", messageTs: "1793690000.000002" },
    repo,
    access,
  );
  assert((await listTasks({ kind: "all" }, access, repo)).length === 2);
  for (
    const query of [
      { kind: "number", number: first.task.number },
      { kind: "name", name: "cLeAn PRs" },
      { kind: "assignee", userId: "UCREATOR" },
      { kind: "team", teamId: "SFRONTEND" },
      { kind: "completed", completed: false },
      { kind: "due", dueDate: "2026-11-06" },
      { kind: "priority", priority: 2 },
    ] as TaskQuery[]
  ) assert((await listTasks(query, access, repo))[0].number === first.task.number);
  assert(
    (await listTasks({ kind: "completed", completed: true }, access, repo))[0].number ===
      second.task.number,
  );
});

Deno.test("revoked team membership removes access unless directly assigned", async () => {
  const repo = new MemoryTaskRepository();
  await createTask(input, context, repo, access);
  const viewer = { userId: "UOTHER", teamIds: ["SFRONTEND"] };
  assert((await listTasks({ kind: "all" }, viewer, repo)).length === 1);
  assert(
    (await listTasks({ kind: "all" }, { ...viewer, teamIds: [] }, repo)).length === 0,
  );
  await createTask(
    { ...input, assignees: ["UOTHER", "SFRONTEND"] },
    { ...context, messageTs: "9.1" },
    repo,
    access,
  );
  assert(
    (await listTasks({ kind: "all" }, { ...viewer, teamIds: [] }, repo)).length === 1,
  );
});

Deno.test("legacy separate-team policies retain existing visibility", async () => {
  const repo = new MemoryTaskRepository();
  const { task } = await createTask(input, context, repo, access);
  repo.rows.set(task.id, {
    ...task,
    assignmentBased: false,
    assignees: ["UJAMES"],
    teams: ["SBACKEND"],
  });
  for (const userId of ["UJAMES", "UCREATOR"]) {
    assert(
      (await listTasks({ kind: "all" }, { userId, teamIds: [] }, repo)).length === 0,
    );
  }
  assert(
    (await listTasks({ kind: "all" }, { userId: "UOTHER", teamIds: ["SBACKEND"] }, repo))
      .length === 1,
  );
});

Deno.test("identity mismatch and invalid assignees never write a task", async () => {
  const repo = new MemoryTaskRepository();
  for (
    const action of [
      () => createTask(input, context, repo, { ...access, userId: "UOTHER" }),
      () => createTask({ ...input, assignees: ["all", "UJAMES"] }, context, repo, access),
      () => createTask({ ...input, assignees: ["invalid"] }, context, repo, access),
      () => createTask({ name: " " }, context, repo, access),
    ]
  ) {
    let rejected = false;
    try {
      await action();
    } catch (error) {
      rejected = error instanceof Error || error instanceof TaskAccessError;
    }
    assert(rejected);
  }
  assert(repo.writes === 0);
});

Deno.test("invalid timestamps and failed writes reject creation", async () => {
  const repo = new MemoryTaskRepository();
  for (const messageTs of ["bad", "1", "1.1234567", "9007199254740991.000001"]) {
    let failed = false;
    try {
      await createTask(input, { ...context, messageTs }, repo, access);
    } catch {
      failed = true;
    }
    assert(failed);
  }
  repo.save = () => Promise.reject(new Error("unavailable"));
  let failed = false;
  try {
    await createTask(input, context, repo, access);
  } catch {
    failed = true;
  }
  assert(failed && repo.rows.size === 0);
});

Deno.test("name-only creation defaults optional fields and preserves thread context", async () => {
  const repo = new MemoryTaskRepository();
  const { task, created } = await createTask(
    { name: "  Errands  " },
    context,
    repo,
    access,
  );
  assert(created && task.name === "Errands");
  assert(task.assignees.length === 0 && task.teams.length === 0);
  assert(task.links.length === 0 && task.description === "");
  assert(task.dueDate === null && task.priority === null);
  assert(!task.completed && task.status === "open" && task.assignmentBased);
  assert(task.threadTs === context.messageTs);
  const event = mutationKey(context);
  assert(task.appliedEvents?.includes(event));
  assert(task.assignmentEvents?.[event].length === 0);

  const nested = await createTask({ name: "Nested" }, reply("9.1"), repo, access);
  assert(nested.task.threadTs === context.messageTs && nested.task.messageTs === "9.1");
});

Deno.test("thread context resolves tasks and an explicit number selects across threads", async () => {
  const repo = new MemoryTaskRepository();
  const first = await createTask({ name: "First" }, context, repo, access);
  const otherContext = { ...context, channelId: "COTHER", messageTs: "9.1" };
  const second = await createTask({ name: "Second" }, otherContext, repo, access);
  const current = await resolveTaskForUpdate(undefined, reply("9.2"), repo, access);
  assert(current.id === first.task.id);
  const explicit = await resolveTaskForUpdate(
    second.task.number,
    reply("9.3"),
    repo,
    access,
  );
  assert(explicit.id === second.task.id);
  const missing = await rejection(() =>
    resolveTaskForUpdate(undefined, { ...reply("9.4"), threadTs: "9.0" }, repo, access)
  );
  assert(missing instanceof TaskCommandError && /No task/.test(missing.message));
});

Deno.test("multiple tasks in one thread require an explicit task number", async () => {
  const repo = new MemoryTaskRepository();
  const first = await createTask({ name: "First" }, context, repo, access);
  const second = await createTask({ name: "Second" }, reply("9.1"), repo, access);
  assert(second.task.threadTs === first.task.threadTs);
  const writes = repo.writes;
  const error = await rejection(() =>
    resolveTaskForUpdate(undefined, reply("9.2"), repo, access)
  );
  assert(error instanceof TaskCommandError && /task number/.test(error.message));
  assert(repo.writes === writes);
  const selected = await resolveTaskForUpdate(
    second.task.number,
    reply("9.3"),
    repo,
    access,
  );
  assert(selected.id === second.task.id);
});

Deno.test("a combined thread update saves every field and its new assignment intent", async () => {
  const repo = new MemoryTaskRepository();
  const created = await createTask({ name: "Errands" }, context, repo, access);
  const updateContext = reply("9.1");
  const current = await resolveTaskForUpdate(undefined, updateContext, repo, access);
  const result = await updateTask(
    current,
    {
      assignees: ["UALICE", "SFRONTEND", "UALICE"],
      description: "Pick up groceries.",
      priority: 1,
      dueDate: "2026-11-10",
      links: ["https://example.com/list", "https://example.com/list"],
      completed: true,
    },
    updateContext,
    repo,
    access,
  );
  assert(result.updated && result.task.number === created.task.number);
  assert(result.task.assignees.join() === "UALICE,SFRONTEND");
  assert(result.task.teams.join() === "SFRONTEND");
  assert(result.task.description === "Pick up groceries." && result.task.priority === 1);
  assert(result.task.dueDate === "2026-11-10");
  assert(result.task.links.join() === "https://example.com/list");
  assert(result.task.completed && result.task.status === "completed");
  assert(
    result.task.threadTs === context.messageTs &&
      result.task.messageTs === context.messageTs,
  );
  assert(
    result.task.assignmentEvents?.[mutationKey(updateContext)].join() ===
      "UALICE,SFRONTEND",
  );
});

Deno.test("sequential links and descriptions accumulate and event replay does not duplicate them", async () => {
  const repo = new MemoryTaskRepository();
  const created = await createTask({ name: "Review" }, context, repo, access);
  const first = await updateTask(
    created.task,
    {
      links: ["https://example.com/a"],
      description: "Review the first draft.",
    },
    reply("9.1"),
    repo,
    access,
  );
  const secondContext = reply("9.2");
  const patch = {
    links: ["https://example.com/a", "https://example.com/b"],
    description: "Include the appendix.",
  };
  const second = await updateTask(first.task, patch, secondContext, repo, access);
  const writes = repo.writes;
  const latest = await resolveTaskForUpdate(undefined, reply("9.3"), repo, access);
  const replay = await updateTask(latest, patch, secondContext, repo, access);
  assert(!replay.updated && repo.writes === writes);
  assert(replay.task.links.join() === "https://example.com/a,https://example.com/b");
  assert(replay.task.description === "Review the first draft.\n\nInclude the appendix.");
  assert(JSON.stringify(replay.task) === JSON.stringify(second.task));
});

Deno.test("a due date can be cleared and repeated done keeps the task complete", async () => {
  const repo = new MemoryTaskRepository();
  const created = await createTask({ ...input, completed: true }, context, repo, access);
  const first = await updateTask(
    created.task,
    { dueDate: null },
    reply("9.1"),
    repo,
    access,
  );
  assert(
    first.task.dueDate === null && first.task.completed &&
      first.task.status === "completed",
  );
  const second = await updateTask(
    first.task,
    { completed: true },
    reply("9.2"),
    repo,
    access,
  );
  assert(second.task.completed && second.task.dueDate === null);
});

Deno.test("assignment intents survive replay and unchanged assignees do not notify again", async () => {
  const repo = new MemoryTaskRepository();
  const created = await createTask(
    { name: "Review", assignees: ["UALICE"] },
    context,
    repo,
    access,
  );
  const firstContext = reply("9.1");
  const first = await updateTask(
    created.task,
    { assignees: ["UALICE", "SFRONTEND"] },
    firstContext,
    repo,
    access,
  );
  assert(first.task.assignmentEvents?.[mutationKey(firstContext)].join() === "SFRONTEND");
  const latest = await resolveTaskForUpdate(undefined, reply("9.2"), repo, access);
  const replay = await updateTask(
    latest,
    { assignees: ["UALICE", "SFRONTEND"] },
    firstContext,
    repo,
    access,
  );
  assert(
    !replay.updated &&
      replay.task.assignmentEvents?.[mutationKey(firstContext)].join() === "SFRONTEND",
  );
  const nextContext = reply("9.3");
  const next = await updateTask(
    replay.task,
    { assignees: ["UALICE", "SFRONTEND"] },
    nextContext,
    repo,
    access,
  );
  assert(next.task.assignmentEvents?.[mutationKey(nextContext)].length === 0);
  assert(next.task.assignmentEvents?.[mutationKey(context)].join() === "UALICE");
});

Deno.test("assigning all replaces specifics and assigning specific people or teams replaces all", async () => {
  const repo = new MemoryTaskRepository();
  const created = await createTask(
    { name: "Share", assignees: ["UALICE"] },
    context,
    repo,
    access,
  );
  const shared = await updateTask(
    created.task,
    { assignees: ["all"] },
    reply("9.1"),
    repo,
    access,
  );
  assert(shared.task.assignees.join() === "all" && shared.task.teams.join() === "all");
  const delegated = await updateTask(
    shared.task,
    { assignees: ["SBACKEND"] },
    reply("9.2"),
    repo,
    access,
  );
  assert(delegated.task.assignees.join() === "SBACKEND");
  const selfAssigned = await updateTask(
    delegated.task,
    { assignees: [] },
    reply("9.3"),
    repo,
    access,
  );
  assert(selfAssigned.task.assignees.join() === "SBACKEND,UCREATOR");
});

Deno.test("team members can update while strangers cannot resolve or mutate the task", async () => {
  const repo = new MemoryTaskRepository();
  const created = await createTask(
    { name: "Team task", assignees: ["SBACKEND"] },
    context,
    repo,
    access,
  );
  const member = { userId: "UMEMBER", teamIds: ["SBACKEND"] };
  const updated = await updateTask(
    created.task,
    { priority: 2 },
    reply("9.1", member.userId),
    repo,
    member,
  );
  assert(updated.task.priority === 2);
  const writes = repo.writes;
  const stranger = { userId: "USTRANGER", teamIds: [] };
  for (const number of [undefined, created.task.number]) {
    const error = await rejection(() =>
      resolveTaskForUpdate(number, reply("9.2", stranger.userId), repo, stranger)
    );
    assert(error instanceof TaskCommandError && !error.message.includes("Team task"));
  }
  const denied = await rejection(() =>
    updateTask(
      updated.task,
      { completed: true },
      reply("9.3", stranger.userId),
      repo,
      stranger,
    )
  );
  assert(denied instanceof TaskAccessError && repo.writes === writes);
  const mismatch = await rejection(() =>
    updateTask(
      updated.task,
      { completed: true },
      reply("9.4", member.userId),
      repo,
      access,
    )
  );
  assert(mismatch instanceof TaskAccessError && repo.writes === writes);
  assert(!repo.rows.get(created.task.id)?.completed);
});

Deno.test("invalid combined updates do not save or mutate any otherwise valid fields", async () => {
  const repo = new MemoryTaskRepository();
  const created = await createTask(input, context, repo, access);
  const saved = JSON.stringify(repo.rows.get(created.task.id));
  const writes = repo.writes;
  const invalidPatches: TaskPatch[] = [
    {
      assignees: ["UALICE"],
      links: ["javascript:alert(1)"],
      description: "Extra details",
      completed: true,
      dueDate: null,
      priority: 1,
    },
    {
      links: ["https://example.com/valid"],
      description: "x".repeat(2000),
      completed: true,
    },
    { assignees: ["all", "UALICE"], description: "Extra details", priority: 1 },
    { priority: 1, dueDate: "2026-02-30", completed: true },
  ];
  for (const [index, patch] of invalidPatches.entries()) {
    const error = await rejection(() =>
      updateTask(created.task, patch, reply(`9.${index + 1}`), repo, access)
    );
    assert(error instanceof TaskCommandError);
    assert(
      repo.writes === writes && JSON.stringify(repo.rows.get(created.task.id)) === saved,
    );
    assert(
      JSON.stringify(created.task) === saved,
      "Rejected updates must not mutate the caller's task",
    );
  }
});

Deno.test("unassigned tasks stay private to their creator until an explicit assignment", async () => {
  const repo = new MemoryTaskRepository();
  const created = await createTask({ name: "Draft" }, context, repo, access);
  assert((await listTasks({ kind: "all" }, access, repo)).length === 1);
  assert(
    (await listTasks({ kind: "all" }, { userId: "UALICE", teamIds: ["SFRONTEND"] }, repo))
      .length === 0,
  );
  const assigned = await updateTask(
    created.task,
    { assignees: [] },
    reply("9.1"),
    repo,
    access,
  );
  assert(assigned.task.assignees.join() === "UCREATOR");
  assert(
    assigned.task.assignmentEvents?.[mutationKey(reply("9.1"))].join() === "UCREATOR",
  );
});

Deno.test("task deletion hides the task and creation replay cannot resurrect it", async () => {
  const repo = new MemoryTaskRepository();
  const created = await createTask({ name: "Draft" }, context, repo, access);
  await deleteTask(created.task, reply("9.1"), repo, access);
  assert(repo.rows.get(created.task.id)?.deleted === true);
  assert((await listTasks({ kind: "all" }, access, repo)).length === 0);
  assert((await repo.findInThread(context.channelId, context.messageTs)).length === 0);
  for (const number of [undefined, created.task.number]) {
    assert(
      await rejection(() =>
        resolveTaskForUpdate(number, reply("9.2"), repo, access)
      ) instanceof
        TaskCommandError,
    );
  }
  const writes = repo.writes;
  const error = await rejection(() =>
    createTask({ name: "Draft" }, context, repo, access)
  );
  assert(error instanceof TaskCommandError && /deleted/.test(error.message));
  assert(repo.writes === writes && repo.rows.get(created.task.id)?.deleted === true);
  const replacement = await createTask({ name: "Draft" }, reply("9.3"), repo, access);
  assert(replacement.created && replacement.task.id !== created.task.id);
});

Deno.test("only the creator or current assignees can delete a task", async () => {
  const repo = new MemoryTaskRepository();
  const created = await createTask(
    { name: "Team task", assignees: ["UALICE", "SBACKEND"] },
    context,
    repo,
    access,
  );
  const writes = repo.writes;
  const stranger = { userId: "USTRANGER", teamIds: [] };
  const formerMember = { userId: "UMEMBER", teamIds: [] };
  for (const deniedAccess of [stranger, formerMember]) {
    assert(
      await rejection(() =>
        deleteTask(
          created.task,
          reply("9.1", deniedAccess.userId),
          repo,
          deniedAccess,
        )
      ) instanceof TaskAccessError,
    );
  }
  assert(
    await rejection(() =>
      deleteTask(created.task, reply("9.1", "UALICE"), repo, access)
    ) instanceof TaskAccessError,
  );
  assert(repo.writes === writes && !repo.rows.get(created.task.id)?.deleted);
  await deleteTask(
    created.task,
    reply("9.2", "UALICE"),
    repo,
    { userId: "UALICE", teamIds: [] },
  );
  assert(repo.rows.get(created.task.id)?.deleted === true);

  const teamTask = await createTask(
    { name: "Another team task", assignees: ["SBACKEND"] },
    { ...context, messageTs: "10.1" },
    repo,
    access,
  );
  await deleteTask(
    teamTask.task,
    reply("10.2", "UMEMBER"),
    repo,
    { userId: "UMEMBER", teamIds: ["SBACKEND"] },
  );
  assert(repo.rows.get(teamTask.task.id)?.deleted === true);
});

Deno.test("failed deletion remains a failure and leaves the task available", async () => {
  const repo = new MemoryTaskRepository();
  const created = await createTask({ name: "Keep" }, context, repo, access);
  repo.delete = () => Promise.reject(new Error("unavailable"));
  await rejection(() => deleteTask(created.task, reply("9.1"), repo, access));
  assert((await listTasks({ kind: "all" }, access, repo)).length === 1);
  assert(!repo.rows.get(created.task.id)?.deleted);
});

Deno.test("combined task filters OR assignment targets and AND date and priority", async () => {
  const repo = new MemoryTaskRepository();
  const cases = [
    { name: "Mine", assignees: ["UCREATOR"], completed: true },
    { name: "Frontend", assignees: ["SFRONTEND"] },
    { name: "Backend", assignees: ["SBACKEND"] },
    { name: "Alice", assignees: ["UALICE"] },
    { name: "Lower priority", assignees: ["UCREATOR"], priority: 2 as const },
    { name: "Later", assignees: ["UCREATOR"], dueDate: "2026-11-05" },
    { name: "Unassigned", assignees: [] },
    { name: "Everyone", assignees: ["all"] },
  ];
  for (const [index, draft] of cases.entries()) {
    await createTask(
      { ...input, priority: 1, dueDate: "2026-11-04", ...draft },
      { ...context, messageTs: `9.${index + 1}` },
      repo,
      access,
    );
  }
  const names = async (query: TaskQuery) =>
    (await listTasks(query, access, repo)).map((task) => task.name).sort().join();
  assert(
    await names({
      kind: "filters",
      targets: [{ kind: "me" }, { kind: "user", userId: "UALICE" }],
      priority: 1,
      dueDate: "2026-11-04",
    }) === "Alice,Mine",
  );
  assert(
    await names({ kind: "filters", targets: [{ kind: "me" }] }) ===
      "Later,Lower priority,Mine",
  );
  assert(
    await names({ kind: "filters", targets: [{ kind: "my-teams" }] }) === "Frontend",
  );
  assert(
    await names({
      kind: "filters",
      targets: [{ kind: "my-teams" }, { kind: "team", teamId: "SBACKEND" }],
    }) === "Backend,Frontend",
  );
  assert(
    await names({ kind: "filters", targets: [{ kind: "team", teamId: "all" }] }) ===
      "Everyone",
  );
  assert((await listTasks({ kind: "filters" }, access, repo)).length === cases.length);
  assert(
    (await listTasks({ kind: "filters", targets: [] }, access, repo)).length ===
      cases.length,
  );
});

Deno.test("soon filters use London calendar days with inclusive bounds across clock and year changes", async () => {
  const scenarios = [
    {
      now: "2026-06-30T23:30:00Z",
      before: "2026-06-30",
      start: "2026-07-01",
      end: "2026-07-04",
      after: "2026-07-05",
    },
    {
      now: "2026-03-28T23:30:00Z",
      before: "2026-03-27",
      start: "2026-03-28",
      end: "2026-03-31",
      after: "2026-04-01",
    },
    {
      now: "2026-10-31T23:30:00Z",
      before: "2026-10-30",
      start: "2026-10-31",
      end: "2026-11-03",
      after: "2026-11-04",
    },
    {
      now: "2026-12-31T23:30:00Z",
      before: "2026-12-30",
      start: "2026-12-31",
      end: "2027-01-03",
      after: "2027-01-04",
    },
  ];
  for (const scenario of scenarios) {
    const repo = new MemoryTaskRepository();
    const dates = [scenario.before, scenario.start, scenario.end, scenario.after, null];
    for (const [index, dueDate] of dates.entries()) {
      await createTask(
        {
          name: `Due ${index}`,
          assignees: ["UCREATOR"],
          dueDate,
          priority: 1,
          completed: index === 2,
        },
        { ...context, messageTs: `9.${index + 1}` },
        repo,
        access,
      );
    }
    const tasks = await listTasks(
      { kind: "filters", soon: true },
      access,
      repo,
      new Date(scenario.now),
    );
    assert(
      tasks.map((task) => task.dueDate).join() === `${scenario.start},${scenario.end}`,
      `Wrong calendar window at ${scenario.now}`,
    );
    assert(tasks[1].completed, "Completion is independent from the soon date filter.");
    const combined = await listTasks(
      { kind: "filters", soon: true, dueDate: scenario.end, priority: 1 },
      access,
      repo,
      new Date(scenario.now),
    );
    assert(combined.length === 1 && combined[0].dueDate === scenario.end);
    assert(
      (await listTasks(
        { kind: "filters", soon: true, dueDate: scenario.after },
        access,
        repo,
        new Date(scenario.now),
      )).length === 0,
    );
  }
});
