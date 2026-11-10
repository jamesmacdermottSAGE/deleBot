export type AssignmentTreeStatus =
  | "pending"
  | "delegated"
  | "rejected"
  | "accepted"
  | "cancelled";

export interface AssignmentTreeNode {
  id: string;
  principalId: string;
  kind: "user" | "team";
  parentId?: string;
  children: string[];
  status: AssignmentTreeStatus;
  /** Changes when the same delegator receives a returned assignment. */
  generation: number;
  returned?: boolean;
  returnedBy?: string;
  /** The creator root was explicitly assigned, rather than only a return address. */
  explicit?: boolean;
  note?: string;
}

export interface TaskAssignmentTree {
  version: 1;
  rootId: string;
  nextId: number;
  nodes: Record<string, AssignmentTreeNode>;
  acceptedBy?: string;
  acceptedNodeId?: string;
  deleted?: boolean;
}

export type AssignmentGroupMembers = Record<string, string[]>;

export class AssignmentTreeError extends Error {}

const userPattern = /^[UW][A-Z0-9]+$/;
const groupPattern = /^S[A-Z0-9]+$/;
const statuses = ["pending", "delegated", "rejected", "accepted", "cancelled"];

function node(
  tree: TaskAssignmentTree,
  principalId: string,
  parentId?: string,
  note?: string,
): AssignmentTreeNode {
  const id = `n${tree.nextId++}`;
  const value: AssignmentTreeNode = {
    id,
    principalId,
    kind: groupPattern.test(principalId) ? "team" : "user",
    children: [],
    status: "pending",
    generation: 0,
    ...(parentId ? { parentId } : {}),
    ...(note?.trim() ? { note: note.trim() } : {}),
  };
  tree.nodes[id] = value;
  if (parentId) tree.nodes[parentId].children.push(id);
  return value;
}

function addTargets(
  tree: TaskAssignmentTree,
  parentId: string,
  assignees: string[],
  groups: AssignmentGroupMembers,
  note?: string,
): string[] {
  const invited: string[] = [];
  for (const principalId of new Set(assignees)) {
    if (!userPattern.test(principalId) && !groupPattern.test(principalId)) {
      throw new AssignmentTreeError("Choose people or teams for delegation.");
    }
    const target = node(tree, principalId, parentId, note);
    if (target.kind === "user") invited.push(target.id);
    else {
      const members = groups[principalId];
      if (
        !Array.isArray(members) || !members.length ||
        !members.every((id) => typeof id === "string" && userPattern.test(id))
      ) {
        throw new AssignmentTreeError(
          "Choose an active team with at least one verified member.",
        );
      }
      target.status = "delegated";
      for (const member of new Set(members)) {
        invited.push(node(tree, member, target.id, note).id);
      }
    }
  }
  return invited;
}

/** The creator is the root of the return stack, rather than a competing assignee. */
export function createAssignmentTree(
  creatorId: string,
  assignees: string[],
  groups: AssignmentGroupMembers = {},
): TaskAssignmentTree {
  if (typeof creatorId !== "string" || !userPattern.test(creatorId)) {
    throw new AssignmentTreeError("Invalid task creator.");
  }
  const tree: TaskAssignmentTree = { version: 1, rootId: "n0", nextId: 0, nodes: {} };
  const root = node(tree, creatorId);
  if (!assignees.length) root.status = "cancelled";
  else if (assignees.length === 1 && assignees[0] === creatorId) {
    root.status = "pending";
    root.explicit = true;
  } else {
    root.status = "delegated";
    addTargets(tree, root.id, assignees, groups);
  }
  return tree;
}

export function assignmentInvitationKey(value: AssignmentTreeNode): string {
  return `${value.id}:${value.generation}`;
}

export function pendingAssignmentNodes(tree: TaskAssignmentTree): AssignmentTreeNode[] {
  if (tree.deleted || tree.acceptedBy) return [];
  return Object.values(tree.nodes).filter((value) =>
    value.kind === "user" && value.status === "pending"
  );
}

export function invitationRecipients(
  tree: TaskAssignmentTree,
  inviteNodeIds: string[],
): string[] {
  return [
    ...new Set(
      inviteNodeIds.map((id) => tree.nodes[id]).filter((value) =>
        value?.kind === "user" && value.status === "pending"
      ).map((value) => value.principalId),
    ),
  ];
}

function live(tree: TaskAssignmentTree, value: AssignmentTreeNode): boolean {
  return value.status === "pending" || value.status === "accepted" ||
    (value.status === "delegated" &&
      value.children.some((id) => live(tree, tree.nodes[id])));
}

/** Keep active squad principals visible while any member's branch is unresolved. */
export function assignmentTreePrincipals(tree: TaskAssignmentTree): string[] {
  if (tree.deleted) return [];
  if (tree.acceptedBy) return [tree.acceptedBy];
  const principals: string[] = [];
  for (const value of Object.values(tree.nodes)) {
    if (value.kind === "team" && live(tree, value)) principals.push(value.principalId);
    else if (value.kind === "user" && value.status === "pending") {
      // Team membership is represented by its group until that member delegates
      // to a distinct branch or a returned assignment belongs directly to them.
      if (
        !value.parentId || tree.nodes[value.parentId].kind !== "team" || value.returned
      ) principals.push(value.principalId);
    }
  }
  return [...new Set(principals)];
}

function unwind(
  tree: TaskAssignmentTree,
  parentId: string | undefined,
  rejectedBy: string,
  invited: Set<string>,
) {
  if (!parentId) return;
  const parent = tree.nodes[parentId];
  if (parent.children.some((id) => live(tree, tree.nodes[id]))) return;
  if (parent.kind === "team") {
    parent.status = "rejected";
    unwind(tree, parent.parentId, rejectedBy, invited);
  } else {
    parent.status = "pending";
    parent.returned = true;
    parent.returnedBy = rejectedBy;
    parent.generation++;
    delete parent.note;
    invited.add(parent.id);
  }
}

export interface TreeAssignmentDecision {
  userId: string;
  kind: "accept" | "reject" | "delegate";
  assignees?: string[];
  groupMembers?: AssignmentGroupMembers;
  nodeId?: string;
  generation?: number;
  note?: string;
}

export interface TreeAssignmentResult {
  tree: TaskAssignmentTree;
  inviteNodeIds: string[];
  changed: boolean;
  deleted: boolean;
}

/** An additive assign command opens new branches without replacing active invitations. */
export function appendTargetsToAssignmentTree(
  input: TaskAssignmentTree,
  assignees: string[],
  groups: AssignmentGroupMembers = {},
  assignerId?: string,
): TreeAssignmentResult {
  validateAssignmentTree(input);
  if (
    input.deleted || input.acceptedBy || input.nodes[input.rootId].status !== "delegated"
  ) throw new AssignmentTreeError("This assignment needs a fresh delegation round.");
  if (!assignees.length || assignees.length > 20) {
    throw new AssignmentTreeError("Choose up to 20 people or teams.");
  }
  const tree = structuredClone(input);
  let parent = tree.nodes[tree.rootId];
  if (assignerId && assignerId !== parent.principalId) {
    if (!userPattern.test(assignerId)) throw new AssignmentTreeError("Invalid assigner.");
    parent = node(tree, assignerId, parent.id);
    parent.status = "delegated";
  }
  const inviteNodeIds = addTargets(tree, parent.id, assignees, groups);
  return {
    tree: validateAssignmentTree(tree),
    inviteNodeIds,
    changed: true,
    deleted: false,
  };
}

/** Apply to a clone: malformed targets and stale invitations never mutate caller state. */
export function respondInAssignmentTree(
  input: TaskAssignmentTree,
  decision: TreeAssignmentDecision,
): TreeAssignmentResult {
  validateAssignmentTree(input);
  if (input.deleted) throw new AssignmentTreeError("This task has been deleted.");
  if (
    !userPattern.test(decision.userId) ||
    !["accept", "reject", "delegate"].includes(decision.kind)
  ) throw new AssignmentTreeError("Invalid assignment response.");
  if (
    decision.note !== undefined &&
    (typeof decision.note !== "string" || decision.note.length > 2000)
  ) throw new AssignmentTreeError("Keep the note to 2,000 characters or fewer.");
  if (input.acceptedBy && input.acceptedBy !== decision.userId) {
    throw new AssignmentTreeError(
      `This task has already been accepted by <@${input.acceptedBy}>.`,
    );
  }
  const candidates = Object.values(input.nodes).filter((value) =>
    value.kind === "user" && value.principalId === decision.userId &&
    (value.status === "pending" ||
      (value.status === "accepted" && input.acceptedNodeId === value.id))
  );
  if (decision.nodeId) {
    const bound = candidates.find((value) => value.id === decision.nodeId);
    if (
      !bound ||
      (decision.generation !== undefined && decision.generation !== bound.generation)
    ) throw new AssignmentTreeError("This assignment invitation is no longer active.");
  }
  if (!candidates.length) {
    throw new AssignmentTreeError("You are no longer awaiting a response on this task.");
  }
  if (
    decision.kind === "delegate" &&
    (!decision.assignees?.length || decision.assignees.length > 20 ||
      decision.assignees.includes(decision.userId))
  ) throw new AssignmentTreeError("Choose one or more other people or teams, up to 20.");
  const tree = structuredClone(input);
  const invited = new Set<string>();
  if (decision.kind === "accept") {
    const accepted = tree.nodes[decision.nodeId ?? candidates[0].id];
    if (tree.acceptedBy === decision.userId && accepted.status === "accepted") {
      return { tree, inviteNodeIds: [], changed: false, deleted: false };
    }
    for (const value of Object.values(tree.nodes)) {
      if (value.status === "pending") value.status = "cancelled";
    }
    accepted.status = "accepted";
    tree.acceptedBy = accepted.principalId;
    tree.acceptedNodeId = accepted.id;
  } else {
    delete tree.acceptedBy;
    delete tree.acceptedNodeId;
    for (const candidate of candidates) {
      const current = tree.nodes[candidate.id];
      if (decision.kind === "delegate") {
        current.status = "delegated";
        addTargets(
          tree,
          current.id,
          decision.assignees!,
          decision.groupMembers ?? {},
          decision.note,
        ).forEach((id) => invited.add(id));
      } else {
        current.status = "rejected";
        if (current.id === tree.rootId) tree.deleted = !!current.returned;
        else unwind(tree, current.parentId, decision.userId, invited);
      }
    }
  }
  return {
    tree,
    inviteNodeIds: [...invited],
    changed: true,
    deleted: tree.deleted === true,
  };
}

/** Validate persisted topology, ownership and invitation generations before use. */
export function validateAssignmentTree(value: unknown): TaskAssignmentTree {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssignmentTreeError("Invalid assignment tree.");
  }
  const tree = value as TaskAssignmentTree;
  if (
    tree.version !== 1 || typeof tree.rootId !== "string" ||
    !Number.isSafeInteger(tree.nextId) || tree.nextId < 1 || !tree.nodes ||
    typeof tree.nodes !== "object" || Array.isArray(tree.nodes) ||
    !Object.hasOwn(tree.nodes, tree.rootId)
  ) throw new AssignmentTreeError("Invalid assignment tree.");
  const accepted: AssignmentTreeNode[] = [];
  for (const [id, entry] of Object.entries(tree.nodes)) {
    if (
      !entry || typeof entry !== "object" || entry.id !== id || !/^n\d+$/.test(id) ||
      Number(id.slice(1)) >= tree.nextId || !["user", "team"].includes(entry.kind) ||
      typeof entry.principalId !== "string" ||
      !(entry.kind === "user" ? userPattern : groupPattern).test(entry.principalId) ||
      !statuses.includes(entry.status) || !Number.isSafeInteger(entry.generation) ||
      entry.generation < 0 || !Array.isArray(entry.children) ||
      new Set(entry.children).size !== entry.children.length ||
      !entry.children.every((child) =>
        typeof child === "string" && Object.hasOwn(tree.nodes, child)
      ) ||
      (entry.parentId !== undefined &&
        (typeof entry.parentId !== "string" ||
          !Object.hasOwn(tree.nodes, entry.parentId))) ||
      (entry.returned !== undefined && typeof entry.returned !== "boolean") ||
      (entry.explicit !== undefined && typeof entry.explicit !== "boolean") ||
      (entry.returnedBy !== undefined &&
        (typeof entry.returnedBy !== "string" || !userPattern.test(entry.returnedBy))) ||
      (entry.note !== undefined &&
        (typeof entry.note !== "string" || entry.note.length > 2000))
    ) throw new AssignmentTreeError("Invalid assignment tree node.");
    if (entry.status === "accepted") accepted.push(entry);
    if (entry.kind === "team" && entry.status === "pending") {
      throw new AssignmentTreeError("Invalid pending team node.");
    }
    if (entry.id !== tree.rootId && !entry.parentId) {
      throw new AssignmentTreeError("Disconnected assignment tree.");
    }
    for (const child of entry.children) {
      if (tree.nodes[child].parentId !== id) {
        throw new AssignmentTreeError("Invalid assignment parent.");
      }
    }
  }
  const root = tree.nodes[tree.rootId];
  if (root.parentId || root.kind !== "user") {
    throw new AssignmentTreeError("Invalid assignment tree root.");
  }
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) throw new AssignmentTreeError("Cyclic assignment tree.");
    visited.add(id);
    for (const child of tree.nodes[id].children) visit(child);
  };
  visit(tree.rootId);
  if (visited.size !== Object.keys(tree.nodes).length) {
    throw new AssignmentTreeError("Disconnected assignment tree.");
  }
  for (const entry of Object.values(tree.nodes)) {
    if (
      entry.status !== "delegated" &&
      entry.children.some((child) => live(tree, tree.nodes[child]))
    ) throw new AssignmentTreeError("Inactive assignment ancestor has active children.");
    if (entry.kind === "team" && !entry.children.length) {
      throw new AssignmentTreeError("Empty assignment team.");
    }
  }
  if (tree.deleted !== undefined && typeof tree.deleted !== "boolean") {
    throw new AssignmentTreeError("Invalid assignment deletion state.");
  }
  if (tree.acceptedBy !== undefined) {
    if (
      !userPattern.test(tree.acceptedBy) || accepted.length !== 1 ||
      accepted[0].principalId !== tree.acceptedBy ||
      accepted[0].id !== tree.acceptedNodeId || Object.values(tree.nodes).some((entry) =>
        entry.status === "pending"
      ) || tree.deleted
    ) throw new AssignmentTreeError("Invalid accepted assignment owner.");
  } else if (accepted.length || tree.acceptedNodeId !== undefined) {
    throw new AssignmentTreeError("Invalid accepted assignment owner.");
  }
  return tree;
}

interface LegacyAssignmentSource {
  createdBy: string;
  assignees: string[];
  teams?: string[];
  assignmentBased?: boolean;
  assignmentResponses?: Record<
    string,
    {
      status: string;
      delegatedTo?: string[];
      returnTo?: string[];
      returnedBy?: string;
      note?: string;
    }
  >;
}

/** Preserve known return stacks while older flat records acquire a durable tree. */
export function seedLegacyAssignmentTree(
  task: LegacyAssignmentSource,
  groups: AssignmentGroupMembers = {},
): TaskAssignmentTree {
  const targets = task.assignmentBased === false
    ? [...new Set([...task.assignees, ...task.teams ?? []])]
    : task.assignees;
  const tree = createAssignmentTree(task.createdBy, []);
  const root = tree.nodes[tree.rootId];
  root.status = targets.length ? "delegated" : "cancelled";
  const pathFor = (principalId: string, seen = new Set<string>()): string[] => {
    if (seen.has(principalId)) return [];
    seen.add(principalId);
    const response = task.assignmentResponses?.[principalId];
    if (response?.returnTo !== undefined) return response.returnTo;
    const parent = Object.entries(task.assignmentResponses ?? {}).reverse().find((
      [id, response],
    ) =>
      !seen.has(id) && userPattern.test(id) && response.status === "delegated" &&
      response.delegatedTo?.includes(principalId)
    )?.[0];
    return parent
      ? [parent, ...pathFor(parent, seen)]
      : principalId === task.createdBy
      ? []
      : [task.createdBy];
  };
  for (const target of new Set(targets)) {
    let parent = root;
    for (
      const ancestor of [...new Set(pathFor(target))].reverse().filter((id) =>
        id !== task.createdBy && id !== target && userPattern.test(id)
      )
    ) {
      let current = parent.children.map((id) => tree.nodes[id]).find((entry) =>
        entry.kind === "user" && entry.principalId === ancestor &&
        entry.status === "delegated"
      );
      if (!current) {
        current = node(tree, ancestor, parent.id);
        current.status = "delegated";
      }
      parent = current;
    }
    const response = task.assignmentResponses?.[target];
    if (target === task.createdBy && parent === root && targets.length === 1) {
      root.status = "pending";
      root.explicit = true;
      if (response?.returnedBy) {
        root.returned = true;
        root.returnedBy = response.returnedBy;
      }
    } else {
      const ids = addTargets(tree, parent.id, [target], groups, response?.note);
      if (response?.returnedBy) {
        for (const id of ids) {
          tree.nodes[id].returned = true;
          tree.nodes[id].returnedBy = response.returnedBy;
        }
      }
    }
  }
  const accepted = Object.values(tree.nodes).reverse().find((entry) =>
    entry.kind === "user" && entry.status === "pending" &&
    task.assignmentResponses?.[entry.principalId]?.status === "accepted"
  );
  if (accepted) {
    return respondInAssignmentTree(tree, {
      userId: accepted.principalId,
      nodeId: accepted.id,
      kind: "accept",
    }).tree;
  }
  return validateAssignmentTree(tree);
}
