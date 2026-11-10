import { TasksDatastore } from "../delebot/db.ts";
import { taskNumber } from "../delebot/tasks/service.ts";
import { canAccessTask } from "../delebot/tasks/access.ts";
import type { Task, TaskAccess } from "../delebot/tasks/models.ts";
import {
  type DatastoreClient,
  SlackTaskRepository,
} from "../delebot/tasks/repository.ts";

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejects(action: () => Promise<unknown>, expected: string) {
  try {
    await action();
  } catch (error) {
    assert(error instanceof Error && error.message.includes(expected));
    return;
  }
  throw new Error(`Expected an error containing ${expected}`);
}

const access: TaskAccess = { userId: "UJAMES", teamIds: ["SFRONTEND"] };

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "CTEST:1793700000.000001",
    number: 5,
    name: "Clean PRs",
    links: ["https://example.com/review"],
    assignees: ["UJAMES", "UOTHER"],
    description: "Review the outstanding changes.",
    dueDate: "2026-11-06",
    priority: 2,
    teams: ["SFRONTEND"],
    createdBy: "UJAMES",
    createdAt: "2026-11-03T09:00:00.000Z",
    channelId: "CTEST",
    messageTs: "1793700000.000001",
    threadTs: "1793700000.000001",
    status: "open",
    completed: false,
    assignmentBased: false,
    ...overrides,
  };
}

function fixture() {
  const rows = new Map<string, Record<string, unknown>>();
  const gets: Array<{ datastore: string; id: string }> = [];
  const puts: Array<{ datastore: string; item: Record<string, unknown> }> = [];
  const client: DatastoreClient = {
    apps: {
      datastore: {
        get: (args) => {
          gets.push(args);
          return Promise.resolve({ ok: true, item: rows.get(args.id) ?? {} });
        },
        put: (args) => {
          puts.push(args);
          rows.set(args.item.id as string, structuredClone(args.item));
          return Promise.resolve({ ok: true });
        },
        query: () => Promise.resolve({ ok: true, items: [...rows.values()] }),
      },
    },
  };
  return { rows, gets, puts, client, repository: new SlackTaskRepository(client) };
}

Deno.test("assignment return paths persist and invalid return metadata is rejected", async () => {
  const { repository, rows } = fixture();
  const item = task({
    assignmentResponses: {
      UOTHER: { status: "pending", returnTo: ["UALICE", "UJAMES"], returnedBy: "UBOB" },
    },
  });
  await repository.save(item);
  const restored = await repository.findById(item.id);
  assert(restored?.assignmentResponses?.UOTHER.returnTo?.join() === "UALICE,UJAMES");
  assert(restored.assignmentResponses.UOTHER.returnedBy === "UBOB");
  const valid = structuredClone(rows.get(item.id)!);
  for (
    const response of [
      { status: "pending", returnTo: "UJAMES" },
      { status: "pending", returnTo: ["SFRONTEND"] },
      { status: "pending", returnTo: ["UJAMES", "UJAMES"] },
      { status: "pending", returnedBy: "<!channel>" },
    ]
  ) {
    rows.set(item.id, {
      ...valid,
      assignment_responses: JSON.stringify({ UOTHER: response }),
    });
    await rejects(() => repository.findById(item.id), "Invalid assignment responses");
  }
});

Deno.test("team-reference discovery follows empty pages and returns only distinct group IDs", async () => {
  const { repository, client } = fixture();
  client.apps.datastore.query = ({ cursor, expression_values }) => {
    // The live Slack adapter rejects empty values even for attribute_exists.
    assert(Object.keys(expression_values).length > 0);
    return Promise.resolve(
      cursor
        ? {
          ok: true,
          items: [{ teams: ["SFRONTEND", "SBACKEND"] }, { teams: ["all"] }, {
            teams: ["SFRONTEND"],
          }],
        }
        : { ok: true, items: [], next_cursor: "next" },
    );
  };
  assert((await repository.referencedTeamIds()).join() === "SFRONTEND,SBACKEND");
  client.apps.datastore.query = () =>
    Promise.resolve({ ok: false, error: "missing_scope" });
  await rejects(() => repository.referencedTeamIds(), "Cannot read");
});

Deno.test("task persistence maps every field and uses the source message as its key", async () => {
  const { repository, gets, puts } = fixture();
  const original = task();
  await repository.save(original);
  const stored = puts[0];
  assert(stored.datastore === TasksDatastore.name);
  assert(stored.item.id === original.id);
  assert(stored.item.created_by === "UJAMES");
  assert(stored.item.due_date === "2026-11-06");
  assert(JSON.stringify(stored.item.teams) === JSON.stringify(["SFRONTEND"]));
  assert(stored.item.channel_id === "CTEST");
  assert(stored.item.message_ts === original.messageTs);
  assert(!("dueDate" in stored.item));
  const restored = await repository.findBySource(original.channelId, original.messageTs);
  assert(
    JSON.stringify(restored, Object.keys(original).sort()) ===
      JSON.stringify(original, Object.keys(original).sort()),
  );
  assert(gets[0].id === original.id);
});

Deno.test("exact task-number text survives Slack integer rounding across reload and save", async () => {
  const { repository, rows } = fixture();
  const original = task({ number: 4099515726530997 });
  await repository.save(original);
  const row = rows.get(original.id)!;
  row.number = 4099515726531000;
  assert(row.number_text === "4099515726530997");
  const restored = await repository.findById(original.id);
  assert(restored?.number === original.number);
  await repository.save(restored);
  assert((await repository.findById(original.id))?.number === original.number);
});

Deno.test("older rounded hash references recover their deterministic original number", async () => {
  const { repository, rows } = fixture();
  const original = task({ number: await taskNumber(task().channelId, task().messageTs) });
  await repository.save(original);
  const row = rows.get(original.id)!;
  delete row.number_text;
  row.number = Number(original.number.toPrecision(15));
  assert((await repository.findById(original.id))?.number === original.number);
});

Deno.test("mixed assignees and completed tasks round trip without changing legacy datastore types", async () => {
  const { repository, puts } = fixture();
  const item = task({
    assignees: ["UJAMES", "SFRONTEND"],
    teams: ["SFRONTEND"],
    assignmentBased: true,
    completed: true,
    status: "completed",
  });
  await repository.save(item);
  assert(JSON.stringify(puts[0].item.assignees) === JSON.stringify(["UJAMES"]));
  assert(
    JSON.stringify(puts[0].item.assigned_to) === JSON.stringify(["UJAMES", "SFRONTEND"]),
  );
  assert(puts[0].item.completed === true && puts[0].item.assignment_version === 2);
  const restored = await repository.findBySource(item.channelId, item.messageTs);
  assert(restored?.completed && restored.status === "completed");
  assert(restored.assignees.join() === "UJAMES,SFRONTEND");
  assert((await repository.list({ userId: "UJAMES", teamIds: [] })).length === 1);
  assert(
    (await repository.list({ userId: "UOTHER", teamIds: ["SFRONTEND"] })).length === 1,
  );
  assert((await repository.list({ userId: "UNONE", teamIds: [] })).length === 0);
});

Deno.test("legacy rows default completed to false and retain the original team policy", async () => {
  const { repository, rows } = fixture();
  await repository.save(task());
  const row = rows.get(task().id)!;
  delete row.completed;
  const restored = await repository.findBySource(task().channelId, task().messageTs);
  assert(restored?.completed === false && restored.assignmentBased === false);
  assert(restored.teams.join() === "SFRONTEND");
  assert((await repository.list({ userId: "UJAMES", teamIds: [] })).length === 0);
});

Deno.test("corrupt new assignments or completion flags fail closed", async () => {
  const { repository } = fixture();
  for (
    const item of [
      task({ assignmentBased: true, assignees: ["all", "UJAMES"] }),
      task({ assignmentBased: true, assignees: ["UJAMES"], teams: ["all"] }),
      task({ completed: true, status: "open" }),
    ]
  ) await rejects(() => repository.save(item), "invalid");
});

Deno.test("source lookup returns null for Slack's empty not-found item", async () => {
  const { repository, client } = fixture();
  assert(await repository.findBySource("CTEST", "1.1") === null);
  client.apps.datastore.get = () => Promise.resolve({ ok: true });
  assert(await repository.findBySource("CTEST", "1.1") === null);
});

Deno.test("repeated saves target one source row and preserve all task data", async () => {
  const { repository, rows } = fixture();
  await repository.save(task());
  await repository.save(task());
  assert(rows.size === 1);
  assert((await repository.list(access)).length === 1);
});

Deno.test("get, put, and query errors fail without pretending the operation succeeded", async () => {
  const { repository, client } = fixture();
  client.apps.datastore.get = () =>
    Promise.resolve({ ok: false, error: "missing_scope" });
  client.apps.datastore.put = () =>
    Promise.resolve({ ok: false, error: "datastore_error" });
  client.apps.datastore.query = () =>
    Promise.resolve({ ok: false, error: "ratelimited" });
  await rejects(() => repository.findBySource("CTEST", "1.1"), "missing_scope");
  await rejects(() => repository.save(task()), "datastore_error");
  await rejects(() => repository.list(access), "ratelimited");
});

Deno.test("list scopes every page by team access and follows cursors after empty pages", async () => {
  const { repository, client, puts } = fixture();
  await repository.save(task());
  const cursors: Array<string | undefined> = [];
  client.apps.datastore.query = (args) => {
    cursors.push(args.cursor);
    assert(args.datastore === TasksDatastore.name);
    assert(args.expression.includes("contains(#teams, :all)"));
    assert(args.expression.includes("contains(#teams, :team0)"));
    assert(args.expression.includes("attribute_not_exists(#teams)"));
    assert(args.expression_attributes["#teams"] === "teams");
    assert(args.expression_attributes["#creator"] === "created_by");
    assert(args.expression_values[":user"] === "UJAMES");
    assert(args.expression_values[":team0"] === "SFRONTEND");
    assert(args.expression_values[":zero"] === 0);
    if (!args.cursor) {
      return Promise.resolve({ ok: true, items: [], next_cursor: "page2" });
    }
    if (args.cursor === "page2") {
      return Promise.resolve({
        ok: true,
        items: [],
        response_metadata: { next_cursor: "page3" },
      });
    }
    return Promise.resolve({ ok: true, items: [puts[0].item], next_cursor: "" });
  };
  const result = await repository.list(access);
  assert(result.length === 1 && result[0].number === 5);
  assert(JSON.stringify(cursors) === JSON.stringify([undefined, "page2", "page3"]));
});

Deno.test("a failed later query page does not return an incomplete list", async () => {
  const { repository, client, puts } = fixture();
  await repository.save(task());
  client.apps.datastore.query = (args) =>
    Promise.resolve(
      args.cursor
        ? { ok: false, error: "service_unavailable" }
        : { ok: true, items: [puts[0].item], next_cursor: "page2" },
    );
  await rejects(() => repository.list(access), "service_unavailable");
});

Deno.test("corrupt persisted rows are rejected instead of becoming partial tasks", async () => {
  const { repository, client, puts } = fixture();
  await repository.save(task());
  for (
    const change of [
      { name: undefined },
      { links: "https://example.com" },
      { assignees: ["UJAMES", 2] },
      { priority: 0 },
      { priority: 1.5 },
      { number: 0 },
      { due_date: "2026-02-30" },
      { created_at: "invalid" },
      { status: "unknown" },
      { id: "unexpected" },
      { teams: "all" },
      { teams: ["all", "SFRONTEND"] },
      { teams: ["@frontend"] },
      { teams: ["SFRONT-END"] },
    ]
  ) {
    client.apps.datastore.get = () =>
      Promise.resolve({ ok: true, item: { ...puts[0].item, ...change } });
    await rejects(
      () => repository.findBySource("CTEST", task().messageTs),
      "invalid record",
    );
  }
});

Deno.test("invalid tasks are rejected before writing to Slack", async () => {
  const { repository, puts } = fixture();
  await rejects(() => repository.save(task({ number: Number.NaN })), "invalid record");
  assert(puts.length === 0);
});

Deno.test("source lookups reject a valid row from another message", async () => {
  const { repository, client, puts } = fixture();
  await repository.save(task());
  client.apps.datastore.get = () => Promise.resolve({ ok: true, item: puts[0].item });
  await rejects(
    () => repository.findBySource("CANOTHER", task().messageTs),
    "another message",
  );
});

Deno.test("list rejects invalid query responses and repeated cursors", async () => {
  const { repository, client } = fixture();
  client.apps.datastore.query = () => Promise.resolve({ ok: true });
  await rejects(() => repository.list(access), "invalid task list");
  client.apps.datastore.query = () =>
    Promise.resolve({ ok: true, items: [], next_cursor: "same" });
  await rejects(() => repository.list(access), "repeated a pagination cursor");
});

Deno.test("team access spans channels and excludes unrelated teams even when created or assigned by the viewer", async () => {
  const { repository } = fixture();
  await repository.save(task());
  await repository.save(task({
    id: "COTHER:1793700000.000001",
    channelId: "COTHER",
    teams: ["SOTHER", "SFRONTEND"],
  }));
  await repository.save(task({
    id: "CPRIVATE:1793700000.000001",
    channelId: "CPRIVATE",
    teams: ["SOTHER"],
  }));
  const result = await repository.list(access);
  assert(result.length === 2);
  assert(result.some((item) => item.channelId === "COTHER"));
  assert(!result.some((item) => item.channelId === "CPRIVATE"));
});

Deno.test("company-wide teams are visible without a group membership", async () => {
  const { repository } = fixture();
  await repository.save(task({ teams: ["all"] }));
  assert((await repository.list({ userId: "UOTHER", teamIds: [] })).length === 1);
});

Deno.test("legacy rows with missing or empty teams are private to their creator", async () => {
  const { repository, rows, puts } = fixture();
  await repository.save(task());
  const legacy = { ...puts[0].item };
  delete legacy.teams;
  rows.set(task().id, legacy);
  const restored = await repository.findBySource("CTEST", task().messageTs);
  assert(restored?.teams.length === 0);
  assert((await repository.list(access)).length === 1);
  assert(
    (await repository.list({ userId: "UOTHER", teamIds: ["SFRONTEND"] })).length === 0,
  );
  await repository.save(task({ teams: [] }));
  assert((await repository.list(access)).length === 1);
  assert((await repository.list({ userId: "UOTHER", teamIds: [] })).length === 0);
});

Deno.test("team policies fail closed and do not give creators or assignees a group bypass", () => {
  const restricted = task({ teams: ["SOTHER"] });
  assert(!canAccessTask(restricted, access));
  assert(canAccessTask(task({ teams: ["SOTHER", "SFRONTEND"] }), access));
  assert(canAccessTask(task({ teams: ["all"] }), { userId: "UANYONE", teamIds: [] }));
  for (const teams of [null, "all", ["all", "SFRONTEND"], ["SFRONT-END"], [2]]) {
    assert(!canAccessTask({ ...restricted, teams } as Task, access));
  }
});

Deno.test("query values are parameter bindings even for unexpected user input", async () => {
  const { repository, client } = fixture();
  const malicious = { userId: "U' OR 1 = 1", teamIds: ["S' OR 1 = 1", "SFRONTEND"] };
  let called = false;
  client.apps.datastore.query = (args) => {
    called = true;
    assert(!args.expression.includes(malicious.userId));
    assert(!args.expression.includes(malicious.teamIds[0]));
    assert(args.expression_values[":user"] === malicious.userId);
    assert(args.expression_values[":team0"] === malicious.teamIds[0]);
    assert(args.expression_values[":team1"] === "SFRONTEND");
    assert(!("#channel" in args.expression_attributes));
    return Promise.resolve({ ok: true, items: [] });
  };
  await repository.list(malicious);
  assert(called);
});

Deno.test("lists reject malformed team policies instead of publishing their data", async () => {
  const { repository, client, puts } = fixture();
  await repository.save(task());
  client.apps.datastore.query = () =>
    Promise.resolve({
      ok: true,
      items: [{ ...puts[0].item, teams: ["all", "SFRONTEND"] }],
    });
  await rejects(() => repository.list(access), "invalid record");
});

Deno.test("name-only tasks preserve empty fields, thread context, and durable event metadata", async () => {
  const { repository, puts } = fixture();
  const key = task().id;
  const item = task({
    links: [],
    description: "",
    dueDate: null,
    priority: null,
    assignees: ["UOTHER"],
    teams: [],
    assignmentBased: true,
    threadTs: "1793700000.000000",
    appliedEvents: [key, "CTEST:1793700000.000002"],
    assignmentEvents: { [key]: ["UOTHER"], "CTEST:1793700000.000002": [] },
  });
  await repository.save(item);
  assert(puts[0].item.due_date === "");
  assert(!("priority" in puts[0].item) && !("urgency" in puts[0].item));
  const restored = await repository.findBySource(item.channelId, item.messageTs);
  assert(restored?.priority === null && restored.dueDate === null);
  assert(restored.description === "" && restored.threadTs === item.threadTs);
  assert(JSON.stringify(restored.appliedEvents) === JSON.stringify(item.appliedEvents));
  assert(
    JSON.stringify(restored.assignmentEvents) === JSON.stringify(item.assignmentEvents),
  );
  // A creator can continue configuring a task after assigning somebody else.
  assert((await repository.list({ userId: "UJAMES", teamIds: [] })).length === 1);
});

Deno.test("old urgency values migrate to priority and missing thread roots use the source", async () => {
  const { repository, rows, puts } = fixture();
  await repository.save(task());
  const old = { ...puts[0].item };
  delete old.priority;
  delete old.thread_ts;
  rows.set(task().id, old);
  const restored = await repository.findBySource(task().channelId, task().messageTs);
  assert(restored?.priority === 2 && restored.threadTs === task().messageTs);
  await repository.save(restored);
  assert(puts[1].item.priority === 2 && puts[1].item.thread_ts === task().messageTs);
});

Deno.test("thread lookup paginates with bound context and locally excludes other threads", async () => {
  const { repository, client, puts } = fixture();
  await repository.save(task());
  const root = task().messageTs;
  const cursors: Array<string | undefined> = [];
  client.apps.datastore.query = (args) => {
    cursors.push(args.cursor);
    assert(args.expression_attributes["#thread"] === "thread_ts");
    assert(args.expression_attributes["#message"] === "message_ts");
    assert(args.expression_values[":channel"] === "CTEST");
    assert(args.expression_values[":thread"] === root);
    assert(args.expression.includes("attribute_not_exists(#thread)"));
    if (!args.cursor) {
      return Promise.resolve({ ok: true, items: [], next_cursor: "next" });
    }
    const legacy = { ...puts[0].item };
    delete legacy.thread_ts;
    return Promise.resolve({
      ok: true,
      items: [legacy, { ...puts[0].item, thread_ts: "another-thread" }, {
        ...puts[0].item,
        id: `COTHER:${root}`,
        channel_id: "COTHER",
      }],
    });
  };
  const found = await repository.findInThread("CTEST", root);
  assert(found.length === 1 && found[0].id === task().id);
  assert(JSON.stringify(cursors) === JSON.stringify([undefined, "next"]));
});

Deno.test("thread lookup rejects failed pages, invalid results, and repeated cursors", async () => {
  const { repository, client, puts } = fixture();
  await repository.save(task());
  client.apps.datastore.query = (args) =>
    Promise.resolve(
      args.cursor
        ? { ok: false, error: "unavailable" }
        : { ok: true, items: [puts[0].item], next_cursor: "next" },
    );
  await rejects(() => repository.findInThread("CTEST", task().messageTs), "Cannot find");
  client.apps.datastore.query = () => Promise.resolve({ ok: true });
  await rejects(() => repository.findInThread("CTEST", task().messageTs), "Cannot find");
  client.apps.datastore.query = () =>
    Promise.resolve({ ok: true, items: [], next_cursor: "same" });
  await rejects(() => repository.findInThread("CTEST", task().messageTs), "Repeated");
});

Deno.test("corrupt thread and mutation bookkeeping fail before returning task data", async () => {
  const { repository, client, puts } = fixture();
  await repository.save(task());
  for (
    const change of [
      { thread_ts: 42 },
      { thread_ts: "" },
      { applied_events: [42] },
      { assignment_events: "not-json" },
      { assignment_events: JSON.stringify({ event: ["@unknown"] }) },
      { assignment_events: "[]" },
    ]
  ) {
    client.apps.datastore.get = () =>
      Promise.resolve({ ok: true, item: { ...puts[0].item, ...change } });
    let rejected = false;
    try {
      await repository.findBySource("CTEST", task().messageTs);
    } catch {
      rejected = true;
    }
    assert(rejected, `Expected rejection for ${JSON.stringify(change)}`);
  }
});

Deno.test("unassigned tasks persist and remain private to their creator", async () => {
  const { repository, puts } = fixture();
  const item = task({ assignmentBased: true, assignees: [], teams: [] });
  await repository.save(item);
  assert(
    Array.isArray(puts[0].item.assigned_to) && puts[0].item.assigned_to.length === 0,
  );
  const restored = await repository.findBySource(item.channelId, item.messageTs);
  assert(restored?.assignees.length === 0);
  assert((await repository.list(access)).length === 1);
  assert((await repository.list({ userId: "UOTHER", teamIds: [] })).length === 0);
});

Deno.test("deletion hides a task while retaining its source to prevent replay resurrection", async () => {
  const { repository, rows, puts, client } = fixture();
  const item = task({ assignmentBased: true, assignees: ["SFRONTEND"] });
  await repository.save(item);
  await repository.delete(item);
  assert(rows.size === 1 && puts[1].item.deleted === true);
  assert(!item.deleted, "Deletion must not mutate caller data before saving succeeds");
  assert(
    (await repository.findBySource(item.channelId, item.messageTs))?.deleted === true,
  );
  assert((await repository.list(access)).length === 0);
  assert((await repository.findInThread(item.channelId, item.threadTs)).length === 0);
  assert((await repository.referencedTeamIds()).length === 0);
  client.apps.datastore.put = () => Promise.resolve({ ok: false, error: "unavailable" });
  await rejects(() => repository.delete(item), "unavailable");
});

Deno.test("corrupt deletion flags cannot be read or saved", async () => {
  const { repository, puts, client } = fixture();
  await repository.save(task());
  client.apps.datastore.get = () =>
    Promise.resolve({
      ok: true,
      item: { ...puts[0].item, deleted: "true" },
    });
  await rejects(
    () => repository.findBySource(task().channelId, task().messageTs),
    "invalid record",
  );
  assert(
    !canAccessTask({
      ...task(),
      assignmentBased: true,
      assignees: [],
      teams: [],
      deleted: true,
    }, access),
  );
});

Deno.test("explicit task permissions round trip and override creator and assignment visibility", async () => {
  const { repository, puts } = fixture();
  const item = task({
    assignmentBased: true,
    assignees: ["UJAMES"],
    teams: [],
    viewPerms: ["UOTHER", "SBACKEND"],
    editPerms: ["UOTHER"],
  });
  await repository.save(item);
  assert(JSON.stringify(puts[0].item.view_perms) === JSON.stringify(item.viewPerms));
  assert(JSON.stringify(puts[0].item.edit_perms) === JSON.stringify(item.editPerms));
  const restored = await repository.findById(item.id);
  assert(restored?.viewPerms?.join() === "UOTHER,SBACKEND");
  assert(restored.editPerms?.join() === "UOTHER");
  assert(
    (await repository.list(access)).length === 0,
    "Creator and assignee cannot bypass view permissions",
  );
  assert((await repository.list({ userId: "UOTHER", teamIds: [] })).length === 1);
  assert(
    (await repository.list({ userId: "UMEMBER", teamIds: ["SBACKEND"] })).length === 1,
  );
});

Deno.test("all and empty view permissions are independent of task assignments", async () => {
  const { repository } = fixture();
  await repository.save(
    task({
      assignmentBased: true,
      assignees: [],
      teams: [],
      viewPerms: ["all"],
      editPerms: ["all"],
    }),
  );
  assert((await repository.list({ userId: "UANYONE", teamIds: [] })).length === 1);
  await repository.save(
    task({
      assignmentBased: true,
      assignees: ["UJAMES"],
      teams: [],
      viewPerms: [],
      editPerms: ["all"],
    }),
  );
  assert((await repository.list(access)).length === 0);
});

Deno.test("permission-only teams are discovered across metadata pages", async () => {
  const { repository, client } = fixture();
  client.apps.datastore.query = (args) => {
    assert(args.expression_attributes["#view"] === "view_perms");
    assert(args.expression_attributes["#edit"] === "edit_perms");
    return Promise.resolve(
      args.cursor
        ? {
          ok: true,
          items: [{ view_perms: ["SVIEW", "UOTHER"], edit_perms: ["SEDIT"] }, {
            teams: ["SASSIGN"],
            view_perms: ["SVIEW"],
          }, { deleted: true, view_perms: ["SDELETED"] }],
        }
        : { ok: true, items: [], next_cursor: "next" },
    );
  };
  assert((await repository.referencedTeamIds()).join() === "SVIEW,SEDIT,SASSIGN");
});

Deno.test("invalid stored permissions fail closed rather than falling back to assignments", async () => {
  const { repository, client, puts } = fixture();
  await repository.save(task());
  for (const value of ["all", ["all", "UJAMES"], ["@frontend"], [42], null]) {
    for (const field of ["view_perms", "edit_perms"]) {
      client.apps.datastore.get = () =>
        Promise.resolve({ ok: true, item: { ...puts[0].item, [field]: value } });
      await rejects(() => repository.findById(task().id), "invalid record");
    }
  }
  await rejects(() => repository.findById("invalid"), "Invalid task reference");
});

Deno.test("permission queries bind principals and guard legacy access behind absent view permissions", async () => {
  const { repository, client } = fixture();
  client.apps.datastore.query = (args) => {
    assert(args.expression.includes("contains(#view, :all)"));
    assert(args.expression.includes("contains(#view, :user)"));
    assert(args.expression.includes("contains(#view, :team0)"));
    assert(args.expression.includes("attribute_not_exists(#view) AND"));
    assert(args.expression_attributes["#view"] === "view_perms");
    assert(args.expression_values[":user"] === access.userId);
    assert(args.expression_values[":team0"] === "SFRONTEND");
    return Promise.resolve({ ok: true, items: [] });
  };
  assert((await repository.list(access)).length === 0);
});
