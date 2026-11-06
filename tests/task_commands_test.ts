import {
  formatDueDate,
  parseDueDate,
  parseTaskCommand,
} from "../delebot/tasks/commands.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual));
}
function invalid(text: string, contains?: string) {
  const command = parseTaskCommand(text);
  assert(command.kind === "error", `Expected error for ${text}`);
  assert(command.message.includes("*Create:*"));
  if (contains) assert(command.message.includes(contains), command.message);
}

Deno.test("creation needs only a task name, with quoted and parenthesized names supported", () => {
  equal(parseTaskCommand("task Clean PRs"), {
    kind: "create",
    name: "Clean PRs",
    patch: {},
  });
  equal(parseTaskCommand('task "Review due dates"'), {
    kind: "create",
    name: "Review due dates",
    patch: {},
  });
  equal(parseTaskCommand("task (Review due dates)"), {
    kind: "create",
    name: "Review due dates",
    patch: {},
  });
  equal(parseTaskCommand("task (Feature (phase 1)) p 2"), {
    kind: "create",
    name: "Feature (phase 1)",
    patch: { priority: 2 },
  });
  for (
    const text of [
      "task",
      'task ""',
      "task ()",
      "task assign <@UJAMES>",
      "task p 1",
      "task done",
    ]
  ) invalid(text, "name");
});

Deno.test("all task fields can be supplied in one creation command in any order", () => {
  equal(
    parseTaskCommand(
      'task "Clean PRs" link <https://example.com/pr/5|Review> assign <@UJAMES>, <!subteam^SFRONTEND|@frontend> describe "Review open pull requests" due 6/11/26 p 1',
    ),
    {
      kind: "create",
      name: "Clean PRs",
      patch: {
        links: ["https://example.com/pr/5"],
        assignees: ["UJAMES", "SFRONTEND"],
        description: "Review open pull requests",
        dueDate: "2026-11-06",
        priority: 1,
      },
    },
  );
});

Deno.test("thread updates contain no task number and combine multiple field operations", () => {
  equal(
    parseTaskCommand(
      'assign <@UJAMES> p 2 due 10/11/26 describe "Add context" link https://example.com done',
    ),
    {
      kind: "update",
      patch: {
        assignees: ["UJAMES"],
        priority: 2,
        dueDate: "2026-11-10",
        description: "Add context",
        links: ["https://example.com"],
        completed: true,
      },
    },
  );
});

Deno.test("explicit task number updates and both completion spellings parse", () => {
  equal(parseTaskCommand("123 done"), {
    kind: "update",
    number: 123,
    patch: { completed: true },
  });
  equal(parseTaskCommand("#123 done"), parseTaskCommand("123 done"));
  equal(parseTaskCommand("(123) done"), parseTaskCommand("123 done"));
  equal(parseTaskCommand("done"), { kind: "update", patch: { completed: true } });
  equal(parseTaskCommand("work done"), { kind: "update", patch: { completed: true } });
  equal(parseTaskCommand("123 work done p 2"), {
    kind: "update",
    number: 123,
    patch: { completed: true, priority: 2 },
  });
  equal(parseTaskCommand("task errands work done"), {
    kind: "create",
    name: "errands",
    patch: { completed: true },
  });
});

Deno.test("deletion is isolated and works in a thread or with a task number", () => {
  equal(parseTaskCommand("delete"), { kind: "delete" });
  for (const command of ["123 delete", "#123 delete", "(123) delete", "123 DELETE"]) {
    equal(parseTaskCommand(command), { kind: "delete", number: 123 });
  }
  for (
    const command of [
      "done delete",
      "123 delete p 1",
      "123 assign <@UJAMES> delete",
      "task Review delete",
      "delete 123",
      "0 delete",
      "9007199254740992 delete",
    ]
  ) invalid(command);
  equal(parseTaskCommand('task "Delete old data" describe "delete old records"'), {
    kind: "create",
    name: "Delete old data",
    patch: { description: "delete old records" },
  });
});

Deno.test("edit replaces named fields atomically in threads and with task numbers", () => {
  equal(parseTaskCommand('edit due 6/11/26 p 1 desc "New text"'), {
    kind: "update",
    patch: { set: { dueDate: "2026-11-06", priority: 1, description: "New text" } },
  });
  equal(
    parseTaskCommand(
      '123 edit name "Review due dates" assign <@UJAMES> links https://a.example link https://b.example completed no',
    ),
    {
      kind: "update",
      number: 123,
      patch: {
        set: {
          name: "Review due dates",
          assignees: ["UJAMES"],
          links: ["https://a.example", "https://b.example"],
          completed: false,
        },
      },
    },
  );
  equal(parseTaskCommand("#123 edit assign - due -"), {
    kind: "update",
    number: 123,
    patch: { set: { assignees: [], dueDate: null } },
  });
  equal(
    parseTaskCommand(
      'link https://a.example edit desc "Replace existing description" priority 2',
    ),
    {
      kind: "update",
      patch: {
        links: ["https://a.example"],
        set: { description: "Replace existing description", priority: 2 },
      },
    },
  );
  equal(parseTaskCommand("edit desc First desc Second p 1 priority 1 done"), {
    kind: "update",
    patch: { set: { description: "First\n\nSecond", priority: 1, completed: true } },
  });
  for (
    const text of [
      "edit",
      "edit name",
      'edit name ""',
      "edit name One name Two",
      "edit p 1 p 2",
      "edit completed maybe",
      "edit completed no done",
      "assign <@UJAMES> edit assign <@UALICE>",
      "link https://a.example edit link https://b.example",
      "edit edit due 6/11/26",
      "task New edit desc Text",
    ]
  ) invalid(text);
});

Deno.test("delete followed by field names clears fields rather than deleting the task", () => {
  equal(parseTaskCommand("delete due p desc"), {
    kind: "update",
    patch: { clear: ["dueDate", "priority", "description"] },
  });
  equal(
    parseTaskCommand("(123) delete links assignees completed viewPerms editPerms links"),
    {
      kind: "update",
      number: 123,
      patch: { clear: ["links", "assignees", "completed", "viewPerms", "editPerms"] },
    },
  );
  equal(parseTaskCommand("delete done"), {
    kind: "update",
    patch: { clear: ["completed"] },
  });
  for (
    const text of [
      "delete name",
      "delete due 6/11/26",
      "delete due p1",
      "delete due edit desc New",
      "delete unknown",
      'delete "due"',
      "task New delete due",
    ]
  ) invalid(text);
});

Deno.test("view and edit permissions accept people, teams or all independently of assignments", () => {
  equal(
    parseTaskCommand("task Review viewPerms <@UJAMES> <!subteam^SALPHA> editPerms all"),
    {
      kind: "create",
      name: "Review",
      patch: { viewPerms: ["UJAMES", "SALPHA"], editPerms: ["all"] },
    },
  );
  equal(
    parseTaskCommand(
      "viewPerms <@UJAMES> viewPerms <!subteam^SALPHA> editPerms <@UALICE>",
    ),
    {
      kind: "update",
      patch: { viewPerms: ["UJAMES", "SALPHA"], editPerms: ["UALICE"] },
    },
  );
  equal(parseTaskCommand("123 edit viewPerms all editPerms <!subteam^SALPHA>"), {
    kind: "update",
    number: 123,
    patch: { set: { viewPerms: ["all"], editPerms: ["SALPHA"] } },
  });
  equal(parseTaskCommand("perms match"), { kind: "update", patch: { matchPerms: true } });
  equal(parseTaskCommand("viewPerms <!subteam^SALPHA> perms match"), {
    kind: "update",
    patch: { viewPerms: ["SALPHA"], matchPerms: true },
  });
  equal(parseTaskCommand("task Review viewPerms <@UJAMES> perms match"), {
    kind: "create",
    name: "Review",
    patch: { viewPerms: ["UJAMES"], matchPerms: true },
  });
  for (
    const text of [
      "viewPerms",
      "editPerms -",
      "viewPerms @james",
      "viewPerms all <@UJAMES>",
      "viewPerms all viewPerms <@UJAMES>",
      "perms",
      "perms all",
      "perms match now",
      "perms match editPerms all",
      "editPerms all perms match",
      "viewPerms all edit viewPerms <@UJAMES>",
      "edit viewPerms <@UJAMES> p 6",
      `viewPerms ${Array.from({ length: 21 }, (_, i) => `<@U${i}>`).join(" ")}`,
    ]
  ) invalid(text);
});

Deno.test("repeat assign and link clauses combine and deduplicate, including Slack links", () => {
  equal(
    parseTaskCommand(
      "assign <@UJAMES> assign <!subteam^SALPHA> <@UJAMES> link https://a.example link <https://b.example?a=1&amp;b=2|Reference . label> link https://a.example",
    ),
    {
      kind: "update",
      patch: {
        assignees: ["UJAMES", "SALPHA"],
        links: ["https://a.example", "https://b.example?a=1&b=2"],
      },
    },
  );
});

Deno.test("repeated descriptions append paragraphs and accept the requested descibe spelling", () => {
  equal(
    parseTaskCommand(
      'descibe "Please assign owners" describe Second paragraph description Third paragraph',
    ),
    {
      kind: "update",
      patch: {
        description: "Please assign owners\n\nSecond paragraph\n\nThird paragraph",
      },
    },
  );
});

Deno.test("quoted keywords are literal text and cannot change a task's fields", () => {
  equal(
    parseTaskCommand(
      'task "Do work done later" describe "assign @person due tomorrow p 1 link anything done"',
    ),
    {
      kind: "create",
      name: "Do work done later",
      patch: { description: "assign @person due tomorrow p 1 link anything done" },
    },
  );
  equal(parseTaskCommand("task “Review due dates” describe “Please assign owners”"), {
    kind: "create",
    name: "Review due dates",
    patch: { description: "Please assign owners" },
  });
});

Deno.test("escaped quotes and apostrophes in ordinary prose are preserved", () => {
  equal(parseTaskCommand('describe "Say \\"hello\\" to James"'), {
    kind: "update",
    patch: { description: 'Say "hello" to James' },
  });
  equal(parseTaskCommand("describe James's review needs attention."), {
    kind: "update",
    patch: { description: "James's review needs attention." },
  });
});

Deno.test("Slack labels and URL contents do not become command boundaries", () => {
  equal(
    parseTaskCommand(
      'task Review assign <!subteam^SALPHA|@due link done> link <https://example.com/assign?due=done&amp;p=2|due p 1> describe "Read. Then review."',
    ),
    {
      kind: "create",
      name: "Review",
      patch: {
        assignees: ["SALPHA"],
        links: ["https://example.com/assign?due=done&p=2"],
        description: "Read. Then review.",
      },
    },
  );
  equal(parseTaskCommand("link https://example.com/a,b?priority=1"), {
    kind: "update",
    patch: { links: ["https://example.com/a,b?priority=1"] },
  });
});

Deno.test("assignment values include users, teams, all, and explicit self assignment", () => {
  equal(parseTaskCommand("assign all"), {
    kind: "update",
    patch: { assignees: ["all"] },
  });
  equal(parseTaskCommand("assign -"), { kind: "update", patch: { assignees: [] } });
  for (
    const text of [
      "assign",
      "assign @james",
      "assign <@UJAMES> all",
      "assign all assign <@UJAMES>",
      "assign <!subteam^S>",
      "assign <@UJAMES> garbage",
      "assign - assign <@UJAMES>",
      "assign <@UJAMES> assign -",
    ]
  ) invalid(text);
});

Deno.test("scalar values are strict and conflicting repeated fields reject the whole command", () => {
  equal(parseTaskCommand("p 1 priority 1 due 6/11/26 due 06/11/2026 done done"), {
    kind: "update",
    patch: { priority: 1, dueDate: "2026-11-06", completed: true },
  });
  equal(parseTaskCommand("due -"), { kind: "update", patch: { dueDate: null } });
  for (
    const text of [
      "p 1 p 2",
      "due 6/11/26 due 7/11/26",
      "due - due 6/11/26",
      "p",
      "p 0",
      "p 6",
      "p 1.0",
      "p 1 trailing",
      "due tomorrow",
      "due 31/11/26",
      "due 6/11/26 trailing",
      "done yes",
      "work done now",
    ]
  ) invalid(text);
});

Deno.test("invalid combined operations never return a partial patch", () => {
  for (
    const text of [
      "assign <@UJAMES> p 6",
      "link https://example.com due 31/11/26",
      "123 done link ftp://example.com",
      "task Review assign <@UJAMES> link https://example.com nonsense",
      "task Review describe text p 1 extra",
    ]
  ) invalid(text);
});

Deno.test("malformed quotes, mentions and wrappers are actionable errors", () => {
  for (
    const text of [
      'task "Unclosed',
      'describe "unclosed',
      'task "Name"assign <@UJAMES>',
      "task (Unclosed",
      "assign <@UJAMES",
      "link <https://example.com",
    ]
  ) invalid(text);
});

Deno.test("legacy dotted creation is rejected rather than becoming a giant task name", () => {
  invalid("task Review . - . <@UJAMES> . Read . 6/11/26 . 2 . no", "old dotted format");
  equal(parseTaskCommand('task "Review . Read"'), {
    kind: "create",
    name: "Review . Read",
    patch: {},
  });
});

Deno.test("numeric references must be safe positive integers with a following operation", () => {
  for (
    const text of ["0 done", "-1 done", "9007199254740992 done", "123", "123 nonsense"]
  ) invalid(text);
});

Deno.test("links require valid HTTP URLs and link clauses cannot swallow junk", () => {
  for (
    const text of [
      "link",
      "link ftp://example.com",
      "link https://",
      "link https://example.com junk",
      'link "https://example.com with spaces"',
      "link <@UJAMES>",
    ]
  ) invalid(text);
  equal(parseTaskCommand("link https://a.example, https://b.example"), {
    kind: "update",
    patch: { links: ["https://a.example", "https://b.example"] },
  });
});

Deno.test("creation and update limits apply after repeated fields are combined", () => {
  for (
    const text of [
      `task ${"x".repeat(201)}`,
      `describe ${"x".repeat(2001)}`,
      `describe ${"x".repeat(1000)} describe ${"y".repeat(1000)}`,
      `link https://example.com/${"x".repeat(1000)}`,
      `link ${
        Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`).join(" ")
      }`,
      `assign ${Array.from({ length: 21 }, (_, i) => `<@U${i}>`).join(" ")}`,
    ]
  ) invalid(text);
});

Deno.test("UK dates validate leap years without timezone conversion", () => {
  equal(parseDueDate("6/11/26"), "2026-11-06");
  equal(parseDueDate("29/2/28"), "2028-02-29");
  equal(formatDueDate("2026-11-06"), "6/11/2026");
  for (const date of ["29/2/26", "31/4/26", "0/11/26", "1/13/26"]) {
    equal(parseDueDate(date), undefined);
  }
});

Deno.test("existing listing commands retain lookups and aliases with personal filter defaults", () => {
  const examples = [
    ["ls tasks", { kind: "all" }],
    ["ls task 5", { kind: "number", number: 5 }],
    ["ls task *Clean PRs*", { kind: "name", name: "Clean PRs" }],
    ["ls tasks <@UJAMES>", { kind: "assignee", userId: "UJAMES" }],
    ["ls tasks <!subteam^SALPHA>", { kind: "team", teamId: "SALPHA" }],
    ["ls tasks priority 1", { kind: "filters", priority: 1, targets: [{ kind: "me" }] }],
    ["ls tasks p 1", { kind: "filters", priority: 1, targets: [{ kind: "me" }] }],
    ["ls tasks urgency 1", { kind: "filters", priority: 1, targets: [{ kind: "me" }] }],
    ["ls tasks due 6/11/26", {
      kind: "filters",
      dueDate: "2026-11-06",
      targets: [{ kind: "me" }],
    }],
    ["ls tasks completed yes", { kind: "completed", completed: true }],
  ] as const;
  for (const [text, query] of examples) {
    equal(parseTaskCommand(text), { kind: "list", query });
  }
  equal(
    parseTaskCommand("tasks ls completed no"),
    parseTaskCommand("ls tasks completed no"),
  );
});

Deno.test("short listing commands select people or teams and bare ls shows all available tasks", () => {
  const cases = [
    ["ls", { kind: "all" }],
    ["ls me", { kind: "filters", targets: [{ kind: "me" }] }],
    ["ls <@UJAMES>", { kind: "filters", targets: [{ kind: "user", userId: "UJAMES" }] }],
    ["ls <!subteam^SALPHA|@Alpha squad>", {
      kind: "filters",
      targets: [{ kind: "team", teamId: "SALPHA" }],
    }],
    ["ls team", { kind: "filters", targets: [{ kind: "my-teams" }] }],
    ["ls teams", { kind: "filters", targets: [{ kind: "my-teams" }] }],
    ["ls team <!subteam^SALPHA>", {
      kind: "filters",
      targets: [{ kind: "team", teamId: "SALPHA" }],
    }],
  ] as const;
  for (const [text, query] of cases) {
    equal(parseTaskCommand(text), { kind: "list", query });
  }
});

Deno.test("priority, exact date and soon short filters default to personal tasks", () => {
  for (
    const text of [
      "ls 1",
      "ls (1)",
      "ls p1",
      "ls p 1",
      "ls priority1",
      "ls priority (1)",
      "tasks ls 1",
    ]
  ) {
    equal(parseTaskCommand(text), {
      kind: "list",
      query: { kind: "filters", priority: 1, targets: [{ kind: "me" }] },
    });
  }
  for (
    const text of [
      "ls 6/11/26",
      "ls (6/11/26)",
      "ls date 6/11/26",
      "ls date (6/11/26)",
      "ls due (06/11/2026)",
    ]
  ) {
    equal(parseTaskCommand(text), {
      kind: "list",
      query: { kind: "filters", dueDate: "2026-11-06", targets: [{ kind: "me" }] },
    });
  }
  equal(parseTaskCommand("ls soon"), {
    kind: "list",
    query: { kind: "filters", soon: true, targets: [{ kind: "me" }] },
  });
});

Deno.test("composable listing filters combine scalars with a union of explicit targets", () => {
  equal(parseTaskCommand("ls <@UFRIEND> soon"), {
    kind: "list",
    query: {
      kind: "filters",
      soon: true,
      targets: [{ kind: "user", userId: "UFRIEND" }],
    },
  });
  equal(parseTaskCommand("ls 1 soon"), {
    kind: "list",
    query: { kind: "filters", priority: 1, soon: true, targets: [{ kind: "me" }] },
  });
  equal(parseTaskCommand("ls me p1"), {
    kind: "list",
    query: { kind: "filters", priority: 1, targets: [{ kind: "me" }] },
  });
  equal(parseTaskCommand("ls team priority 1"), {
    kind: "list",
    query: { kind: "filters", priority: 1, targets: [{ kind: "my-teams" }] },
  });
  equal(
    parseTaskCommand(
      "ls tasks p 1 me <@UJAMES> <!subteam^SALPHA> <@UJAMES> date (6/11/26)",
    ),
    {
      kind: "list",
      query: {
        kind: "filters",
        priority: 1,
        dueDate: "2026-11-06",
        targets: [
          { kind: "me" },
          { kind: "user", userId: "UJAMES" },
          { kind: "team", teamId: "SALPHA" },
        ],
      },
    },
  );
  equal(parseTaskCommand("ls p1 priority 1 date 6/11/26 due 06/11/2026"), {
    kind: "list",
    query: {
      kind: "filters",
      priority: 1,
      dueDate: "2026-11-06",
      targets: [{ kind: "me" }],
    },
  });
  equal(parseTaskCommand("ls (6/11/26) p1"), {
    kind: "list",
    query: {
      kind: "filters",
      dueDate: "2026-11-06",
      priority: 1,
      targets: [{ kind: "me" }],
    },
  });
  equal(parseTaskCommand("ls 1 6/11/26 <@UJAMES>"), {
    kind: "list",
    query: {
      kind: "filters",
      priority: 1,
      dueDate: "2026-11-06",
      targets: [{ kind: "user", userId: "UJAMES" }],
    },
  });
});

Deno.test("conflicting and unknown list tokens reject the complete query", () => {
  for (
    const text of [
      "ls 1 p2",
      "ls date 6/11/26 due 7/11/26",
      "ls soon date 6/11/26",
      "ls date 6/11/26 soon",
      "ls <@UJAMES> soon garbage",
      "ls date tomorrow",
      "ls date 31/11/26",
      "ls date",
      "ls 0",
      "ls (6)",
      "ls p",
      "ls p0",
      "ls p1.0",
      "ls priority 6",
      "ls (1",
      "ls date 6/11/26)",
      'ls "me"',
      "ls <@UJAMES",
      "ls tasks team @frontend soon",
      "ls delete",
      "ls done",
    ]
  ) invalid(text);
});

Deno.test("bad selectors never turn into unfiltered task lists", () => {
  for (
    const text of [
      "ls task",
      "ls task 0",
      "ls task -1",
      "ls task **",
      "ls tasks completed maybe",
      "ls tasks @someone",
      "ls tasks priority 6",
      "ls task 9007199254740992",
    ]
  ) invalid(text);
});

Deno.test("usage commands stay distinct from task creation and thread updates", () => {
  equal(parseTaskCommand("?"), { kind: "help", topic: "general" });
  equal(parseTaskCommand("task ?"), { kind: "help", topic: "create" });
  equal(parseTaskCommand("tasks ls ?"), { kind: "help", topic: "list" });
  equal(parseTaskCommand("hello"), { kind: "unknown" });
});
