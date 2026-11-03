import {
  handleMessage as handleMessageImpl,
  type MessageClient,
  type MessageEvent,
} from "../delebot/slack/events.ts";
import { GREETING } from "../delebot/slack/messages.ts";
import { TASK_CREATE_USAGE, TASK_LIST_USAGE } from "../delebot/tasks/commands.ts";
import { input, MemoryTaskRepository, teamDirectory } from "./task_fixtures.ts";
import { SlackTeamDirectory, type TeamDirectory } from "../delebot/slack/teams.ts";
import { createTask } from "../delebot/tasks/service.ts";
import { TaskReferenceError } from "../delebot/tasks/repository.ts";
import type {
  NotificationBatch,
  NotificationClient,
  NotificationStore,
} from "../delebot/slack/notifications.ts";

type Notifications = { client: NotificationClient; store: NotificationStore };
const notificationFixtures = new WeakMap<MessageClient, Notifications>();

function handleMessage(
  event: MessageEvent,
  client: MessageClient,
  repo?: MemoryTaskRepository,
  directory: TeamDirectory = teamDirectory,
  notifications: Notifications | undefined = notificationFixtures.get(client),
) {
  return handleMessageImpl(event, client, repo, directory, notifications);
}

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertListDm(
  post: { channel: string; thread_ts?: string; user?: string },
  userId = "UHUMAN",
) {
  assert(post.channel === `DLIST${userId}` && !post.thread_ts && !post.user);
}

function fixture() {
  const posts: Array<
    { channel: string; text: string; thread_ts?: string; user?: string }
  > = [];
  const publicPosts: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const notificationPosts: Array<{ channel: string; text: string }> = [];
  const openedDms: string[] = [];
  const openedListDms: string[] = [];
  const batches = new Map<string, NotificationBatch>();
  const notificationClient: NotificationClient = {
    conversations: {
      open: ({ users }) => {
        openedDms.push(users);
        return Promise.resolve({ ok: true, channel: { id: `D${users}` } });
      },
    },
    chat: {
      postMessage: (args) => {
        notificationPosts.push(args);
        return Promise.resolve({ ok: true, ts: "20.1" });
      },
    },
    usergroups: {
      users: {
        list: () => Promise.resolve({ ok: true, users: ["UHUMAN", "UTEAMMATE"] }),
      },
    },
  };
  const notificationStore: NotificationStore = {
    get: (id) => Promise.resolve(structuredClone(batches.get(id) ?? null)),
    save: (batch) => {
      batches.set(batch.id, structuredClone(batch));
      return Promise.resolve();
    },
  };
  const client: MessageClient = {
    auth: { test: () => Promise.resolve({ ok: true, user_id: "UBOT" }) },
    users: { info: () => Promise.resolve({ ok: true, user: { is_bot: false } }) },
    conversations: {
      info: () =>
        Promise.resolve({ ok: true, channel: { context_team_id: "TWORKSPACE" } }),
      open: ({ users }) => {
        openedListDms.push(users);
        return Promise.resolve({ ok: true, channel: { id: `DLIST${users}` } });
      },
    },
    chat: {
      postEphemeral: (args) => {
        posts.push(args);
        return Promise.resolve({ ok: true, message_ts: "10.1" });
      },
      postMessage: (args) => {
        publicPosts.push(args);
        if (args.text !== "Task results are shown only to you in this thread.") {
          posts.push(args);
        }
        return Promise.resolve({ ok: true, ts: "10.1" });
      },
    },
  };
  const event: MessageEvent = {
    channel_id: "CTEST",
    channel_type: "public",
    user_id: "UHUMAN",
    message_ts: "9.1",
    text: "<@UBOT> hello",
  };
  const notifications = { client: notificationClient, store: notificationStore };
  notificationFixtures.set(client, notifications);
  return {
    client,
    event,
    posts,
    publicPosts,
    notificationPosts,
    notificationClient,
    notificationStore,
    notifications,
    openedDms,
    openedListDms,
  };
}

Deno.test("usage commands need no team or datastore access and list help goes to a DM", async () => {
  const { event, client, posts } = fixture();
  const unavailable: TeamDirectory = {
    load: () => {
      throw new Error("Must not load teams");
    },
  };
  for (
    const [command, expected] of [
      ["?", GREETING],
      ["task ?", TASK_CREATE_USAGE],
      ["ls tasks ?", TASK_LIST_USAGE],
    ]
  ) {
    await handleMessage(
      { ...event, text: `<@UBOT> ${command}`, thread_ts: "1.1" },
      client,
      undefined,
      unavailable,
    );
    const reply = posts.at(-1)!;
    if (command.startsWith("ls")) assertListDm(reply);
    else assert(reply.channel === event.channel_id && reply.thread_ts === "1.1");
    assert(reply.text === expected);
  }
  await handleMessage(
    { ...event, channel_type: "dm", text: "task ?" },
    client,
    undefined,
    unavailable,
  );
  assert(posts.at(-1)!.text === TASK_CREATE_USAGE);
  assert(posts.at(-1)!.thread_ts === event.message_ts);
});

Deno.test("unrecognised channel mention receives command help in a thread", async () => {
  const { event, client, posts } = fixture();
  const result = await handleMessage(event, client);
  assert("outputs" in result && !result.outputs.ignored);
  assert(posts.length === 1);
  assert(posts[0].channel === event.channel_id);
  assert(posts[0].thread_ts === event.message_ts);
  assert(posts[0].text === GREETING);
});

Deno.test("reply stays in an existing thread", async () => {
  const { event, client, posts } = fixture();
  await handleMessage({ ...event, thread_ts: "1.1" }, client);
  assert(posts[0].thread_ts === "1.1");
});

Deno.test("null thread timestamp from Slack starts a reply thread on the message", async () => {
  const { event, client, posts } = fixture();
  await handleMessage(
    { ...event, thread_ts: null },
    client,
  );
  assert(posts[0].thread_ts === event.message_ts);
});

Deno.test("human DM does not require a bot mention", async () => {
  const { event, client, posts } = fixture();
  await handleMessage({ ...event, channel_type: "dm", text: "hello" }, client);
  assert(posts.length === 1);
});

Deno.test("private-channel mention receives a reply", async () => {
  const { event, client, posts } = fixture();
  await handleMessage({ ...event, channel_type: "private" }, client);
  assert(posts.length === 1);
});

Deno.test("ordinary channel messages and mentions of other people are ignored", async () => {
  const { event, client, posts } = fixture();
  for (const text of ["hello", "<@USOMEONE> hello", "<@UBOTOTHER> hello"]) {
    await handleMessage({ ...event, text }, client);
  }
  assert(posts.length === 0);
});

Deno.test("self messages, bot messages, edits, and group DMs are ignored", async () => {
  const { event, client, posts } = fixture();
  for (
    const override of [
      { user_id: "UBOT", channel_type: "dm" },
      { bot_id: "BBOT" },
      { subtype: "message_changed" },
      { channel_type: "mpdm" },
    ]
  ) {
    await handleMessage({ ...event, ...override }, client);
  }
  assert(posts.length === 0);
});

Deno.test("bot sender is ignored even when workflow event has no bot_id", async () => {
  const { event, client, posts } = fixture();
  client.users.info = () => Promise.resolve({ ok: true, user: { is_bot: true } });
  await handleMessage({ ...event, channel_type: "dm" }, client);
  assert(posts.length === 0);
});

Deno.test("sender lookup failure does not send a reply", async () => {
  const { event, client, posts } = fixture();
  client.users.info = () => Promise.resolve({ ok: false, error: "missing_scope" });
  const result = await handleMessage(event, client);
  assert("error" in result && result.error.includes("missing_scope"));
  assert(posts.length === 0);
});

Deno.test("identity lookup failure does not send a reply", async () => {
  const { event, client, posts } = fixture();
  client.auth.test = () => Promise.resolve({ ok: false, error: "invalid_auth" });
  const result = await handleMessage(event, client);
  assert("error" in result && result.error.includes("invalid_auth"));
  assert(posts.length === 0);
});

Deno.test("Slack send failures are reported rather than marked successful", async () => {
  const { event, client } = fixture();
  client.chat.postMessage = () => Promise.resolve({ ok: false, error: "not_in_channel" });
  const result = await handleMessage(event, client);
  assert("error" in result && result.error.includes("not_in_channel"));
});

const createCommand =
  "task Clean PRs link <https://example.slack.com/archives/C1/p123|Message> " +
  "assign <@UJAMES> <@UALICE> <!subteam^SFRONTEND|@frontend> " +
  "describe Review open PRs. due 6/11/26 p 2";

Deno.test("a restricted channel task command replies privately in its original thread", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage(
    { ...event, text: `<@UBOT> ${createCommand}`, thread_ts: "1.1" },
    client,
    repo,
  );
  assert(repo.rows.size === 1 && posts.length === 1);
  const task = [...repo.rows.values()][0];
  assert(
    task.name === "Clean PRs" && task.assignees.join() === "UJAMES,UALICE,SFRONTEND",
  );
  assert(task.links[0] === "https://example.slack.com/archives/C1/p123");
  assert(task.description === "Review open PRs." && task.dueDate === "2026-11-06");
  assert(task.priority === 2 && task.createdBy === "UHUMAN");
  assert(posts[0].thread_ts === "1.1" && posts[0].channel === event.channel_id);
  assert(posts[0].user === event.user_id);
  assert(task.teams.join() === "SFRONTEND" && posts[0].text.includes("@frontend"));
  assert(posts[0].text.includes(`Created task #${task.number}`));
  assert(posts[0].text.includes("<@UJAMES>") && posts[0].text.includes("6/11/2026"));
});

Deno.test("a DM can create a task without a bot mention and starts unassigned", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage(
    {
      ...event,
      channel_type: "dm",
      text: 'task Personal describe "A description" due 6/11/26 p 1',
    },
    client,
    repo,
  );
  assert([...repo.rows.values()][0].assignees.length === 0);
  assert(posts[0].text.includes("Created task"));
});

Deno.test("all requested list commands return the created task", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage({ ...event, text: `<@UBOT> ${createCommand}` }, client, repo);
  const task = [...repo.rows.values()][0];
  for (
    const command of [
      "ls tasks",
      `ls task ${task.number}`,
      "ls task *clean PRs*",
      "ls tasks <@UJAMES>",
      "ls tasks priority 2 <@UJAMES>",
      "ls tasks due 6/11/26 <@UJAMES>",
      "ls tasks <!subteam^SFRONTEND|@frontend>",
    ]
  ) {
    const before = posts.length;
    await handleMessage({ ...event, text: `<@UBOT> ${command}` }, client, repo);
    assert(posts.length === before + 1);
    assert(posts.at(-1)!.text.includes("Clean PRs"), command);
    assertListDm(posts.at(-1)!);
  }
  assert(repo.rows.size === 1);
});

Deno.test("no-match lists and lookups give a clear response", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage({ ...event, text: "<@UBOT> ls tasks" }, client, repo);
  assert(posts[0].text === "No tasks found.");
  await handleMessage({ ...event, text: "<@UBOT> ls task 5" }, client, repo);
  assert(posts[1].text === "No matching task available to you.");
});

Deno.test("invalid commands explain the problem without creating tasks", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage(
    { ...event, text: `<@UBOT> ${createCommand.replace("6/11/26", "31/11/26")}` },
    client,
    repo,
  );
  assert(repo.writes === 0 && posts[0].text.includes("valid due date"));
  await handleMessage({ ...event, text: "<@UBOT> ls tasks priority 6" }, client, repo);
  assert(repo.writes === 0 && posts[1].text.includes("1 to 5"));
  assertListDm(posts[1]);
});

Deno.test("retries after a reply failure keep the saved task and its number", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  const send = client.chat.postMessage;
  client.chat.postMessage = () => Promise.resolve({ ok: false, error: "ratelimited" });
  const command = { ...event, text: `<@UBOT> ${createCommand}` };
  const failed = await handleMessage(command, client, repo);
  assert("error" in failed && repo.rows.size === 1);
  client.chat.postMessage = send;
  await handleMessage(command, client, repo);
  assert(repo.writes === 1 && posts[0].text.includes("Already saved task"));
});

Deno.test("task storage failures never send a success confirmation or raw error details", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  repo.save = () => Promise.reject(new Error("sensitive internal details"));
  await handleMessage({ ...event, text: `<@UBOT> ${createCommand}` }, client, repo);
  assert(posts[0].text.includes("couldn't confirm"));
  assert(!posts[0].text.includes("Created task") && !posts[0].text.includes("sensitive"));
  repo.list = () => Promise.reject(new Error("sensitive internal details"));
  await handleMessage({ ...event, text: "<@UBOT> ls tasks" }, client, repo);
  assert(posts[1].text.includes("couldn't load tasks"));
  assertListDm(posts[1]);
});

Deno.test("bots cannot create tasks and team members can find tasks across conversations", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage(
    { ...event, bot_id: "BOTHER", text: `<@UBOT> ${createCommand}` },
    client,
    repo,
  );
  assert(repo.writes === 0 && posts.length === 0);
  await handleMessage({ ...event, text: `<@UBOT> ${createCommand}` }, client, repo);
  await handleMessage(
    { ...event, channel_id: "CPRIVATE", text: "<@UBOT> ls tasks" },
    client,
    repo,
  );
  assert(posts.at(-1)!.text.includes("Clean PRs"));
  assert(posts[0].channel === event.channel_id);
  assertListDm(posts.at(-1)!);
});

Deno.test("only the addressing mention is removed from task content", async () => {
  const { event, client } = fixture();
  const repo = new MemoryTaskRepository();
  const command = "task Check bot describe Ask <@UBOT> for help due 6/11/26 p 2";
  await handleMessage({ ...event, text: `<@UBOT> ${command}` }, client, repo);
  await handleMessage(
    {
      ...event,
      channel_type: "dm",
      message_ts: "10.1",
      text: command,
    },
    client,
    repo,
  );
  assert(repo.rows.size === 2);
  assert(
    [...repo.rows.values()].every((task) => task.description === "Ask <@UBOT> for help"),
  );
});

Deno.test("large escaped details are sent in bounded replies on creation and lookup", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  const links = Array.from(
    { length: 10 },
    (_, index) => `https://example.com/${index}?q=` + "&".repeat(950),
  ).join(" ");
  await handleMessage(
    {
      ...event,
      text: `<@UBOT> task Big link ${links} describe ${"&".repeat(2000)} due 6/11/26 p 2`,
    },
    client,
    repo,
  );
  assert(repo.rows.size === 1 && posts.length > 1);
  assert(
    posts.every((post) => post.text.length <= 35000 && post.channel === event.channel_id),
  );
  const before = posts.length;
  await handleMessage({ ...event, text: "<@UBOT> ls task Big" }, client, repo);
  assert(posts.length > before + 1);
  assert(posts.every((post) => post.text.length <= 35000));
  assert(
    posts[0].thread_ts === event.message_ts && posts[1].thread_ts === event.message_ts,
  );
});

Deno.test("DM task commands keep replies in the original private thread", async () => {
  const { event, client, posts } = fixture();
  await handleMessage(
    {
      ...event,
      channel_type: "dm",
      channel_id: "DEXISTING",
      thread_ts: "1.1",
      text: createCommand,
    },
    client,
    new MemoryTaskRepository(),
  );
  assert(posts[0].channel === "DEXISTING" && posts[0].thread_ts === "1.1");
});

Deno.test("membership failures block restricted creation and limit reads to safe visibility", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  let reads = 0;
  repo.list = () => {
    reads++;
    return Promise.resolve([]);
  };
  const failed: TeamDirectory = { load: () => Promise.reject(new Error("sensitive")) };
  for (const text of [createCommand, "ls tasks", "ls task 5"]) {
    await handleMessage({ ...event, text: `<@UBOT> ${text}` }, client, repo, failed);
  }
  assert(reads === 2 && repo.writes === 0);
  assert(
    posts.filter((p) => p.text.includes("couldn't verify")).length === 3 &&
      posts.every((p) => !p.text.includes("sensitive")),
  );
  assert(posts[0].channel === event.channel_id);
  posts.slice(1).forEach((post) => assertListDm(post));
});

Deno.test("explicit all task creation needs no membership API and fallback lists hide restricted tasks", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  let checks = 0;
  const failed: TeamDirectory = {
    load: () => {
      checks++;
      return Promise.reject(new Error("unavailable"));
    },
  };
  await handleMessage(
    {
      ...event,
      text: "<@UBOT> task errands assign all describe run my errands due 6/11/26 p 2",
    },
    client,
    repo,
    failed,
  );
  assert(checks === 0 && repo.rows.size === 1 && posts[0].text.includes("Created task"));
  const task = [...repo.rows.values()][0];
  repo.list = () =>
    Promise.resolve([task, {
      ...task,
      id: "hidden",
      name: "Secret",
      createdBy: "UOTHER",
      teams: ["SFRONTEND"],
      assignees: ["SFRONTEND"],
    }]);
  const before = posts.length;
  await handleMessage({ ...event, text: "<@UBOT> ls tasks" }, client, repo, failed);
  assert(Number(checks) === 1);
  const replies = posts.slice(before).map((p) => p.text).join("\n");
  assert(
    replies.includes("errands") && replies.includes("Team-only tasks may be hidden"),
  );
  assert(!replies.includes("Secret"));
});

Deno.test("known teams can receive assignments and unknown teams cannot", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  for (const group of ["SBACKEND", "SUNKNOWN"]) {
    await handleMessage(
      {
        ...event,
        text: `<@UBOT> ${createCommand.replaceAll("SFRONTEND", group)}`,
      },
      client,
      repo,
    );
  }
  assert(repo.writes === 1 && posts[0].text.includes("Created task"));
  assert(posts[1].text.includes("could not verify the selected group"));
});

Deno.test("every filter hides nonmember tasks from an unassigned reader", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  const { task } = await createTask(
    { ...input, assignees: ["SBACKEND"] },
    {
      channelId: "CSECRET",
      messageTs: "1793690000.000001",
      userId: event.user_id,
    },
    repo,
    { userId: event.user_id, teamIds: ["SBACKEND"] },
  );
  // A noncreator reader is not in backend. A faulty repository cannot bypass access.
  repo.list = () => Promise.resolve([task]);
  for (
    const query of [
      "ls tasks",
      `ls task ${task.number}`,
      "ls task Clean PRs",
      `ls tasks <@${event.user_id}>`,
      "ls tasks priority 2",
      "ls tasks due 6/11/26",
      "ls tasks <!subteam^SBACKEND>",
    ]
  ) {
    await handleMessage(
      { ...event, user_id: "UUNASSIGNED", text: `<@UBOT> ${query}` },
      client,
      repo,
    );
    assert(!posts.at(-1)!.text.includes("Clean PRs"), query);
  }
  posts.forEach((post) => assertListDm(post, "UUNASSIGNED"));
});

Deno.test("all tasks are accessible to users with no groups, while multiteam tasks need any match", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage(
    {
      ...event,
      text: `<@UBOT> ${
        createCommand.replace(
          "SFRONTEND|@frontend>",
          "SFRONTEND|@frontend> <!subteam^SBACKEND>",
        )
      }`,
    },
    client,
    repo,
  );
  await handleMessage(
    {
      ...event,
      message_ts: "9.2",
      text: "<@UBOT> task Everyone assign all describe Shared due 6/11/26 p 2",
    },
    client,
    repo,
  );
  const noGroups: TeamDirectory = {
    load: (userId) =>
      Promise.resolve({
        access: { userId, teamIds: [] },
        knownTeamIds: ["SFRONTEND", "SBACKEND"],
        teamNames: {},
      }),
  };
  await handleMessage(
    { ...event, user_id: "UOTHER", text: "<@UBOT> ls tasks" },
    client,
    repo,
    noGroups,
  );
  assert(
    posts.at(-1)!.text.includes("Everyone") && !posts.at(-1)!.text.includes("Clean PRs"),
  );
  await handleMessage({ ...event, text: "<@UBOT> ls tasks" }, client, repo);
  assert(posts.at(-1)!.text.includes("Clean PRs"));
});

Deno.test("private reply failure never broadcasts restricted task data", async () => {
  const { event, client, posts, publicPosts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage({ ...event, text: `<@UBOT> ${createCommand}` }, client, repo);
  posts.length = 0;
  publicPosts.length = 0;
  client.chat.postEphemeral = () =>
    Promise.resolve({ ok: false, error: "user_not_in_channel" });
  const reply = await handleMessage(
    { ...event, thread_ts: event.message_ts, message_ts: "9.2", text: "<@UBOT> p 1" },
    client,
    repo,
  );
  assert("error" in reply && posts.length === 0);
  assert(publicPosts.length === 1 && !publicPosts[0].text.includes("Clean PRs"));
  assert(publicPosts[0].thread_ts === event.message_ts);
});

Deno.test("all-team creation replies in the source thread and tasks ls goes to a DM", async () => {
  const { event, client, posts, publicPosts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage(
    { ...event, text: "<@UBOT> task Shared assign all describe Review due 6/11/26 p 2" },
    client,
    repo,
  );
  await handleMessage({ ...event, text: "<@UBOT> tasks ls" }, client, repo);
  assert(posts.length === 2 && publicPosts.length === 2);
  assert(
    posts[0].channel === event.channel_id && posts[0].thread_ts === event.message_ts,
  );
  assertListDm(posts[1]);
  assert(posts[1].text.includes("Shared") && !posts[1].text.includes("Hello!"));
});

Deno.test("enterprise team creation passes the channel workspace into the membership lookup", async () => {
  const { event, client, posts } = fixture();
  client.users.info = () =>
    Promise.resolve({ ok: true, user: { is_bot: false, team_id: "EENTERPRISE" } });
  let workspace: string | undefined;
  const directory: TeamDirectory = {
    load: (userId, workspaceId) => {
      workspace = workspaceId;
      return teamDirectory.load(userId);
    },
  };
  const repo = new MemoryTaskRepository();
  await handleMessage(
    { ...event, text: `<@UBOT> ${createCommand}` },
    client,
    repo,
    directory,
  );
  assert(workspace === "TWORKSPACE" && repo.rows.size === 1);
  assert(posts[0].text.includes("Created task"));
});

Deno.test("a group missing from discovery can be created, listed, and revoked through verified membership", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  let member = true;
  const directory = new SlackTeamDirectory({
    usergroups: {
      list: () => Promise.resolve({ ok: true, usergroups: [] }),
      users: {
        list: ({ usergroup, team_id }) => {
          assert(usergroup === "SFRONTEND" && team_id === "TWORKSPACE");
          return Promise.resolve({
            ok: true,
            users: member ? [event.user_id, "UTEAMMATE"] : [],
          });
        },
      },
    },
  });
  await handleMessage(
    { ...event, text: `<@UBOT> ${createCommand}` },
    client,
    repo,
    directory,
  );
  assert(repo.rows.size === 1 && posts.at(-1)!.text.includes("Created task"));
  await handleMessage(
    { ...event, user_id: "UTEAMMATE", text: "<@UBOT> tasks ls" },
    client,
    repo,
    directory,
  );
  assert(posts.at(-1)!.text.includes("Clean PRs"));
  member = false;
  await handleMessage(
    { ...event, user_id: "UTEAMMATE", text: "<@UBOT> tasks ls" },
    client,
    repo,
    directory,
  );
  assert(posts.at(-1)!.text === "No tasks found.");
});

Deno.test("stale mentions to disabled groups get a specific response without writing tasks", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  const directory = new SlackTeamDirectory({
    usergroups: {
      list: () =>
        Promise.resolve({
          ok: true,
          usergroups: [{
            id: "SFRONTEND",
            date_delete: 123,
            users: [event.user_id],
          }],
        }),
      users: {
        list: () => {
          throw new Error("Must not verify disabled groups");
        },
      },
    },
  });
  await handleMessage(
    { ...event, text: `<@UBOT> ${createCommand}` },
    client,
    repo,
    directory,
  );
  assert(repo.writes === 0 && posts.at(-1)!.text.includes("disabled Slack group"));
});

Deno.test("failed team-reference queries are reported as storage failures, with safe fallback results", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage(
    { ...event, text: "<@UBOT> task Shared assign all describe Review due 6/11/26 p 2" },
    client,
    repo,
  );
  repo.referencedTeamIds = () =>
    Promise.reject(new TaskReferenceError("sensitive internal error"));
  posts.length = 0;
  await handleMessage({ ...event, text: "<@UBOT> tasks ls" }, client, repo);
  const text = posts.map((post) => post.text).join("\n");
  assert(text.includes("Shared") && text.includes("couldn't read the teams attached"));
  assert(
    !text.includes("couldn't verify your team membership") && !text.includes("sensitive"),
  );
});

Deno.test("person assignment does not require team lookup and completion filters work end to end", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  const directory: TeamDirectory = {
    load: () => {
      throw new Error("Must not check teams for a person assignment");
    },
  };
  await handleMessage(
    {
      ...event,
      text:
        '<@UBOT> task Finished assign <@UHUMAN> describe "Already done" due 6/11/26 p 2 done',
    },
    client,
    repo,
    directory,
  );
  const task = [...repo.rows.values()][0];
  assert(
    task.completed && task.assignees.join() === "UHUMAN" && task.status === "completed",
  );
  assert(posts[0].text.includes("*Completed:* Yes"));
  await handleMessage({ ...event, text: "<@UBOT> tasks ls completed yes" }, client, repo);
  assert(posts.at(-1)!.text.includes("Finished"));
  await handleMessage({ ...event, text: "<@UBOT> tasks ls completed no" }, client, repo);
  assert(posts.at(-1)!.text === "No tasks found.");
});

Deno.test("name-only creation and combined thread updates show current fields and notify new assignees", async () => {
  const { event, client, posts, notificationPosts, openedDms } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage({ ...event, text: "<@UBOT> task Review PRs" }, client, repo);
  const initial = [...repo.rows.values()][0];
  assert(initial.name === "Review PRs" && initial.assignees.length === 0);
  assert(
    !initial.completed && initial.description === "" && initial.links.length === 0 &&
      initial.priority === null && initial.dueDate === null,
  );
  assert(
    posts[0].thread_ts === event.message_ts && posts[0].text.includes("Created task"),
  );
  assert(openedDms.length === 0 && notificationPosts.length === 0);
  const update = {
    ...event,
    message_ts: "9.2",
    thread_ts: event.message_ts,
    text:
      '<@UBOT> assign <@UJAMES> describe "Review open PRs" p 1 due 6/11/26 link https://a.example link https://b.example',
  };
  await handleMessage(update, client, repo);
  const current = [...repo.rows.values()][0];
  assert(current.number === initial.number && repo.rows.size === 1);
  assert(current.assignees.join() === "UJAMES");
  assert(current.description === "Review open PRs" && current.priority === 1);
  assert(current.dueDate === "2026-11-06" && current.links.length === 2);
  assert(posts.at(-1)!.thread_ts === event.message_ts);
  assert(
    posts.at(-1)!.text.includes(`Updated task #${initial.number}`) &&
      posts.at(-1)!.text.includes("Review open PRs") &&
      posts.at(-1)!.text.includes("https://b.example"),
  );
  assert(openedDms.join() === "UJAMES");
  assert(notificationPosts.at(-1)!.text.includes(`#${initial.number}: Review PRs`));
  await handleMessage(update, client, repo);
  assert(repo.writes === 2 && Number(notificationPosts.length) === 1);
  assert(posts.at(-1)!.text.includes("Already applied"));
});

Deno.test("explicit assign - assigns the creator and delivers one assignment DM", async () => {
  const { event, client, posts, notificationPosts, openedDms } = fixture();
  const repo = new MemoryTaskRepository();
  const command = { ...event, text: "<@UBOT> task Personal followup assign -" };
  await handleMessage(command, client, repo);
  const task = [...repo.rows.values()][0];
  assert(task.assignees.join() === event.user_id && repo.writes === 1);
  assert(
    posts[0].text.includes("Created task") &&
      posts[0].text.includes(`<@${event.user_id}>`),
  );
  assert(openedDms.join() === event.user_id && notificationPosts.length === 1);
  assert(notificationPosts[0].text.includes(`#${task.number}: Personal followup`));
  await handleMessage(command, client, repo);
  assert(repo.writes === 1 && notificationPosts.length === 1);
});

Deno.test("links and descriptions append across thread messages without duplicate links", async () => {
  const { event, client } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage(
    {
      ...event,
      text: '<@UBOT> task Notes describe "First paragraph" link https://a.example',
    },
    client,
    repo,
  );
  await handleMessage(
    {
      ...event,
      thread_ts: event.message_ts,
      message_ts: "9.2",
      text:
        '<@UBOT> link https://b.example link https://c.example describe "Second paragraph" descibe "Third paragraph"',
    },
    client,
    repo,
  );
  await handleMessage(
    {
      ...event,
      thread_ts: event.message_ts,
      message_ts: "9.3",
      text: "<@UBOT> link https://c.example link https://d.example",
    },
    client,
    repo,
  );
  const task = [...repo.rows.values()][0];
  assert(
    task.links.join() ===
      "https://a.example,https://b.example,https://c.example,https://d.example",
  );
  assert(task.description === "First paragraph\n\nSecond paragraph\n\nThird paragraph");
  assert(repo.writes === 3);
});

Deno.test("a numbered update completes a task outside its original thread", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage({ ...event, text: "<@UBOT> task Finish review p 2" }, client, repo);
  const task = [...repo.rows.values()][0];
  await handleMessage(
    {
      ...event,
      channel_id: "COTHER",
      message_ts: "10.1",
      text: `<@UBOT> ${task.number} done`,
    },
    client,
    repo,
  );
  const updated = [...repo.rows.values()][0];
  assert(updated.completed && updated.status === "completed" && updated.priority === 2);
  assert(posts.at(-1)!.channel === "COTHER" && posts.at(-1)!.thread_ts === "10.1");
  assert(posts.at(-1)!.text.includes("*Completed:* Yes"));
});

Deno.test("work done completes the unique task in the current thread", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage({ ...event, text: "<@UBOT> task Ship fixes" }, client, repo);
  await handleMessage(
    {
      ...event,
      thread_ts: event.message_ts,
      message_ts: "9.2",
      text: "<@UBOT> work done",
    },
    client,
    repo,
  );
  assert([...repo.rows.values()][0].completed && repo.writes === 2);
  assert(posts.at(-1)!.text.includes("*Completed:* Yes"));
});

Deno.test("thread updates need a unique visible task and numbered updates disambiguate", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage(
    { ...event, thread_ts: "1.1", message_ts: "9.1", text: "<@UBOT> task First" },
    client,
    repo,
  );
  await handleMessage(
    { ...event, thread_ts: "1.1", message_ts: "9.2", text: "<@UBOT> task Second" },
    client,
    repo,
  );
  await handleMessage(
    { ...event, thread_ts: "1.1", message_ts: "9.3", text: "<@UBOT> done" },
    client,
    repo,
  );
  assert(repo.writes === 2 && posts.at(-1)!.text.includes("More than one task"));
  const first = [...repo.rows.values()][0];
  await handleMessage(
    {
      ...event,
      thread_ts: "1.1",
      message_ts: "9.4",
      text: `<@UBOT> ${first.number} done`,
    },
    client,
    repo,
  );
  assert(Number(repo.writes) === 3 && [...repo.rows.values()][0].completed);
  assert(![...repo.rows.values()][1].completed);
  await handleMessage(
    { ...event, thread_ts: "2.1", message_ts: "9.5", text: "<@UBOT> p 1" },
    client,
    repo,
  );
  assert(
    Number(repo.writes) === 3 &&
      posts.at(-1)!.text.includes("No task available in this thread"),
  );
});

Deno.test("unassigned users cannot update a restricted task by thread or number", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage({ ...event, text: "<@UBOT> task Private review" }, client, repo);
  const task = [...repo.rows.values()][0];
  // A faulty repository may return inaccessible rows; the service must still deny updates.
  repo.list = () => Promise.resolve([task]);
  for (const command of ["done", `${task.number} done`]) {
    await handleMessage(
      {
        ...event,
        user_id: "UUNASSIGNED",
        thread_ts: event.message_ts,
        message_ts: "9.2",
        text: `<@UBOT> ${command}`,
      },
      client,
      repo,
    );
    assert(posts.at(-1)!.text.includes("available"));
    assert(!posts.at(-1)!.text.includes("Private review"));
  }
  assert(repo.writes === 1 && ![...repo.rows.values()][0].completed);
});

Deno.test("an invalid combined update makes no partial changes and sends no assignment DM", async () => {
  const { event, client, posts, notificationPosts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage({ ...event, text: "<@UBOT> task Atomic change" }, client, repo);
  const before = JSON.stringify([...repo.rows.values()]);
  const notified = notificationPosts.length;
  await handleMessage(
    {
      ...event,
      thread_ts: event.message_ts,
      message_ts: "9.2",
      text: "<@UBOT> assign <@UALICE> link https://valid.example p 6 done",
    },
    client,
    repo,
  );
  assert(repo.writes === 1 && JSON.stringify([...repo.rows.values()]) === before);
  assert(
    notificationPosts.length === notified && posts.at(-1)!.text.includes("Priority must"),
  );
});

Deno.test("failed assignment notifications keep the saved task and retries deliver only pending DMs", async () => {
  const { event, client, posts, notificationClient, notificationPosts } = fixture();
  const repo = new MemoryTaskRepository();
  const send = notificationClient.chat.postMessage;
  notificationClient.chat.postMessage = (args) =>
    args.channel === "DUALICE"
      ? Promise.resolve({ ok: false, error: "cannot_dm_user" })
      : send(args);
  const command = {
    ...event,
    text: "<@UBOT> task Notify owners assign <@UALICE> <@UJAMES>",
  };
  await handleMessage(command, client, repo);
  assert(repo.rows.size === 1 && repo.writes === 1);
  assert(posts[0].text.includes("Created task"));
  assert(
    posts.at(-1)!.text.includes("task was saved") &&
      posts.at(-1)!.text.includes("could not be delivered"),
  );
  assert(notificationPosts.length === 1 && notificationPosts[0].channel === "DUJAMES");
  notificationClient.chat.postMessage = send;
  await handleMessage(command, client, repo);
  assert(repo.writes === 1 && Number(notificationPosts.length) === 2);
  assert(notificationPosts[1].channel === "DUALICE");
  assert(posts.at(-1)!.text.includes("Already saved task"));
  await handleMessage(command, client, repo);
  assert(repo.writes === 1 && Number(notificationPosts.length) === 2);
});

Deno.test("a later task update resumes pending assignment notifications without duplicating delivered DMs", async () => {
  const { event, client, posts, notificationClient, notificationPosts } = fixture();
  const repo = new MemoryTaskRepository();
  const send = notificationClient.chat.postMessage;
  notificationClient.chat.postMessage = (args) =>
    args.channel === "DUALICE"
      ? Promise.resolve({ ok: false, error: "cannot_dm_user" })
      : send(args);
  await handleMessage(
    { ...event, text: "<@UBOT> task Resume delivery assign <@UALICE> <@UJAMES>" },
    client,
    repo,
  );
  assert(repo.writes === 1 && notificationPosts.length === 1);
  assert(notificationPosts[0].channel === "DUJAMES");
  notificationClient.chat.postMessage = send;
  await handleMessage(
    { ...event, thread_ts: event.message_ts, message_ts: "9.2", text: "<@UBOT> p 1" },
    client,
    repo,
  );
  assert(Number(repo.writes) === 2 && Number(notificationPosts.length) === 2);
  assert(notificationPosts[1].channel === "DUALICE");
  assert(posts.at(-1)!.text.includes("Updated task"));
  await handleMessage(
    { ...event, thread_ts: event.message_ts, message_ts: "9.3", text: "<@UBOT> done" },
    client,
    repo,
  );
  assert(Number(repo.writes) === 3 && Number(notificationPosts.length) === 2);
});

Deno.test("thread deletion hides the task and delayed command replays cannot restore it", async () => {
  const { event, client, posts, notificationPosts } = fixture();
  const repo = new MemoryTaskRepository();
  const create = { ...event, text: "<@UBOT> task Temporary" };
  await handleMessage(create, client, repo);
  const task = [...repo.rows.values()][0];
  const deletion = {
    ...event,
    thread_ts: event.message_ts,
    message_ts: "9.2",
    text: "<@UBOT> delete",
  };
  await handleMessage(deletion, client, repo);
  assert(repo.writes === 2 && [...repo.rows.values()][0].deleted);
  assert(posts.at(-1)!.text === `Deleted task #${task.number}.`);
  assert(posts.at(-1)!.thread_ts === event.message_ts);
  await handleMessage(deletion, client, repo);
  assert(repo.writes === 2 && posts.at(-1)!.text.includes("No task available"));
  await handleMessage(create, client, repo);
  assert(repo.writes === 2 && posts.at(-1)!.text.includes("has been deleted"));
  await handleMessage({ ...event, text: "<@UBOT> ls" }, client, repo);
  assert(posts.at(-1)!.text === "No tasks found.");
  assertListDm(posts.at(-1)!);
  assert(notificationPosts.length === 0);
});

Deno.test("numbered deletion denies an unassigned user and permits a current assignee", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage(
    { ...event, text: "<@UBOT> task Remove review assign <@UJAMES>" },
    client,
    repo,
  );
  const task = [...repo.rows.values()][0];
  await handleMessage(
    {
      ...event,
      user_id: "UOTHER",
      message_ts: "9.2",
      text: `<@UBOT> ${task.number} delete`,
    },
    client,
    repo,
  );
  assert(repo.writes === 1 && ![...repo.rows.values()][0].deleted);
  assert(
    posts.at(-1)!.text.includes("available to you") &&
      !posts.at(-1)!.text.includes("Remove review"),
  );
  await handleMessage(
    {
      ...event,
      user_id: "UJAMES",
      channel_id: "COTHER",
      message_ts: "9.3",
      text: `<@UBOT> #${task.number} delete`,
    },
    client,
    repo,
  );
  assert(Number(repo.writes) === 2 && [...repo.rows.values()][0].deleted);
  assert(posts.at(-1)!.text === `Deleted task #${task.number}.`);
  assert(posts.at(-1)!.channel === "COTHER" && posts.at(-1)!.thread_ts === "9.3");
});

Deno.test("delete cannot be mixed with mutations and deletion storage failures reveal no details", async () => {
  const { event, client, posts } = fixture();
  const repo = new MemoryTaskRepository();
  await handleMessage({ ...event, text: "<@UBOT> task Keep data" }, client, repo);
  await handleMessage(
    {
      ...event,
      thread_ts: event.message_ts,
      message_ts: "9.2",
      text: "<@UBOT> p 1 delete",
    },
    client,
    repo,
  );
  assert(repo.writes === 1 && [...repo.rows.values()][0].priority === null);
  assert(posts.at(-1)!.text.includes("Use delete on its own"));
  repo.delete = () => Promise.reject(new Error("sensitive deletion failure"));
  await handleMessage(
    { ...event, thread_ts: event.message_ts, message_ts: "9.3", text: "<@UBOT> delete" },
    client,
    repo,
  );
  assert(repo.writes === 1 && ![...repo.rows.values()][0].deleted);
  assert(posts.at(-1)!.text.includes("couldn't confirm"));
  assert(
    !posts.at(-1)!.text.includes("sensitive") &&
      !posts.at(-1)!.text.includes("Deleted task"),
  );
});

Deno.test("composable ls targets and filters return full task details only in the requester's DM", async () => {
  const { event, client, posts, publicPosts, openedListDms } = fixture();
  const repo = new MemoryTaskRepository();
  const [day, month, year] = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date()).split("/").map(Number);
  const due = (offset: number) => {
    const date = new Date(Date.UTC(year, month - 1, day + offset));
    return `${date.getUTCDate()}/${date.getUTCMonth() + 1}/${date.getUTCFullYear()}`;
  };
  const examples = [
    { name: "Personal", assignees: [event.user_id], priority: 1 as const, offset: 0 },
    { name: "Friend", assignees: ["UFRIEND"], priority: 1 as const, offset: 2 },
    { name: "Frontend", assignees: ["SFRONTEND"], priority: 1 as const, offset: 3 },
    { name: "Later", assignees: ["UFRIEND"], priority: 2 as const, offset: 4 },
    { name: "Backend", assignees: ["SBACKEND"], priority: 1 as const, offset: 1 },
  ];
  for (const [index, example] of examples.entries()) {
    const date = new Date(Date.UTC(year, month - 1, day + example.offset)).toISOString()
      .slice(0, 10);
    await createTask(
      {
        ...input,
        name: example.name,
        assignees: example.assignees,
        priority: example.priority,
        dueDate: date,
      },
      { channelId: event.channel_id, messageTs: `9.${index + 1}`, userId: event.user_id },
      repo,
      { userId: event.user_id, teamIds: ["SFRONTEND"] },
    );
  }
  const cases: Array<[string, string[]]> = [
    ["ls", ["Personal", "Friend", "Frontend", "Later", "Backend"]],
    ["ls me", ["Personal"]],
    ["ls <@UFRIEND>", ["Friend", "Later"]],
    ["ls team", ["Frontend"]],
    ["ls <!subteam^SBACKEND>", ["Backend"]],
    ["ls 1 soon", ["Personal"]],
    ["ls <@UFRIEND> soon", ["Friend"]],
    ["ls team priority 1", ["Frontend"]],
    [`ls (${due(2)}) <@UFRIEND> p1`, ["Friend"]],
    ["ls me <@UFRIEND> soon", ["Personal", "Friend"]],
  ];
  for (const [command, expected] of cases) {
    const before = posts.length;
    await handleMessage(
      { ...event, thread_ts: "1.1", text: `<@UBOT> ${command}` },
      client,
      repo,
    );
    const replies = posts.slice(before);
    assert(replies.length > 0, command);
    replies.forEach((reply) => assertListDm(reply));
    const text = replies.map((reply) => reply.text).join("\n");
    for (const example of examples) {
      assert(
        text.includes(example.name) === expected.includes(example.name),
        `${command}: ${example.name}`,
      );
    }
    assert(text.includes("Review outstanding pull requests."), command);
    assert(text.includes("<https://example.slack.com/archives/C123/p1793690000000001>"));
    assert(text.includes("*Priority:* 1") && text.includes("*Completed:* No"));
  }
  assert(openedListDms.length === cases.length);
  assert(publicPosts.every((post) => post.channel === "DLISTUHUMAN"));
});

Deno.test("list DM opening failures never send task results or fallback acknowledgements to a channel", async () => {
  for (const command of ["ls", "ls ?", "ls me garbage"]) {
    const { event, client, posts, publicPosts } = fixture();
    client.conversations.open = () =>
      Promise.resolve({ ok: false, error: "cannot_dm_user" });
    const result = await handleMessage(
      { ...event, thread_ts: "1.1", text: `<@UBOT> ${command}` },
      client,
      new MemoryTaskRepository(),
    );
    assert("error" in result && result.error.includes("Cannot open a direct message"));
    assert(posts.length === 0 && publicPosts.length === 0);
  }
});

Deno.test("failed list DM sends do not broadcast a public fallback", async () => {
  const { event, client, posts, publicPosts } = fixture();
  const attempts: string[] = [];
  client.chat.postMessage = (args) => {
    attempts.push(args.channel);
    return Promise.resolve({ ok: false, error: "cannot_dm_user" });
  };
  const result = await handleMessage(
    { ...event, text: "<@UBOT> ls", thread_ts: "1.1" },
    client,
    new MemoryTaskRepository(),
  );
  assert("error" in result && result.error.includes("Cannot send reply"));
  assert(attempts.join() === "DLISTUHUMAN");
  assert(posts.length === 0 && publicPosts.length === 0);
});

Deno.test("listing inside an existing DM keeps its own thread and does not open another DM", async () => {
  const { event, client, posts, openedListDms } = fixture();
  await handleMessage(
    {
      ...event,
      channel_type: "dm",
      channel_id: "DEXISTING",
      thread_ts: "1.1",
      text: "ls",
    },
    client,
    new MemoryTaskRepository(),
  );
  assert(posts[0].channel === "DEXISTING" && posts[0].thread_ts === "1.1");
  assert(posts[0].text === "No tasks found." && openedListDms.length === 0);
});
