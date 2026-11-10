import {
  appendTargetsToAssignmentTree,
  assignmentInvitationKey,
  AssignmentTreeError,
  assignmentTreePrincipals,
  createAssignmentTree,
  invitationRecipients,
  pendingAssignmentNodes,
  respondInAssignmentTree,
  seedLegacyAssignmentTree,
  type TaskAssignmentTree,
  validateAssignmentTree,
} from "../delebot/tasks/assignment_tree.ts";
import { assert } from "./task_fixtures.ts";

function reject(tree: TaskAssignmentTree, userId: string) {
  return respondInAssignmentTree(tree, { userId, kind: "reject" });
}
function delegate(
  tree: TaskAssignmentTree,
  userId: string,
  assignees: string[],
  groupMembers: Record<string, string[]> = {},
) {
  return respondInAssignmentTree(tree, {
    userId,
    kind: "delegate",
    assignees,
    groupMembers,
  });
}
function pending(tree: TaskAssignmentTree) {
  return [...new Set(pendingAssignmentNodes(tree).map((entry) => entry.principalId))]
    .sort().join();
}
function mustFail(action: () => unknown) {
  try {
    action();
  } catch (error) {
    assert(error instanceof AssignmentTreeError);
    return;
  }
  throw new Error("Expected invalid assignment operation to fail");
}

Deno.test("a squad returns to its assigner only after every member rejects", () => {
  const original = createAssignmentTree("UCREATOR", ["SSQUAD"], {
    SSQUAD: ["UALICE", "UBOB"],
  });
  const first = reject(original, "UALICE");
  assert(first.inviteNodeIds.length === 0);
  assert(pending(first.tree) === "UBOB");
  assert(assignmentTreePrincipals(first.tree).join() === "SSQUAD");
  assert(pending(original) === "UALICE,UBOB", "Pure mutations preserve caller state");
  const last = reject(first.tree, "UBOB");
  assert(invitationRecipients(last.tree, last.inviteNodeIds).join() === "UCREATOR");
  assert(assignmentTreePrincipals(last.tree).join() === "UCREATOR");
  assert(last.tree.nodes[last.tree.rootId].returned);
  assert(last.tree.nodes[last.tree.rootId].returnedBy === "UBOB");
});

Deno.test("delegating one member's branch keeps other squad members pending", () => {
  const original = createAssignmentTree("UCREATOR", ["SSQUAD"], {
    SSQUAD: ["UALICE", "UBOB"],
  });
  const branched = delegate(original, "UALICE", ["UCAROL"]);
  assert(pending(branched.tree) === "UBOB,UCAROL");
  assert(assignmentTreePrincipals(branched.tree).sort().join() === "SSQUAD,UCAROL");
  assert(invitationRecipients(branched.tree, branched.inviteNodeIds).join() === "UCAROL");
  const rejected = reject(branched.tree, "UCAROL");
  assert(pending(rejected.tree) === "UALICE,UBOB");
  assert(invitationRecipients(rejected.tree, rejected.inviteNodeIds).join() === "UALICE");
  assert(!rejected.tree.nodes[rejected.tree.rootId].returned);
});

Deno.test("fanout waits for all sibling branches before returning to the delegator", () => {
  let tree = createAssignmentTree("UA", ["UB", "UC"]);
  tree = delegate(tree, "UC", ["UD"]).tree;
  assert(pending(tree) === "UB,UD");
  tree = reject(tree, "UB").tree;
  assert(pending(tree) === "UD");
  const backToC = reject(tree, "UD");
  assert(pending(backToC.tree) === "UC");
  const backToA = reject(backToC.tree, "UC");
  assert(invitationRecipients(backToA.tree, backToA.inviteNodeIds).join() === "UA");
  assert(pending(backToA.tree) === "UA");
});

Deno.test("deep squad-to-squad-to-person-to-squad delegation unwinds one stack frame at a time", () => {
  let tree = createAssignmentTree("UCREATOR", ["SX"], { SX: ["UX1", "UX2"] });
  tree = delegate(tree, "UX1", ["SY"], { SY: ["UY1", "UY2"] }).tree;
  tree = delegate(tree, "UY1", ["UA"]).tree;
  tree = delegate(tree, "UA", ["SZ"], { SZ: ["UZ1", "UZ2"] }).tree;
  tree = reject(tree, "UX2").tree;
  tree = reject(tree, "UY2").tree;
  const firstZ = reject(tree, "UZ1");
  assert(pending(firstZ.tree) === "UZ2" && firstZ.inviteNodeIds.length === 0);
  const lastZ = reject(firstZ.tree, "UZ2");
  assert(pending(lastZ.tree) === "UA");
  const backY = reject(lastZ.tree, "UA");
  assert(pending(backY.tree) === "UY1");
  const backX = reject(backY.tree, "UY1");
  assert(pending(backX.tree) === "UX1");
  const backCreator = reject(backX.tree, "UX1");
  assert(pending(backCreator.tree) === "UCREATOR");
  const deleted = reject(backCreator.tree, "UCREATOR");
  assert(deleted.deleted && deleted.tree.deleted && pending(deleted.tree) === "");
  assert(assignmentTreePrincipals(deleted.tree).length === 0);
});

Deno.test("one acceptance assigns a single owner and prevents competing responses", () => {
  const original = createAssignmentTree("UCREATOR", ["UB", "SSQUAD"], {
    SSQUAD: ["UC", "UD"],
  });
  const branched = delegate(original, "UC", ["UE"]).tree;
  const accepted = respondInAssignmentTree(branched, { userId: "UE", kind: "accept" });
  assert(accepted.tree.acceptedBy === "UE");
  assert(assignmentTreePrincipals(accepted.tree).join() === "UE");
  assert(pending(accepted.tree) === "");
  for (const userId of ["UB", "UC", "UD"]) {
    mustFail(() => respondInAssignmentTree(accepted.tree, { userId, kind: "accept" }));
    mustFail(() => delegate(accepted.tree, userId, ["UNEW"]));
  }
  assert(
    Object.values(accepted.tree.nodes).filter((entry) => entry.status === "accepted")
      .length === 1,
  );
});

Deno.test("accepted owner can delegate again without reviving cancelled competitors", () => {
  const tree = createAssignmentTree("UCREATOR", ["UA", "UB"]);
  const accepted = respondInAssignmentTree(tree, { userId: "UA", kind: "accept" }).tree;
  const reopened = delegate(accepted, "UA", ["UC"]);
  assert(!reopened.tree.acceptedBy && pending(reopened.tree) === "UC");
  assert(
    Object.values(reopened.tree.nodes).some((entry) =>
      entry.principalId === "UB" && entry.status === "cancelled"
    ),
  );
  const returned = reject(reopened.tree, "UC");
  assert(pending(returned.tree) === "UA");
  mustFail(() =>
    respondInAssignmentTree(returned.tree, { userId: "UB", kind: "accept" })
  );
});

Deno.test("accepted owner rejection returns to the stack without reviving competitors", () => {
  const initial = createAssignmentTree("UCREATOR", ["UA", "UB"]);
  const accepted =
    respondInAssignmentTree(initial, { userId: "UA", kind: "accept" }).tree;
  const returned = reject(accepted, "UA");
  assert(pending(returned.tree) === "UCREATOR");
  assert(!returned.tree.acceptedBy);
  assert(
    Object.values(returned.tree.nodes).find((entry) => entry.principalId === "UB")
      ?.status === "cancelled",
  );
});

Deno.test("creator self-assignment rejects without deleting until it has bounced back", () => {
  const initial = createAssignmentTree("UCREATOR", ["UCREATOR"]);
  assert(pending(initial) === "UCREATOR");
  assert(initial.nodes[initial.rootId].explicit === true);
  const rejected = reject(initial, "UCREATOR");
  assert(!rejected.deleted && !rejected.tree.deleted && pending(rejected.tree) === "");
  const delegated = delegate(initial, "UCREATOR", ["UA"]);
  const returned = reject(delegated.tree, "UA");
  assert(pending(returned.tree) === "UCREATOR");
  assert(reject(returned.tree, "UCREATOR").deleted);
});

Deno.test("fresh return generations invalidate old invitation controls", () => {
  const tree = createAssignmentTree("UCREATOR", ["UA"]);
  const leaf = pendingAssignmentNodes(tree)[0];
  const outgoing = delegate(tree, "UA", ["UB"]);
  const returned = reject(outgoing.tree, "UB");
  const fresh = returned.tree.nodes[leaf.id];
  assert(fresh.generation === leaf.generation + 1);
  assert(assignmentInvitationKey(fresh) !== assignmentInvitationKey(leaf));
  mustFail(() =>
    respondInAssignmentTree(returned.tree, {
      userId: "UA",
      kind: "accept",
      nodeId: leaf.id,
      generation: leaf.generation,
    })
  );
  assert(
    respondInAssignmentTree(returned.tree, {
      userId: "UA",
      kind: "accept",
      nodeId: fresh.id,
      generation: fresh.generation,
    }).tree.acceptedBy === "UA",
  );
});

Deno.test("overlapping squad membership needs one user rejection and one recipient notification", () => {
  const tree = createAssignmentTree("UCREATOR", ["SX", "SY"], {
    SX: ["UA", "UB"],
    SY: ["UA", "UC"],
  });
  const ids = pendingAssignmentNodes(tree).map((entry) => entry.id);
  assert(invitationRecipients(tree, ids).sort().join() === "UA,UB,UC");
  const rejected = reject(tree, "UA");
  assert(pending(rejected.tree) === "UB,UC");
  assert(
    Object.values(rejected.tree.nodes).filter((entry) =>
      entry.principalId === "UA" && entry.status === "rejected"
    ).length === 2,
  );
});

Deno.test("empty and unverified squads cannot create or replace live branches", () => {
  mustFail(() => createAssignmentTree("UCREATOR", ["SX"], {}));
  mustFail(() => createAssignmentTree("UCREATOR", ["SX"], { SX: [] }));
  const tree = createAssignmentTree("UCREATOR", ["UA"]);
  const before = JSON.stringify(tree);
  mustFail(() => delegate(tree, "UA", ["SX"], { SX: [] }));
  assert(JSON.stringify(tree) === before);
  mustFail(() => delegate(tree, "UA", ["UA"]));
});

Deno.test("delegation notes are bounded and attached only to the new invitation leaves", () => {
  const tree = createAssignmentTree("UCREATOR", ["UA"]);
  const delegated = respondInAssignmentTree(tree, {
    userId: "UA",
    kind: "delegate",
    assignees: ["SX"],
    groupMembers: { SX: ["UB", "UC"] },
    note: "  Review this today.  ",
  });
  assert(
    delegated.inviteNodeIds.every((id) =>
      delegated.tree.nodes[id].note === "Review this today."
    ),
  );
  mustFail(() =>
    respondInAssignmentTree(tree, {
      userId: "UA",
      kind: "delegate",
      assignees: ["UB"],
      note: "x".repeat(2001),
    })
  );
  const returned = reject(reject(delegated.tree, "UB").tree, "UC");
  assert(returned.tree.nodes[returned.inviteNodeIds[0]].note === undefined);
});

Deno.test("flat legacy return paths retain shared delegators and fanout", () => {
  const tree = seedLegacyAssignmentTree({
    createdBy: "UCREATOR",
    assignees: ["UB", "UC"],
    assignmentBased: true,
    assignmentResponses: {
      UB: { status: "pending", returnTo: ["UA", "UCREATOR"] },
      UC: { status: "pending", returnTo: ["UA", "UCREATOR"] },
    },
  });
  assert(
    Object.values(tree.nodes).filter((entry) => entry.principalId === "UA").length === 1,
  );
  const first = reject(tree, "UB");
  assert(first.inviteNodeIds.length === 0);
  const second = reject(first.tree, "UC");
  assert(pending(second.tree) === "UA");
});

Deno.test("legacy delegation history reconstructs an absent explicit return stack", () => {
  const tree = seedLegacyAssignmentTree({
    createdBy: "UCREATOR",
    assignees: ["UB"],
    assignmentResponses: {
      UA: { status: "delegated", delegatedTo: ["UB"] },
      UB: { status: "pending" },
    },
  });
  assert(pending(reject(tree, "UB").tree) === "UA");
});

Deno.test("legacy accepted squad members become the single migrated owner", () => {
  const tree = seedLegacyAssignmentTree({
    createdBy: "UCREATOR",
    assignees: ["SX"],
    assignmentResponses: { UA: { status: "accepted" } },
  }, { SX: ["UA", "UB"] });
  assert(tree.acceptedBy === "UA" && pending(tree) === "");
});

Deno.test("persisted trees reject bad parents, cycles, stale counters, and multiple accepted owners", () => {
  const tree = createAssignmentTree("UCREATOR", ["UA", "UB"]);
  assert(validateAssignmentTree(JSON.parse(JSON.stringify(tree))).version === 1);
  const root = tree.rootId;
  const [a, b] = pendingAssignmentNodes(tree).map((entry) => entry.id);
  for (
    const mutate of [
      (value: TaskAssignmentTree) => {
        value.nodes[a].parentId = b;
      },
      (value: TaskAssignmentTree) => {
        value.nodes[a].children.push(root);
        value.nodes[root].parentId = a;
      },
      (value: TaskAssignmentTree) => {
        value.nextId = 1;
      },
      (value: TaskAssignmentTree) => {
        value.nodes[a].status = "accepted";
        value.nodes[b].status = "accepted";
        value.acceptedBy = "UA";
        value.acceptedNodeId = a;
      },
      (value: TaskAssignmentTree) => {
        value.nodes[a].generation = -1;
      },
      (value: TaskAssignmentTree) => {
        value.nodes[root].status = "cancelled";
      },
    ]
  ) {
    const invalid = structuredClone(tree);
    mutate(invalid);
    mustFail(() => validateAssignmentTree(invalid));
  }
});

Deno.test("additive assignment keeps existing invitation generations and only invites new branches", () => {
  const tree = createAssignmentTree("UCREATOR", ["UA"]);
  const previous = pendingAssignmentNodes(tree)[0];
  const added = appendTargetsToAssignmentTree(tree, ["UB", "SX"], { SX: ["UC"] });
  assert(
    assignmentInvitationKey(added.tree.nodes[previous.id]) ===
      assignmentInvitationKey(previous),
  );
  assert(invitationRecipients(added.tree, added.inviteNodeIds).join() === "UB,UC");
  assert(pending(added.tree) === "UA,UB,UC");
});
