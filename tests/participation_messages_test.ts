import {
  COLLAB_ACCEPT,
  COLLAB_REJECT,
  handleParticipationAction,
  notifyParticipation,
  type ParticipationAction,
  type ParticipationClient,
  type ParticipationDependencies,
  REQUEST_APPROVE,
  REQUEST_REJECT,
} from "../delebot/slack/participation_messages.ts";
import {
  inviteCollaborators,
  requestTaskAction,
  type TaskParticipation,
} from "../delebot/tasks/participation.ts";
import { createTask } from "../delebot/tasks/service.ts";
import type { Task, TaskAccess } from "../delebot/tasks/models.ts";
import { assert, MemoryTaskRepository } from "./task_fixtures.ts";

type ParticipatingTask = Task & { participation?: TaskParticipation };

async function fixture() {
  const repository = new MemoryTaskRepository();
  const { task } = await createTask(
    {
      name: "Review <script>",
      assignees: ["UALICE"],
      editPerms: ["UADMIN"],
      viewPerms: ["all"],
    },
    { channelId: "DORIGIN", messageTs: "1.1", userId: "UCREATOR" },
    repository,
    { userId: "UCREATOR", teamIds: [] },
  );
  task.assignmentResponses = { UALICE: { status: "accepted" } };
  await repository.save(task);
  const posts: Array<Parameters<ParticipationClient["chat"]["postMessage"]>[0]> = [];
  const updates: Array<Parameters<ParticipationClient["chat"]["update"]>[0]> = [];
  const completed: string[] = [];
  const failed = new Set<string>();
  const accesses: Record<string, TaskAccess> = {
    UALICE: { userId: "UALICE", teamIds: [] },
    UBOB: { userId: "UBOB", teamIds: [] },
    UADMIN: { userId: "UADMIN", teamIds: ["SADMINS"] },
    UOTHERADMIN: { userId: "UOTHERADMIN", teamIds: ["SADMINS"] },
  };
  const client: ParticipationClient = {
    conversations: {
      open: ({ users }) => Promise.resolve({ ok: true, channel: { id: `D${users}` } }),
    },
    chat: {
      postMessage: (args) => {
        if (failed.has(args.channel)) return Promise.resolve({ ok: false });
        posts.push(args);
        return Promise.resolve({ ok: true, ts: `10.${posts.length}` });
      },
      update: (args) => {
        updates.push(args);
        return Promise.resolve({ ok: true });
      },
      delete: () => Promise.resolve({ ok: true }),
    },
    usergroups: {
      users: {
        list: ({ usergroup, team_id }) => {
          assert(team_id === "TWORKSPACE");
          return Promise.resolve({
            ok: true,
            users: usergroup === "SADMINS" ? ["UADMIN", "UOTHERADMIN"] : [],
          });
        },
      },
    },
    functions: {
      completeSuccess: ({ function_execution_id }) => {
        completed.push(function_execution_id);
        return Promise.resolve({ ok: true });
      },
    },
  };
  const loadAccess = (_task: Task, userId: string) =>
    Promise.resolve(accesses[userId] ?? { userId, teamIds: [] });
  const dependencies: ParticipationDependencies = {
    client,
    repository,
    loadAccess,
    notificationStore: {
      get: () => Promise.resolve(null),
      save: () => Promise.resolve(),
    },
  };
  const notify = (task: ParticipatingTask) =>
    notifyParticipation(
      task,
      "TWORKSPACE",
      client,
      { loadAccess, executionId: "FXTEST" },
      repository,
    );
  const latest = () => repository.findById(task.id) as Promise<ParticipatingTask>;
  async function action(actionId: string, userId: string): Promise<ParticipationAction> {
    const current = await latest();
    const [eventKey, delivery] = Object.entries(
      current.participation?.deliveryEvents ?? {},
    ).reverse().find(([, event]) => event.deliveries?.[userId])!;
    const binding = delivery.deliveries![userId];
    return {
      actionId,
      userId,
      executionId: binding.executionId,
      channelId: binding.channelId!,
      messageTs: binding.messageTs!,
      actionTs: `20.${posts.length}`,
      value: JSON.stringify({
        taskId: task.id,
        eventKey,
        recipientId: userId,
        bindingId: binding.id,
      }),
    };
  }
  async function invite(users = ["UBOB"]) {
    return await inviteCollaborators(
      await latest(),
      users,
      { channelId: "DALICE", messageTs: "2.1", userId: "UALICE" },
      repository,
      accesses.UALICE,
    );
  }
  async function request(kind: "complete" | "delete" = "complete") {
    return await requestTaskAction(
      await latest(),
      kind,
      { channelId: "DBOB", messageTs: "2.2", userId: "UBOB" },
      repository,
      accesses.UBOB,
    );
  }
  return {
    task,
    repository,
    client,
    posts,
    updates,
    completed,
    failed,
    accesses,
    dependencies,
    notify,
    latest,
    action,
    invite,
    request,
  };
}

Deno.test("collaboration delivery binds controls, escapes task text and deduplicates concurrent delivery retries", async () => {
  const f = await fixture();
  const invited = await f.invite();
  const deliveries = await Promise.all([f.notify(invited.task), f.notify(invited.task)]);
  assert(deliveries.every((result) => result.failed.length === 0));
  assert(f.posts.length === 1 && f.posts[0].channel === "DUBOB");
  assert(f.posts[0].text.includes("Review &lt;script&gt;"));
  const blocks = JSON.stringify(f.posts[0].blocks);
  assert(blocks.includes(COLLAB_ACCEPT) && blocks.includes(COLLAB_REJECT));
  assert(!blocks.includes(REQUEST_APPROVE));
  assert((await f.latest()).assignees.join() === "UALICE");
  assert(
    (f.posts[0] as unknown as { client_msg_id: string }).client_msg_id.length === 36,
  );
});

Deno.test("collaboration acceptance changes only collaborator membership and removes its buttons", async () => {
  const f = await fixture();
  await f.notify((await f.invite()).task);
  const action = await f.action(COLLAB_ACCEPT, "UBOB");
  const result = await handleParticipationAction(action, f.dependencies);
  assert(result.ok, result.error);
  assert((await f.latest()).participation?.collaborators.UBOB.status === "accepted");
  assert((await f.latest()).assignees.join() === "UALICE");
  assert(
    f.updates.at(-1)?.blocks.length === 0 && f.updates.at(-1)?.text.includes("accepted"),
  );
  assert(f.completed.join() === "FXTEST");
  assert((await handleParticipationAction(action, f.dependencies)).ok);
  assert(f.posts.length === 1 && f.completed.length === 1);
});

Deno.test("participation buttons reject forged recipients, containers, executions and action types", async () => {
  const f = await fixture();
  await f.notify((await f.invite()).task);
  const action = await f.action(COLLAB_ACCEPT, "UBOB");
  const writes = f.repository.writes;
  for (
    const change of [
      { userId: "UALICE" },
      { channelId: "DOTHER" },
      { messageTs: "99.1" },
      { executionId: "FXOTHER" },
      { actionId: REQUEST_APPROVE },
    ]
  ) {
    const result = await handleParticipationAction(
      { ...action, ...change },
      f.dependencies,
    );
    assert(!result.ok && !result.error?.includes(f.task.name));
  }
  assert(
    f.repository.writes === writes &&
      (await f.latest()).participation?.collaborators.UBOB.status === "pending",
  );
});

Deno.test("approval requests expand access teams, then one approval resolves every access holder's controls", async () => {
  const f = await fixture();
  await f.repository.save({ ...await f.latest(), editPerms: ["SADMINS"] });
  const requested = await f.request();
  assert((await f.notify(requested.task)).failed.length === 0);
  assert(f.posts.map((post) => post.channel).sort().join() === "DUADMIN,DUOTHERADMIN");
  const result = await handleParticipationAction(
    await f.action(REQUEST_APPROVE, "UADMIN"),
    f.dependencies,
  );
  assert(result.ok, result.error);
  assert((await f.latest()).completed);
  assert(
    f.updates.length === 2 && f.updates.every((update) => update.blocks.length === 0),
  );
  assert(f.completed.join() === "FXTEST");
});

Deno.test("a previously permitted access holder cannot approve after their access is revoked", async () => {
  const f = await fixture();
  await f.notify((await f.request()).task);
  const action = await f.action(REQUEST_APPROVE, "UADMIN");
  await f.repository.save({ ...await f.latest(), editPerms: ["UNEW"] });
  const result = await handleParticipationAction(action, f.dependencies);
  assert(!result.ok && result.error?.includes("access"));
  assert(!(await f.latest()).completed);
});

Deno.test("approval rejection leaves the task unchanged and an approved deletion retains a tombstone", async () => {
  for (const reject of [false, true]) {
    const f = await fixture();
    await f.notify((await f.request("delete")).task);
    const result = await handleParticipationAction(
      await f.action(reject ? REQUEST_REJECT : REQUEST_APPROVE, "UADMIN"),
      f.dependencies,
    );
    assert(result.ok, result.error);
    const current = await f.latest();
    assert(!!current.deleted === !reject && !current.completed);
    assert(
      Object.values(current.participation!.requests)[0].status ===
        (reject ? "rejected" : "approved"),
    );
    assert(f.updates.at(-1)?.blocks.length === 0);
  }
});

Deno.test("failed participation sends resume the same durable binding without duplicating successful messages", async () => {
  const f = await fixture();
  const invited = await f.invite(["UBOB", "UOTHERADMIN"]);
  f.failed.add("DUBOB");
  assert((await f.notify(invited.task)).failed.includes("UBOB"));
  const initialId =
    (await f.latest()).participation!.deliveryEvents["DALICE:2.1"].deliveries!.UBOB.id;
  assert(f.posts.length === 1);
  f.failed.clear();
  assert((await f.notify(await f.latest())).failed.length === 0);
  assert(Number(f.posts.length) === 2);
  assert(
    (await f.latest()).participation!.deliveryEvents["DALICE:2.1"].deliveries!.UBOB.id ===
      initialId,
  );
  await f.notify(await f.latest());
  assert(Number(f.posts.length) === 2);
});

Deno.test("completion performed outside approval controls closes an obsolete pending completion request", async () => {
  const f = await fixture();
  await f.notify((await f.request()).task);
  const current = await f.latest();
  await f.repository.save({ ...current, completed: true, status: "completed" });
  const result = await f.notify(await f.latest());
  assert(result.failed.length === 0 && f.posts.length === 1);
  assert(
    Object.values((await f.latest()).participation!.requests)[0].status === "cancelled",
  );
  assert(f.updates.at(-1)?.blocks.length === 0);
});

Deno.test("failed conversation-context bookkeeping retries without resending a delivered invitation", async () => {
  const f = await fixture();
  const invited = await f.invite();
  let failContext = true;
  let remembered = 0;
  const context = {
    loadAccess: f.dependencies.loadAccess,
    executionId: "FXTEST",
    rememberTask: () => {
      if (failContext) return Promise.reject(new Error("temporary failure"));
      remembered++;
      return Promise.resolve();
    },
  };
  assert(
    (await notifyParticipation(
      invited.task,
      "TWORKSPACE",
      f.client,
      context,
      f.repository,
    )).failed.includes("UBOB"),
  );
  assert(f.posts.length === 1);
  failContext = false;
  assert(
    (await notifyParticipation(
      await f.latest(),
      "TWORKSPACE",
      f.client,
      context,
      f.repository,
    )).failed.length === 0,
  );
  assert(f.posts.length === 1 && remembered === 1);
});

Deno.test("an unsent invitation retry binds to the workflow that successfully posts it", async () => {
  const f = await fixture();
  const invited = await f.invite();
  f.failed.add("DUBOB");
  assert((await f.notify(invited.task)).failed.includes("UBOB"));
  f.failed.clear();
  const retried = await notifyParticipation(await f.latest(), "TWORKSPACE", f.client, {
    loadAccess: f.dependencies.loadAccess,
    executionId: "FXRETRY",
  }, f.repository);
  assert(!retried.failed.length && f.posts.length === 1);
  const action = await f.action(COLLAB_ACCEPT, "UBOB");
  assert(action.executionId === "FXRETRY");
  assert((await handleParticipationAction(action, f.dependencies)).ok);
});
