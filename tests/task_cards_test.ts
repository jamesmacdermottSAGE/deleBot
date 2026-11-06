import { parseTaskCommand } from "../delebot/tasks/commands.ts";
import { createTask, respondToAssignment, updateTask } from "../delebot/tasks/service.ts";
import { formatTask } from "../delebot/slack/messages.ts";
import { SlackTaskRepository } from "../delebot/tasks/repository.ts";
import { assert, MemoryTaskRepository } from "./task_fixtures.ts";

Deno.test("categorized links can be added, replaced and cleared independently", async () => {
  const repo = new MemoryTaskRepository();
  const access = { userId: "UALICE", teamIds: [] };
  const context = { userId: access.userId, channelId: "DTEST", messageTs: "1.1" };
  const parsed = parseTaskCommand(
    "task Review jira https://jira.example/ABC-1 github https://github.com/a/b link https://example.com",
  );
  assert(parsed.kind === "create");
  const { task } = await createTask(
    { name: parsed.name, ...parsed.patch },
    context,
    repo,
    access,
  );
  const edit = parseTaskCommand(
    "edit jira https://jira.example/ABC-2 github https://github.com/a/c access all",
  );
  assert(edit.kind === "update");
  const { task: next } = await updateTask(
    task,
    edit.patch,
    { ...context, messageTs: "1.2" },
    repo,
    access,
  );
  assert(
    next.jiraLinks?.join() === "https://jira.example/ABC-2" &&
      next.githubLinks?.join() === "https://github.com/a/c",
  );
  assert(next.links.join() === "https://example.com");
  const clear = parseTaskCommand("delete jira github");
  assert(clear.kind === "update");
  const { task: cleared } = await updateTask(
    next,
    clear.patch,
    { ...context, messageTs: "1.3" },
    repo,
    access,
  );
  assert(
    !cleared.jiraLinks?.length && !cleared.githubLinks?.length &&
      cleared.links.length === 1,
  );
});

Deno.test("assignment decisions retain history and delegation repeats the pending cycle", async () => {
  const repo = new MemoryTaskRepository();
  const access = { userId: "UALICE", teamIds: [] };
  const context = { userId: access.userId, channelId: "DTEST", messageTs: "2.1" };
  const { task } = await createTask(
    { name: "Review", assignees: ["UALICE"] },
    context,
    repo,
    access,
  );
  assert(formatTask(task).includes("<@UALICE> ⏳ Pending"));
  const delegated = await respondToAssignment(
    task,
    { kind: "delegate", assignees: ["UBOB"] },
    { ...context, messageTs: "2.2" },
    repo,
    access,
  );
  assert(formatTask(delegated.task).includes("<@UALICE> ↪️ Delegated → <@UBOB>"));
  assert(formatTask(delegated.task).includes("<@UBOB> ⏳ Pending"));
  const rejected = await respondToAssignment(
    delegated.task,
    { kind: "reject" },
    { ...context, userId: "UBOB", messageTs: "2.3" },
    repo,
    { userId: "UBOB", teamIds: [] },
  );
  assert(
    !rejected.task.assignees.includes("UBOB") &&
      formatTask(rejected.task).includes("<@UBOB> ❌ Rejected"),
  );
  const again = await updateTask(
    rejected.task,
    { assignees: ["UBOB"] },
    { ...context, messageTs: "2.4" },
    repo,
    access,
  );
  assert(formatTask(again.task).includes("<@UBOB> ⏳ Pending"));
  assert(parseTaskCommand("delegate <@UBOB>").kind === "response");
  assert(parseTaskCommand("ls<@UALICE>").kind === "list");
});

Deno.test("link categories and assignment responses survive datastore reload", async () => {
  const repo = new MemoryTaskRepository();
  const access = { userId: "UALICE", teamIds: [] };
  const context = { userId: access.userId, channelId: "DTEST", messageTs: "3.1" };
  const { task } = await createTask(
    {
      name: "Persist",
      assignees: ["UALICE"],
      jiraLinks: ["https://jira.example/1"],
      githubLinks: ["https://github.com/a/b"],
    },
    context,
    repo,
    access,
  );
  const accepted = await respondToAssignment(
    task,
    { kind: "accept" },
    { ...context, messageTs: "3.2" },
    repo,
    access,
  );
  let row: Record<string, unknown> = {};
  const stored = new SlackTaskRepository({
    apps: {
      datastore: {
        get: () => Promise.resolve({ ok: true, item: row }),
        put: ({ item }) => {
          row = structuredClone(item);
          return Promise.resolve({ ok: true });
        },
        query: () => Promise.resolve({ ok: true, items: [row] }),
      },
    },
  });
  await stored.save(accepted.task);
  const restored = await stored.findById(task.id);
  assert(restored?.assignmentResponses?.UALICE.status === "accepted");
  const text = formatTask({ ...restored, completed: true });
  assert(
    text.includes("*Jira:*") && text.includes("*GitHub:*") && text.includes("*Access:*"),
  );
  assert(!text.includes("View permissions") && !text.includes("Edit permissions"));
  assert(text.endsWith("*Completed:* ✅\n\n━━━━━━━━━━━━━━━━━━━━"));
});
