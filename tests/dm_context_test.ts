import {
  type DmContexts,
  expandTeamHandles,
  SlackDmContexts,
} from "../delebot/slack/dm_context.ts";
import { handleMessage, type MessageClient } from "../delebot/slack/events.ts";
import { createTask } from "../delebot/tasks/service.ts";
import { assert, MemoryTaskRepository, teamDirectory } from "./task_fixtures.ts";

Deno.test("DM list threads and the latest single-task conversation support done with fresh access checks", async () => {
  for (const threaded of [false, true]) {
    const repository = new MemoryTaskRepository();
    const access = { userId: "UHUMAN", teamIds: [] };
    const { task } = await createTask(
      { name: "Errands", assignees: [access.userId] },
      { userId: access.userId, channelId: "COTHER", messageTs: "1.1" },
      repository,
      access,
    );
    const rows = new Map<string, string[]>();
    const contexts: DmContexts = {
      get: (channel, thread, user) =>
        Promise.resolve(rows.get(`${channel}:${thread}:${user}`) ?? []),
      save: (channel, thread, user, ids) => {
        rows.set(`${channel}:${thread}:${user}`, ids);
        return Promise.resolve();
      },
    };
    const posts: string[] = [];
    const threads: Array<string | undefined> = [];
    const client: MessageClient = {
      auth: { test: () => Promise.resolve({ ok: true, user_id: "UBOT" }) },
      users: { info: () => Promise.resolve({ ok: true, user: {} }) },
      conversations: {
        info: () => Promise.resolve({ ok: true, channel: { context_team_id: "TTEST" } }),
        open: () => Promise.resolve({ ok: true }),
      },
      chat: {
        postMessage: ({ text, thread_ts }) => {
          posts.push(text);
          threads.push(thread_ts);
          return Promise.resolve({ ok: true, ts: `10.${posts.length}` });
        },
        postEphemeral: () => Promise.resolve({ ok: true }),
      },
    };
    const event = {
      channel_id: "DTEST",
      channel_type: "dm",
      user_id: access.userId,
      message_ts: "2.1",
      text: "ls me",
    };
    await handleMessage(
      event,
      client,
      repository,
      teamDirectory,
      undefined,
      undefined,
      contexts,
    );
    await handleMessage(
      {
        ...event,
        message_ts: "2.2",
        ...(threaded ? { thread_ts: "10.1" } : {}),
        text: "done",
      },
      client,
      repository,
      teamDirectory,
      undefined,
      undefined,
      contexts,
    );
    assert(repository.rows.get(task.id)?.completed);
    assert(threads[0] === undefined, "Task pickers belong in the main DM");
    assert(
      threads[1] === (threaded ? "10.1" : "2.2"),
      "Mutations start or continue a thread",
    );
    assert(posts.at(-1)!.includes("✅"));
    await createTask(
      { name: "Other" },
      { userId: access.userId, channelId: "COTHER", messageTs: "1.2" },
      repository,
      access,
    );
    await handleMessage(
      { ...event, message_ts: "2.3", text: "ls" },
      client,
      repository,
      teamDirectory,
      undefined,
      undefined,
      contexts,
    );
    await handleMessage(
      { ...event, message_ts: "2.4", text: "done" },
      client,
      repository,
      teamDirectory,
      undefined,
      undefined,
      contexts,
    );
    assert(posts.at(-1)!.includes("Several tasks"));
    assert([...repository.rows.values()].filter((item) => item.completed).length === 1);
    assert(rows.get("DTEST:10.3:UHUMAN")?.length === 1);
    assert(rows.get("DTEST:10.4:UHUMAN")?.length === 1);
    assert(rows.get("DTEST:10.3:UHUMAN")![0] !== rows.get("DTEST:10.4:UHUMAN")![0]);
    await handleMessage(
      { ...event, message_ts: "2.6", thread_ts: "10.4", text: "done" },
      client,
      repository,
      teamDirectory,
      undefined,
      undefined,
      contexts,
    );
    assert([...repository.rows.values()].every((item) => item.completed));
    repository.rows.set(task.id, { ...task, viewPerms: [] });
    await handleMessage(
      { ...event, message_ts: "2.5", thread_ts: "10.1", text: "done" },
      client,
      repository,
      teamDirectory,
      undefined,
      undefined,
      contexts,
    );
    assert(posts.at(-1)!.includes("no longer available"));
    await handleMessage(
      { ...event, message_ts: "2.7", text: "task Fresh" },
      client,
      repository,
      teamDirectory,
      undefined,
      undefined,
      contexts,
    );
    assert(
      threads.at(-1) === "2.7",
      "Creation should start a thread on the task command",
    );
  }
});

Deno.test("typed team handles resolve without changing URLs or quoted descriptions", () => {
  const names = { SALPHA: "alphateam" };
  assert(expandTeamHandles("assign @alphateam", names) === "assign <!subteam^SALPHA>");
  assert(
    expandTeamHandles(
      'desc "Ask @alphateam" link https://example.com/@alphateam',
      names,
    ) === 'desc "Ask @alphateam" link https://example.com/@alphateam',
  );
});

Deno.test("persisted DM context is bound to its user and channel", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const contexts = new SlackDmContexts({
    apps: {
      datastore: {
        get: ({ id }) => Promise.resolve({ ok: true, item: rows.get(id) ?? {} }),
        put: ({ item }) => {
          rows.set(item.id as string, item);
          return Promise.resolve({ ok: true });
        },
      },
    },
  });
  await contexts.save("DTEST", "latest", "UONE", ["COTHER:1.1"]);
  assert((await contexts.get("DTEST", "latest", "UONE")).length === 1);
  assert((await contexts.get("DTEST", "latest", "UOTHER")).length === 0);
});
