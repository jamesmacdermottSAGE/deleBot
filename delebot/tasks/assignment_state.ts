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
} from "./assignment_tree.ts";
import type { Task } from "./models.ts";
import type { AssignmentDecision, TaskContext } from "./service.ts";
import { effectiveTaskViewPerms } from "./access.ts";

export function treeReady(
  assignees: string[],
  groups: Record<string, string[]> = {},
): boolean {
  return assignees.length > 0 && !assignees.includes("all") &&
    assignees.every((id) => !/^S/.test(id) || groups[id] !== undefined);
}

export function initializeAssignmentTree(task: Task, context: TaskContext): Task {
  if (!treeReady(task.assignees, context.groupMembers)) return task;
  const tree = createAssignmentTree(task.createdBy, task.assignees, context.groupMembers);
  const nodes = pendingAssignmentNodes(tree);
  const key = `${context.channelId}:${context.messageTs}`;
  return {
    ...task,
    assignmentTree: tree,
    assignmentEvents: {
      ...task.assignmentEvents,
      [key]: invitationRecipients(tree, nodes.map((n) => n.id)),
    },
    assignmentEventNodes: {
      ...task.assignmentEventNodes,
      [key]: nodes.map(assignmentInvitationKey),
    },
  };
}

/** Explicit reassignment replaces invitation generations; ordinary edits do not. */
export function resetAssignmentTree(task: Task, context: TaskContext): Task {
  const next = { ...task };
  delete next.assignmentTree;
  if (!treeReady(task.assignees, context.groupMembers)) return next;
  const responses = { ...task.assignmentResponses };
  for (const id of task.assignees) {
    const previous = responses[id];
    responses[id] = {
      status: "pending",
      ...(previous?.returnTo ? { returnTo: previous.returnTo } : {}),
      ...(previous?.note ? { note: previous.note } : {}),
    };
  }
  next.assignmentResponses = responses;
  const tree = seedLegacyAssignmentTree(next, context.groupMembers);
  // Old tokens may reference the same numeric node IDs after reseeding.
  const generations = Object.values(task.assignmentEventNodes ?? {}).flat().map((token) =>
    Number(token.split(":")[1])
  ).filter(Number.isSafeInteger);
  const generation = generations.length ? Math.max(...generations) + 1 : 0;
  for (const node of Object.values(tree.nodes)) node.generation = generation;
  const nodes = pendingAssignmentNodes(tree);
  const key = `${context.channelId}:${context.messageTs}`;
  return {
    ...next,
    assignmentTree: tree,
    assignmentEvents: {
      ...task.assignmentEvents,
      [key]: invitationRecipients(tree, nodes.map((node) => node.id)),
    },
    assignmentEventNodes: {
      ...task.assignmentEventNodes,
      [key]: nodes.map(assignmentInvitationKey),
    },
  };
}

export function addAssignmentTreeTargets(
  task: Task,
  assignees: string[],
  context: TaskContext,
): Task {
  if (!task.assignmentTree) return resetAssignmentTree(task, context);
  const result = appendTargetsToAssignmentTree(
    task.assignmentTree,
    assignees,
    context.groupMembers,
    context.userId,
  );
  const key = `${context.channelId}:${context.messageTs}`;
  return {
    ...task,
    assignmentTree: result.tree,
    assignmentEvents: {
      ...task.assignmentEvents,
      [key]: invitationRecipients(result.tree, result.inviteNodeIds),
    },
    assignmentEventNodes: {
      ...task.assignmentEventNodes,
      [key]: result.inviteNodeIds.map((id) =>
        assignmentInvitationKey(result.tree.nodes[id])
      ),
    },
  };
}

/** Project a validated tree transition onto the legacy fields still used by lists. */
export function transitionAssignmentTree(
  task: Task,
  decision: AssignmentDecision,
  context: TaskContext,
): Task | undefined {
  if (!task.assignmentTree && !treeReady(task.assignees, context.groupMembers)) {
    return undefined;
  }
  const tree = task.assignmentTree ??
    seedLegacyAssignmentTree(task, context.groupMembers);
  const binding = decision.invitationKeys?.find((key) => {
    const [id, generation] = key.split(":");
    const node = tree.nodes[id];
    return node?.principalId === context.userId &&
      node.generation === Number(generation) &&
      ["pending", "accepted"].includes(node.status);
  });
  if (decision.invitationKeys?.length && !binding) {
    throw new AssignmentTreeError("This invitation is no longer active.");
  }
  const [nodeId, generation] = binding?.split(":") ?? [];
  const result = respondInAssignmentTree(tree, {
    userId: context.userId,
    kind: decision.kind,
    assignees: decision.assignees,
    groupMembers: context.groupMembers,
    note: decision.note,
    ...(nodeId ? { nodeId, generation: Number(generation) } : {}),
  });
  const responses = { ...task.assignmentResponses };
  for (const node of Object.values(result.tree.nodes)) {
    if (node.status === "cancelled") continue;
    responses[node.principalId] = {
      status: node.kind === "team" && node.status === "delegated"
        ? "pending"
        : node.status,
      ...(node.kind === "user" && node.status === "delegated"
        ? { delegatedTo: node.children.map((id) => result.tree.nodes[id].principalId) }
        : {}),
      ...(node.returnedBy ? { returnedBy: node.returnedBy } : {}),
      ...(node.note ? { note: node.note } : {}),
      returnTo: (() => {
        const path: string[] = [];
        let parent = node.parentId ? result.tree.nodes[node.parentId] : undefined;
        while (parent) {
          if (
            parent.kind === "user" && parent.principalId !== node.principalId &&
            !path.includes(parent.principalId)
          ) path.push(parent.principalId);
          parent = parent.parentId ? result.tree.nodes[parent.parentId] : undefined;
        }
        return path;
      })(),
    };
  }
  const assignees = assignmentTreePrincipals(result.tree);
  const key = `${context.channelId}:${context.messageTs}`;
  return {
    ...task,
    assignmentBased: true,
    assignees,
    teams: assignees.filter((id) => /^S/.test(id)),
    assignmentTree: result.tree,
    assignmentResponses: responses,
    ...(result.deleted ? { deleted: true } : {}),
    ...(!task.assignmentBased
      ? {
        viewPerms: task.viewPerms ?? effectiveTaskViewPerms(task),
        editPerms: task.editPerms ?? effectiveTaskViewPerms(task),
      }
      : {}),
    appliedEvents: [...task.appliedEvents ?? [], key],
    assignmentEvents: {
      ...task.assignmentEvents,
      [key]: invitationRecipients(result.tree, result.inviteNodeIds),
    },
    assignmentEventNodes: {
      ...task.assignmentEventNodes,
      [key]: result.inviteNodeIds.map((id) =>
        assignmentInvitationKey(result.tree.nodes[id])
      ),
    },
  };
}
