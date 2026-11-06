import { resetTaskDatabase } from "../delebot/tasks/reset.ts";
import { parseTaskCommand } from "../delebot/tasks/commands.ts";
import { handleMessage, type MessageClient } from "../delebot/slack/events.ts";
import { assert } from "./task_fixtures.ts";

Deno.test("reset requires the exact standalone command", () => {
  assert(parseTaskCommand("delete all").kind === "reset");
  assert(parseTaskCommand("DELETE   ALL").kind === "reset");
  for (
    const text of [
      "123 delete all",
      "delete all due",
      'task "delete all"',
      "delete due p desc",
      "delete",
    ]
  ) {
    assert(parseTaskCommand(text).kind !== "reset", text);
  }
});

Deno.test("reset collects every page of both stores before removing hidden and deleted records", async () => {
  const deleted: string[] = [];
  let queries = 0;
  const result = await resetTaskDatabase({
    apps: {
      datastore: {
        query: ({ datastore, cursor }) => {
          queries++;
          assert(deleted.length === 0);
          return Promise.resolve(
            !cursor ? { ok: true, items: [], next_cursor: "next" } : {
              ok: true,
              items: datastore === "tasks"
                ? [{ id: "hidden" }, { id: "tombstone", deleted: true }]
                : [{ id: "invitation" }],
            },
          );
        },
        delete: ({ datastore, id }) => {
          deleted.push(`${datastore}:${id}`);
          return Promise.resolve({ ok: true });
        },
      },
    },
  });
  assert(queries === 4 && result.tasks === 2 && result.notifications === 1);
  assert(
    deleted.join() === "tasks:hidden,tasks:tombstone,assignment_notifications:invitation",
  );
});

Deno.test("reset refuses incomplete reads and reports failed deletes", async () => {
  for (const mode of ["read", "cursor", "delete"]) {
    let writes = 0;
    let rejected = false;
    try {
      await resetTaskDatabase({
        apps: {
          datastore: {
            query: ({ datastore }) =>
              Promise.resolve(
                mode === "read" && datastore === "assignment_notifications"
                  ? { ok: false }
                  : {
                    ok: true,
                    items: [{ id: "one" }],
                    ...(mode === "cursor" ? { next_cursor: "repeat" } : {}),
                  },
              ),
            delete: () => {
              writes++;
              return Promise.resolve({ ok: false });
            },
          },
        },
      });
    } catch {
      rejected = true;
    }
    assert(rejected);
    assert(mode === "delete" ? writes > 0 : writes === 0);
  }
});

Deno.test("reset command replies in its source thread and ignores bots and ordinary channel text", async () => {
  const posts: string[] = [];
  let resets = 0;
  const client: MessageClient = {
    auth: { test: () => Promise.resolve({ ok: true, user_id: "UBOT" }) },
    users: { info: () => Promise.resolve({ ok: true, user: { is_bot: false } }) },
    conversations: {
      info: () => Promise.resolve({ ok: true }),
      open: () => Promise.resolve({ ok: true }),
    },
    chat: {
      postMessage: ({ text, thread_ts }) => {
        assert(thread_ts === "1.1");
        posts.push(text);
        return Promise.resolve({ ok: true });
      },
      postEphemeral: () => Promise.resolve({ ok: true }),
    },
  };
  const event = {
    channel_id: "CTEST",
    channel_type: "public",
    message_ts: "1.1",
    user_id: "UHUMAN",
    text: "<@UBOT> delete all",
  };
  const reset = () => {
    resets++;
    return Promise.resolve({ tasks: 3, notifications: 2 });
  };
  await handleMessage(
    { ...event, bot_id: "BOTHER" },
    client,
    undefined,
    undefined,
    undefined,
    reset,
  );
  await handleMessage(
    { ...event, text: "delete all" },
    client,
    undefined,
    undefined,
    undefined,
    reset,
  );
  assert(resets === 0);
  await handleMessage(event, client, undefined, undefined, undefined, reset);
  assert(
    Number(resets) === 1 && posts[0].includes("3 task records and 2 assignment records"),
  );
  await handleMessage(
    event,
    client,
    undefined,
    undefined,
    undefined,
    () => Promise.reject(new Error("private internal error")),
  );
  assert(
    posts[1].includes("Some records may have been deleted") &&
      !posts[1].includes("private internal"),
  );
});
