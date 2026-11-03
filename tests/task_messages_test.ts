import type { Task } from "../delebot/tasks/models.ts";
import {
  formatTask,
  formatTaskList,
  GREETING,
  splitPrivateReply,
  splitTaskReply,
} from "../delebot/slack/messages.ts";

Deno.test("private channel replies preserve Unicode and obey Slack's byte budget", () => {
  const link = "<https://example.com/review>";
  const text = "🧹".repeat(2000) + "\n" + link + "\n" + "&amp;".repeat(1500);
  const parts = splitPrivateReply(text);
  assert(parts.length > 1 && parts.join("") === text);
  assert(parts.every((part) => new TextEncoder().encode(part).length <= 3800));
  assert(parts.some((part) => part.includes(link)));
});

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "CTEST:10.1",
    number: 5,
    name: "Clean PRs",
    links: ["https://example.com/review"],
    assignees: ["UJAMES", "UALICE"],
    teams: ["SFRONTEND"],
    description: "Review and merge ready pull requests.",
    dueDate: "2026-11-06",
    priority: 2,
    createdBy: "UCREATOR",
    createdAt: "2026-11-03T12:00:00Z",
    channelId: "CTEST",
    messageTs: "10.1",
    threadTs: "10.1",
    status: "open",
    completed: false,
    assignmentBased: false,
    ...overrides,
  };
}

Deno.test("task detail includes the number and each requested task field", () => {
  const text = formatTask(task());
  for (
    const value of [
      "Task #5: Clean PRs",
      "Team SFRONTEND",
      "*Completed:* No",
      "<@UJAMES>, <@UALICE>",
      "Review and merge ready pull requests.",
      "06/11/2026",
      "*Priority:* 2\n",
      "<https://example.com/review>",
      "<@UCREATOR>",
    ]
  ) assert(text.includes(value), `Missing task detail: ${value}`);
  assert(!text.includes("/5") && !text.includes("is highest"));
  assert(!text.includes("Link 1"));
});

Deno.test("user text cannot inject Slack mentions or links into task replies", () => {
  const malicious = task({
    name: "Help <!channel> & <@UOTHER>",
    description: "<!here> <https://evil.example|click>",
    links: ["https://example.com/?q=hello|there&x=<foo>"],
  });
  for (const text of [formatTask(malicious), ...formatTaskList([malicious])]) {
    assert(!text.includes("<!channel>"));
    assert(!text.includes("<!here>"));
    assert(!text.includes("<@UOTHER>"));
    assert(text.includes("&lt;!channel&gt; &amp; &lt;@UOTHER&gt;"));
  }
  const detail = formatTask(malicious);
  assert(detail.includes("hello%7Cthere&amp;x=%3Cfoo%3E>"));
});

Deno.test("task lists contain complete fields for every task separated by blank lines", () => {
  const first = task();
  const second = task({
    number: 6,
    name: "Release",
    description: "Ship the reviewed work.",
  });
  const text = formatTaskList([first, second]).join("\n");
  assert(text.startsWith("*Tasks (2)*\n\n"));
  assert(text.includes(formatTask(first) + "\n\n" + formatTask(second)));
  for (
    const field of [
      "Assignees",
      "Description",
      "Due",
      "Priority",
      "Completed",
      "Links",
      "Created by",
    ]
  ) {
    assert(text.split(`*${field}:*`).length === 3, `Missing full list field: ${field}`);
  }
  assert(text.includes("<https://example.com/review>"));
  assert(!text.includes("/5") && !text.includes("Link 1"));
  assert(formatTaskList([])[0] === "No tasks found.");
});

Deno.test("team handles render as plain text without notifying user groups", () => {
  const item = task({ teams: ["SFRONTEND", "SBACKEND"] });
  const names = { SFRONTEND: "frontend", SBACKEND: "@backend" };
  for (const text of [formatTask(item, names), ...formatTaskList([item], names)]) {
    assert(text.includes("@frontend, @backend"));
    assert(!text.includes("<!subteam^"));
  }
  const malicious = { SFRONTEND: "<!channel>" };
  assert(formatTask(item, malicious).includes("@&lt;!channel&gt;"));
  assert(!formatTask(item, malicious).includes("<!channel>"));
});

Deno.test("all-team and legacy tasks have explicit visibility labels", () => {
  assert(formatTask(task({ teams: ["all"] })).includes("*Assignees:* Everyone"));
  assert(formatTaskList([task({ teams: ["all"] })])[0].includes("*Assignees:* Everyone"));
  assert(formatTask(task({ teams: [] })).includes("<@UJAMES>"));
});

Deno.test("new tasks display mixed assignees and completed without a separate teams field", () => {
  const item = task({
    assignmentBased: true,
    assignees: ["UJAMES", "SFRONTEND"],
    teams: ["SFRONTEND"],
    completed: true,
    status: "completed",
  });
  const details = formatTask(item, { SFRONTEND: "frontend" });
  assert(details.includes("*Assignees:* <@UJAMES>, @frontend"));
  assert(details.includes("*Completed:* Yes") && !details.includes("*Teams:*"));
  const list = formatTaskList([item], { SFRONTEND: "frontend" }).join("\n");
  assert(list.includes("*Completed:* Yes") && list.includes("@frontend"));
});

Deno.test("large task lists are split without dropping or duplicating tasks", () => {
  const tasks = Array.from(
    { length: 250 },
    (_, index) => task({ number: index + 1, name: `Task-name-${index + 1}-end` }),
  );
  const replies = formatTaskList(tasks);
  assert(replies.length > 1);
  assert(replies.every((reply) => reply.length <= 35000));
  const text = replies.join("\n");
  for (const item of tasks) {
    assert(text.split(`Task-name-${item.number}-end`).length === 2);
  }
});

Deno.test("an oversized individual row is split without losing its text", () => {
  const name = "🧹".repeat(20000);
  const replies = formatTaskList([task({ name })]);
  assert(replies.length > 1 && replies.every((reply) => reply.length <= 35000));
  assert(replies.join("").includes(name));
});

Deno.test("long escaped details are split while every Slack link remains intact", () => {
  const links = Array.from({ length: 10 }, (_, index) => {
    const prefix = `https://example.com/${index}?q=`;
    return prefix + "&".repeat(1000 - prefix.length);
  });
  const details = formatTask(task({ links, description: "&".repeat(2000) }));
  assert(details.length > 40000);
  const replies = splitTaskReply(details);
  assert(replies.length > 1);
  assert(replies.every((reply) => reply.length <= 35000));
  assert(replies.join("\n") === details, "All task details must survive splitting");
  for (const token of details.matchAll(/<https:[^>]+>/g)) {
    assert(replies.filter((reply) => reply.includes(token[0])).length === 1);
    assert(
      formatTaskList([task({ links })]).filter((reply) => reply.includes(token[0]))
        .length === 1,
    );
  }
  assert([...details.matchAll(/<https:[^>]+>/g)].length === 10);
});

Deno.test("new tasks display all optional fields as unset", () => {
  const text = formatTask(
    task({
      description: "",
      priority: null,
      dueDate: null,
      links: [],
      assignees: [],
      assignmentBased: true,
    }),
  );
  assert(text.includes("*Description:* Not set"));
  assert(text.includes("*Due:* Not set"));
  assert(text.includes("*Priority:* Not set"));
  assert(text.includes("*Links:* None"));
  assert(text.includes("*Assignees:* Unassigned"));
  assert(
    formatTaskList([task({ assignees: [], assignmentBased: true })])[0].includes(
      "*Assignees:* Unassigned",
    ),
  );
  assert(!text.includes("null") && !text.includes("undefined"));
});

Deno.test("help explains named fields, thread updates, completion and repeated links", () => {
  for (
    const command of [
      "@DeleBot task Name",
      "assign @person @team",
      "describe text",
      "descibe",
      "p 1",
      "due 6/11/26",
      "link https://example.com",
      "@DeleBot done",
      "@DeleBot 123 done",
      "work done",
      "New tasks are unassigned",
      "@DeleBot ls",
      "ls me",
      "ls @person",
      "ls @team",
      "ls team",
      "ls soon",
      "ls 6/11/26",
      "ls 1",
      "ls 1 soon",
      "ls @alice soon",
      "arrive by DM",
      "@DeleBot delete",
      "@DeleBot 123 delete",
      "double quotes",
      "New assignees receive a DM",
      "Numbers are automatic and non-consecutive",
    ]
  ) assert(GREETING.includes(command), `Missing help: ${command}`);
  assert(!GREETING.includes("urgency"));
});
