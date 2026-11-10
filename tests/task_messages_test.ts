import type { Task } from "../delebot/tasks/models.ts";
import { TASK_CREATE_USAGE } from "../delebot/tasks/commands.ts";
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
      "*Completed:* ",
      "<@UJAMES> ⏳ Pending\n<@UALICE> ⏳ Pending",
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

Deno.test("delegations render as a single chain with each recipient's current status", () => {
  const item = task({
    assignmentBased: true,
    assignees: ["UJAMES"],
    assignmentResponses: {
      UORIGINAL: { status: "delegated", delegatedTo: ["UMIDDLE"] },
      UMIDDLE: { status: "delegated", delegatedTo: ["UJAMES"] },
      UJAMES: { status: "pending" },
    },
  });
  const text = formatTask(item);
  assert(
    text.includes(
      "<@UORIGINAL> ↪️ Delegated → <@UMIDDLE> ↪️ Delegated → <@UJAMES> ⏳ Pending",
    ),
  );
  assert(text.split("<@UJAMES>").length === 2, "Recipient should appear once");
  item.assignmentResponses!.UJAMES = { status: "accepted" };
  assert(formatTask(item).includes("→ <@UJAMES> ✅"));
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
      "Access",
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
    assert(text.includes("@frontend ⏳ Pending\n@backend ⏳ Pending"));
    assert(!text.includes("<!subteam^"));
  }
  const malicious = { SFRONTEND: "<!channel>" };
  assert(formatTask(item, malicious).includes("@&lt;!channel&gt;"));
  assert(!formatTask(item, malicious).includes("<!channel>"));
});

Deno.test("all-team and legacy tasks have explicit visibility labels", () => {
  assert(formatTask(task({ teams: ["all"] })).includes("*Assignees:* All"));
  assert(formatTaskList([task({ teams: ["all"] })])[0].includes("*Assignees:* All"));
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
  assert(details.includes("*Assignees:* <@UJAMES> ⏳ Pending\n@frontend ⏳ Pending"));
  assert(details.includes("*Completed:* ✅") && !details.includes("*Teams:*"));
  const list = formatTaskList([item], { SFRONTEND: "frontend" }).join("\n");
  assert(list.includes("*Completed:* ✅") && list.includes("@frontend"));
});

Deno.test("task details distinguish explicit permission policies from legacy access", () => {
  const text = formatTask(
    task({ viewPerms: ["UJAMES", "SFRONTEND"], editPerms: ["all"] }),
    { SFRONTEND: "frontend" },
  );
  assert(!text.includes("View permissions"));
  assert(text.includes("*Access:* All"));
  assert(!text.includes("<!subteam^"));
  const legacy = formatTask(task());
  assert(!legacy.includes("View permissions"));
  assert(legacy.includes("*Access:* Existing task access"));
  assert(
    formatTask(task({ viewPerms: [], editPerms: [] })).includes(
      "*Access:* Nobody",
    ),
  );
  const escaped = formatTask(task({ editPerms: ["SFRONTEND"] }), {
    SFRONTEND: "<!channel>",
  });
  assert(escaped.includes("@&lt;!channel&gt;") && !escaped.includes("<!channel>"));
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
  assert(text.includes("*Description:* "));
  assert(text.includes("*Due:* "));
  assert(text.includes("*Priority:* "));
  assert(text.includes("*Links:* "));
  assert(text.includes("*Assignees:* "));
  assert(
    formatTaskList([task({ assignees: [], assignmentBased: true })])[0].includes(
      "*Assignees:* ",
    ),
  );
  assert(!text.includes("null") && !text.includes("undefined"));
});

Deno.test("task help explains fields, thread updates, completion and delegation", () => {
  for (
    const command of [
      "task Name",
      "assign @person @team",
      "p 1",
      "due 6/11/26",
      "jira https://",
      "github https://",
      "access @person @team",
      "edit completed no",
      "delete due p desc",
      "delegate @person",
      "ls me",
      "ls @person",
      "separate DM message",
      "⏳ pending",
      "❌ rejected",
      "↪️ delegated",
      "non-consecutive",
    ]
  ) {
    assert(
      TASK_CREATE_USAGE.includes(command.replaceAll("@DeleBot ", "")),
      `Missing help: ${command}`,
    );
  }
  assert(!GREETING.includes("urgency"));
});

Deno.test("general help is brief and introduces task creation and listing", () => {
  assert(GREETING.length < 1000);
  for (const command of ["task Name", "ls me", "task ?", "ls ?", "delegate @person"]) {
    assert(GREETING.includes(command), `Missing brief help: ${command}`);
  }
  assert(GREETING.includes("direct and team assignments"));
});
