import {
  type AssignmentAction,
  type AssignmentClient,
  type AssignmentDependencies,
  type AssignmentSubmission,
  handleAssignmentAction,
  handleAssignmentSubmission,
} from "../delebot/slack/actions.ts";
import {
  ASSIGNMENT_ACCEPT,
  ASSIGNMENT_DELEGATE,
  ASSIGNMENT_REJECT,
  type NotificationBatch,
  type NotificationStore,
  notifyTaskAssignments,
} from "../delebot/slack/notifications.ts";
import type { TaskAccess, TaskInput } from "../delebot/tasks/models.ts";
import { createTask } from "../delebot/tasks/service.ts";
import { assert, MemoryTaskRepository } from "./task_fixtures.ts";

const source = {
  channelId: "CSECURITY",
  messageTs: "1793950000.000001",
  userId: "UCREATOR",
};
const creator = { userId: source.userId, teamIds: [] };
const executionId = "FXSECURITY";

class SecurityStore implements NotificationStore {
  rows = new Map<string, NotificationBatch>();
  writes = 0;
  failTerminalSave = false;

  get(id: string): Promise<NotificationBatch | null> {
    return Promise.resolve(structuredClone(this.rows.get(id) ?? null));
  }

  save(batch: NotificationBatch): Promise<void> {
    if (
      this.failTerminalSave &&
      Object.values(batch.invitations ?? {}).some((invitation) =>
        invitation.status === "accepted" || invitation.status === "rejected" ||
        invitation.status === "delegated"
      )
    ) {
      this.failTerminalSave = false;
      return Promise.reject(new Error("temporary notification write failure"));
    }
    this.writes++;
    this.rows.set(batch.id, structuredClone(batch));
    return Promise.resolve();
  }
}

async function securityFixture(draft: Partial<TaskInput> = {}) {
  const repository = new MemoryTaskRepository();
  const store = new SecurityStore();
  const sent: Parameters<AssignmentClient["chat"]["postMessage"]>[0][] = [];
  const updates: Parameters<AssignmentClient["chat"]["update"]>[0][] = [];
  const deletions: Parameters<AssignmentClient["chat"]["delete"]>[0][] = [];
  const modals: Parameters<AssignmentClient["views"]["open"]>[0][] = [];
  const completions: string[] = [];
  const members: Record<string, string[]> = { SFRONTEND: ["UALICE"] };
  const accesses: Record<string, TaskAccess> = {
    UALICE: { userId: "UALICE", teamIds: [] },
    UBOB: { userId: "UBOB", teamIds: [] },
  };
  const failures = { updates: 0, deletions: 0 };
  const client: AssignmentClient = {
    conversations: {
      open: ({ users }) =>
        Promise.resolve({ ok: true, channel: { id: `D${users.slice(1)}` } }),
    },
    chat: {
      postMessage: (args) => {
        sent.push(args);
        return Promise.resolve({ ok: true, ts: `11.${sent.length}` });
      },
      update: (args) => {
        updates.push(args);
        if (failures.updates-- > 0) {
          return Promise.resolve({ ok: false, error: "temporary_failure" });
        }
        return Promise.resolve({ ok: true });
      },
      delete: (args) => {
        deletions.push(args);
        if (failures.deletions-- > 0) {
          return Promise.resolve({ ok: false, error: "temporary_failure" });
        }
        return Promise.resolve({ ok: true });
      },
      getPermalink: () =>
        Promise.resolve({
          ok: true,
          permalink: "https://example.slack.com/archives/CSECURITY/p1793950000000001",
        }),
    },
    usergroups: {
      list: () =>
        Promise.resolve({
          ok: true,
          usergroups: [{ id: "SFRONTEND", handle: "frontend", date_delete: 0 }],
        }),
      users: {
        list: ({ usergroup }) =>
          Promise.resolve({ ok: true, users: members[usergroup] ?? [] }),
      },
    },
    views: {
      open: (args) => {
        modals.push(args);
        return Promise.resolve({ ok: true, view: { id: `VMODAL${modals.length}` } });
      },
    },
    functions: {
      completeSuccess: ({ function_execution_id }) => {
        completions.push(function_execution_id);
        return Promise.resolve({ ok: true });
      },
    },
  };
  const dependencies: AssignmentDependencies = {
    client,
    repository,
    store,
    loadAccess: (_task, recipient) =>
      Promise.resolve(accesses[recipient] ?? { userId: recipient, teamIds: [] }),
  };
  const { task } = await createTask(
    {
      name: "Security task",
      assignees: ["UALICE"],
      viewPerms: ["all"],
      editPerms: [],
      ...draft,
    },
    source,
    repository,
    creator,
  );
  const deliver = () =>
    notifyTaskAssignments(task, "TSECURITY", client, store, {
      executionId,
      loadAccess: dependencies.loadAccess,
    });
  const delivery = await deliver();
  const batchId = `${task.id}:${source.channelId}:${source.messageTs}`;
  const invitation = () => {
    const item = store.rows.get(batchId)?.invitations?.UALICE;
    assert(item, "Expected a real delivered invitation");
    return item;
  };
  const action = (actionId = ASSIGNMENT_ACCEPT): AssignmentAction => {
    const item = invitation();
    return {
      actionId,
      value: JSON.stringify({ batchId, recipientId: "UALICE", invitationId: item.id }),
      userId: "UALICE",
      channelId: item.channelId!,
      messageTs: item.messageTs!,
      executionId,
      interactivityPointer: "POINTER",
      actionTs: "20.1",
    };
  };
  const submission = (selectedUsers = ["UBOB"]): AssignmentSubmission => {
    const item = invitation();
    assert(item.modalNonce && item.modalId, "Open a bound modal first");
    return {
      privateMetadata: JSON.stringify({
        batchId,
        recipientId: "UALICE",
        invitationId: item.id,
        nonce: item.modalNonce,
      }),
      userId: "UALICE",
      viewId: item.modalId,
      executionId,
      selectedUsers,
      teamText: "",
    };
  };
  return {
    dependencies,
    repository,
    store,
    task,
    batchId,
    delivery,
    deliver,
    invitation,
    action,
    submission,
    sent,
    updates,
    deletions,
    modals,
    completions,
    accesses,
    members,
    failures,
  };
}

Deno.test("assignment buttons bind recipient, execution, DM container and invitation identity", async () => {
  const f = await securityFixture();
  assert(f.delivery.interactive && f.sent.length === 1);
  const legitimate = f.action();
  const decoded = JSON.parse(legitimate.value);
  const forged: Partial<AssignmentAction>[] = [
    { userId: "UBOB" },
    { channelId: "DOTHER" },
    { messageTs: "99.1" },
    { executionId: "FXOTHER" },
    { value: JSON.stringify({ ...decoded, recipientId: "UBOB" }) },
    { value: JSON.stringify({ ...decoded, invitationId: crypto.randomUUID() }) },
    { value: JSON.stringify({ ...decoded, batchId: `${f.batchId}:other` }) },
  ];
  const writes = f.repository.writes;
  const notificationWrites = f.store.writes;
  for (const override of forged) {
    const result = await handleAssignmentAction(
      { ...legitimate, ...override },
      f.dependencies,
    );
    assert(!result.ok && !result.error?.includes(f.task.name));
  }
  assert(f.repository.writes === writes && f.store.writes === notificationWrites);
  assert(f.invitation().status === "pending" && !f.invitation().decision);
  assert(
    f.updates.length === 0 && f.deletions.length === 0 && f.completions.length === 0,
  );
});

Deno.test("an invitation cannot mutate another task after its source metadata changes", async () => {
  const f = await securityFixture();
  f.repository.rows.set(f.task.id, { ...f.task, channelId: "COTHER" });
  const writes = f.repository.writes;
  const result = await handleAssignmentAction(f.action(), f.dependencies);
  assert(!result.ok && f.repository.writes === writes);
  assert(f.invitation().status === "pending" && !f.invitation().decision);
});

Deno.test("a recipient with viewing permission and no editing permission can accept and reject", async () => {
  for (const actionId of [ASSIGNMENT_ACCEPT, ASSIGNMENT_REJECT]) {
    const f = await securityFixture({ viewPerms: ["UALICE"], editPerms: [] });
    const result = await handleAssignmentAction(f.action(actionId), f.dependencies);
    assert(result.ok);
    const saved = f.repository.rows.get(f.task.id)!;
    assert(saved.editPerms?.length === 0 && saved.viewPerms?.join() === "UALICE");
    if (actionId === ASSIGNMENT_ACCEPT) {
      assert(f.invitation().status === "accepted" && saved.assignees.join() === "UALICE");
      assert(
        f.updates[0]?.text.endsWith("\n\n✅ Accepted") &&
          f.updates[0]?.blocks.length === 0,
      );
    } else {
      assert(f.invitation().status === "rejected" && saved.assignees.length === 0);
      assert(f.deletions.length === 1);
    }
    assert(f.completions.includes(executionId));
  }
});

Deno.test("read-only invitation recipients cannot open a reassignment modal", async () => {
  const f = await securityFixture();
  const writes = f.repository.writes;
  const result = await handleAssignmentAction(
    f.action(ASSIGNMENT_DELEGATE),
    f.dependencies,
  );
  assert(!result.ok && /permission/i.test(result.error ?? ""));
  assert(f.modals.length === 0 && f.repository.writes === writes);
  assert(!f.invitation().decision && f.invitation().status === "pending");
});

Deno.test("rejected assignments recover after service commit, notification write failure and DM failure", async () => {
  const f = await securityFixture();
  f.store.failTerminalSave = true;
  const action = f.action(ASSIGNMENT_REJECT);
  const first = await handleAssignmentAction(action, f.dependencies);
  assert(!first.ok && f.repository.rows.get(f.task.id)?.assignees.length === 0);
  assert(
    f.invitation().status === "pending" && f.invitation().decision?.kind === "reject",
  );
  const writes = f.repository.writes;
  f.failures.deletions = 1;
  const second = await handleAssignmentAction(action, f.dependencies);
  assert(!second.ok && f.repository.writes === writes);
  assert(f.invitation().status === "rejected");
  const third = await handleAssignmentAction(action, f.dependencies);
  assert(third.ok && f.repository.writes === writes && f.deletions.length === 2);
  const applied = f.repository.rows.get(f.task.id)?.appliedEvents ?? [];
  assert(applied.filter((key) => key === "DALICE:20.1").length === 1);
});

Deno.test("accepted assignment retries only the failed DM update", async () => {
  const f = await securityFixture();
  f.failures.updates = 1;
  const action = f.action();
  assert(!(await handleAssignmentAction(action, f.dependencies)).ok);
  const writes = f.repository.writes;
  assert(f.invitation().status === "accepted");
  assert((await handleAssignmentAction(action, f.dependencies)).ok);
  assert(f.repository.writes === writes && f.updates.length === 2);
});

Deno.test("delegation modals bind actor, execution, nonce and actual modal ID", async () => {
  const f = await securityFixture({ editPerms: ["all"] });
  assert(
    (await handleAssignmentAction(f.action(ASSIGNMENT_DELEGATE), f.dependencies)).ok,
  );
  const legitimate = f.submission();
  const decoded = JSON.parse(legitimate.privateMetadata);
  const writes = f.repository.writes;
  for (
    const override of [
      { userId: "UBOB" },
      { viewId: "VOTHER" },
      { executionId: "FXOTHER" },
      { privateMetadata: JSON.stringify({ ...decoded, nonce: crypto.randomUUID() }) },
      { privateMetadata: JSON.stringify({ ...decoded, recipientId: "UBOB" }) },
    ]
  ) {
    const result = await handleAssignmentSubmission(
      { ...legitimate, ...override },
      f.dependencies,
    );
    assert(!result.ok && f.repository.writes === writes);
  }
  assert(!f.invitation().decision && f.sent.length === 1);
  assert((await handleAssignmentSubmission(legitimate, f.dependencies)).ok);
  assert(f.repository.rows.get(f.task.id)?.assignees.join() === "UBOB");
});

Deno.test("invalid self delegation clears its intent so the same modal can be corrected", async () => {
  const f = await securityFixture({ editPerms: ["all"] });
  assert(
    (await handleAssignmentAction(f.action(ASSIGNMENT_DELEGATE), f.dependencies)).ok,
  );
  const writes = f.repository.writes;
  const invalid = await handleAssignmentSubmission(
    f.submission(["UALICE"]),
    f.dependencies,
  );
  assert(!invalid.ok && /another/i.test(invalid.error ?? ""));
  assert(
    f.repository.writes === writes && !f.invitation().decision &&
      f.invitation().status === "pending",
  );
  assert((await handleAssignmentSubmission(f.submission(["UBOB"]), f.dependencies)).ok);
  assert(f.invitation().status === "delegated");
  assert(f.repository.rows.get(f.task.id)?.assignees.join() === "UBOB");
});

Deno.test("group invitations require fresh assignment membership even with public viewing", async () => {
  const f = await securityFixture({ assignees: ["SFRONTEND"], editPerms: ["all"] });
  assert(
    f.members.SFRONTEND.includes("UALICE") && f.accesses.UALICE.teamIds.length === 0,
  );
  assert(f.sent.length === 0 && !f.delivery.interactive);
  assert(f.store.rows.get(f.batchId)?.cancelled.includes("UALICE"));
  const directlyAssigned = await securityFixture({ assignees: ["SFRONTEND", "UALICE"] });
  assert(directlyAssigned.sent.length === 1 && directlyAssigned.delivery.interactive);
});

Deno.test("revoking group membership or viewing permission invalidates an existing invitation", async () => {
  const f = await securityFixture({
    assignees: ["SFRONTEND", "UALICE"],
    viewPerms: ["all"],
  });
  // Remove the direct assignment; the user's fresh membership does not include the group.
  f.repository.rows.set(f.task.id, { ...f.task, assignees: ["SFRONTEND"] });
  const writes = f.repository.writes;
  assert(!(await handleAssignmentAction(f.action(), f.dependencies)).ok);
  assert(f.repository.writes === writes && f.invitation().status === "cancelled");
  assert(f.deletions.length === 1);

  const restricted = await securityFixture();
  restricted.repository.rows.set(restricted.task.id, {
    ...restricted.task,
    viewPerms: ["UBOB"],
  });
  const restrictedWrites = restricted.repository.writes;
  assert(
    !(await handleAssignmentAction(restricted.action(), restricted.dependencies)).ok,
  );
  assert(
    restricted.repository.writes === restrictedWrites &&
      restricted.invitation().status === "cancelled",
  );
  assert(restricted.deletions.length === 1);
});
