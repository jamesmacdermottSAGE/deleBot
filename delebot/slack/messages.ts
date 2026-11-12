import type { Task } from "../tasks/models.ts";

/** Brief introduction; task ? contains the full creation and delegation guide. */
export const GREETING = [
  "💬 Talk directly to DeleBot in a DM; no bot mention needed.",
  "*Create:* `task Name`, or `task Name assign @person @team p 1 due 6/11/26`. Type `teams` to find team handles.",
  "*List:* `ls` shows available tasks; `ls me` includes your direct and team assignments. `ls collab` shows your collaborations. Each task arrives as a separate DM message.",
  "Reply in a task's thread with `accept`, `reject`, `delegate @person`, edits, or `done`. You can also select a task by number, e.g. `123 done`.",
  "*Help:* `task ?` for full task creation, editing and delegation instructions; `ls ?` for all list filters.",
  "The accepted owner can invite collaborators with `collab @person`. Access holders approve completion/deletion requests.",
  "*Clear:* in a DM clears that chat; in a DM thread clears that thread. Your own messages require Slack user authorization. Repeat when prompted; tasks remain.",
].join("\n\n");

export const UNKNOWN_COMMAND =
  "I didn't recognise that command. Run `task ?` for full task creation and delegation instructions, or `?` for a brief guide to `task` and `ls`.";

/** Escape Slack control characters in text supplied by people. */
function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A consistent identity for task notices, confirmations, and decisions. */
export function taskTitle(task: Pick<Task, "number" | "name">): string {
  return `*Task #${task.number}: ${escapeText(task.name)}*`;
}

function mention(userId: string): string {
  return /^[UW][A-Z0-9]+$/.test(userId) ? `<@${userId}>` : escapeText(userId);
}

function assignees(task: Task, teamNames: Record<string, string>): string {
  if (task.assignmentTree) {
    const tree = task.assignmentTree;
    if (tree.acceptedBy) return `${mention(tree.acceptedBy)} ✅ Accepted`;
    const active = new Map<string, boolean>();
    const live = (id: string): boolean => {
      if (active.has(id)) return active.get(id)!;
      const n = tree.nodes[id];
      const value = n.status === "pending" || n.status === "accepted" ||
        (n.status === "delegated" && n.children.some(live));
      active.set(id, value);
      return value;
    };
    const lines: string[] = [];
    let hidden = 0;
    const render = (id: string, depth = 0): void => {
      if (!live(id)) return;
      const node = tree.nodes[id];
      if (lines.length >= 12) {
        hidden++;
        return;
      }
      const label = node.kind === "team"
        ? escapeText(
          teamNames[node.principalId]
            ? `@${teamNames[node.principalId].replace(/^@/, "")}`
            : `Team ${node.principalId}`,
        )
        : mention(node.principalId);
      const state = node.status === "delegated" ? "↪️ Delegated" : "⏳ Pending";
      lines.push(`${"  ".repeat(Math.min(depth, 2))}${label} ${state}`);
      for (const child of node.children) render(child, depth + 1);
    };
    const root = tree.nodes[tree.rootId];
    if (root.status === "delegated" && !root.returned && !root.explicit) {
      for (const child of root.children) render(child);
    } else render(root.id);
    if (hidden) lines.push(`… ${hidden} more branches`);
    return lines.join("\n");
  }
  const ids = task.assignmentBased
    ? task.assignees
    : [...new Set([...task.assignees, ...task.teams])];
  if (ids.includes("all")) return "All";
  const history = Object.keys(task.assignmentResponses ?? {}).filter((id) =>
    ["rejected", "delegated"].includes(task.assignmentResponses![id].status)
  );
  const nodes = [...new Set([...history, ...ids])];
  const targets = new Set(
    history.flatMap((id) => task.assignmentResponses?.[id]?.delegatedTo ?? []),
  );
  const visited = new Set<string>();
  const render = (id: string): string => {
    if (visited.has(id)) return "";
    visited.add(id);
    const label = /^S/.test(id)
      ? escapeText(teamNames[id] ? `@${teamNames[id].replace(/^@/, "")}` : `Team ${id}`)
      : mention(id);
    const response = task.assignmentResponses?.[id];
    const state = response?.status ?? "pending";
    if (state === "delegated") {
      const children = (response?.delegatedTo ?? []).map(render).filter(Boolean);
      return `${label} ↪️ Delegated${children.length ? ` → ${children.join(", ")}` : ""}`;
    }
    return `${label} ${
      state === "accepted" ? "✅" : state === "rejected" ? "❌ Rejected" : "⏳ Pending"
    }`;
  };
  const lines = nodes.filter((id) => !targets.has(id)).map(render).filter(Boolean);
  for (const id of nodes) if (!visited.has(id)) lines.push(render(id));
  return lines.join("\n");
}

/** Summarize historical declines once per person, outside the current assignees. */
function declinedSummary(task: Task): string[] {
  if (!task.assignmentTree) return [];
  const nodes = Object.values(task.assignmentTree.nodes);
  const current = new Set(
    nodes.filter((n) => n.status === "pending" || n.status === "accepted").map((n) =>
      n.principalId
    ),
  );
  const counts = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind === "user" && n.status === "rejected" && !current.has(n.principalId)) {
      counts.set(n.principalId, (counts.get(n.principalId) ?? 0) + 1);
    }
  }
  if (!counts.size) return [];
  const entries = [...counts];
  const text = entries.slice(0, 5).map(([id, count]) =>
    `${mention(id)}${count > 1 ? ` ×${count}` : ""}`
  ).join(", ");
  return [
    `*Declined:* ${text}${entries.length > 5 ? `, +${entries.length - 5} others` : ""}`,
  ];
}

function permissions(
  ids: string[] | undefined,
  teamNames: Record<string, string>,
): string {
  if (ids === undefined) return "Existing task access";
  if (ids.length === 1 && ids[0] === "all") return "All";
  return ids.map((id) =>
    /^S/.test(id)
      ? escapeText(teamNames[id] ? `@${teamNames[id].replace(/^@/, "")}` : `Team ${id}`)
      : mention(id)
  ).join(", ") || "Nobody";
}

function dueDate(value: string | null): string {
  if (!value) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : escapeText(value);
}

function link(url: string): string {
  // Pipes and angle brackets have structural meaning inside Slack links.
  const safeUrl = url.replaceAll("|", "%7C").replaceAll("<", "%3C").replaceAll(
    ">",
    "%3E",
  );
  return `<${escapeText(safeUrl)}>`;
}

/** A task's complete details, used after creation and for individual lookups. */
export function formatTask(task: Task, teamNames: Record<string, string> = {}): string {
  return [
    `*Task #${task.number}: ${escapeText(task.name)}*`,
    `*Assignees:* ${assignees(task, teamNames)}`,
    ...declinedSummary(task),
    ...(task.participation &&
        Object.entries(task.participation.collaborators).some(([, entry]) =>
          entry.status === "accepted"
        )
      ? [
        `*Collaborators:* ${
          Object.entries(task.participation.collaborators).filter(([, entry]) =>
            entry.status === "accepted"
          ).map(([id]) => mention(id)).join(", ")
        }`,
      ]
      : []),
    `*Description:* ${task.description ? escapeText(task.description) : ""}`,
    `*Due:* ${dueDate(task.dueDate)}`,
    `*Priority:* ${task.priority == null ? "" : task.priority}`,
    `*Access:* ${permissions(task.editPerms, teamNames)}`,
    task.links.length ? `*Links:*\n${task.links.map(link).join("\n")}` : "*Links:* ",
    task.jiraLinks?.length
      ? `*Jira:*\n${task.jiraLinks.map(link).join("\n")}`
      : "*Jira:* ",
    task.githubLinks?.length
      ? `*GitHub:*\n${task.githubLinks.map(link).join("\n")}`
      : "*GitHub:* ",
    `*Created by:* ${mention(task.createdBy)}`,
    `*Completed:* ${task.completed ? "✅" : ""}`,
    "━━━━━━━━━━━━━━━━━━━━",
  ].join("\n\n");
}

const MAX_REPLY_LENGTH = 35000;

/** Split oversized entries too, so every task survives a large list response. */
function chunks(text: string, maxLength = MAX_REPLY_LENGTH): string[] {
  const parts: string[] = [];
  while (text.length > maxLength) {
    let end = text.lastIndexOf("\n", maxLength);
    if (end <= 0) end = maxLength;
    // Do not split a UTF-16 surrogate pair, such as an emoji in a task name.
    const last = text.charCodeAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end--;
    parts.push(text.slice(0, end));
    text = text.slice(end).replace(/^\n/, "");
  }
  if (text) parts.push(text);
  return parts;
}

/** Keep full details below Slack's message limit after escaping expands the text. */
export function splitTaskReply(text: string): string[] {
  return chunks(text, 35000);
}

/** Ephemeral messages have a smaller byte budget than ordinary messages. */
export function splitPrivateReply(text: string): string[] {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const lineBytes = encoder.encode(line).length;
    // Keep ordinary lines (including Slack links) whole whenever they fit.
    if (part && bytes + lineBytes > 3800) {
      parts.push(part);
      part = "";
      bytes = 0;
    }
    for (const character of line) {
      const length = encoder.encode(character).length;
      if (bytes + length > 3800) {
        parts.push(part);
        part = "";
        bytes = 0;
      }
      part += character;
      bytes += length;
    }
  }
  if (part) parts.push(part);
  return parts;
}

/** Return bounded Slack messages, retaining every matching task in order. */
export function formatTaskList(
  tasks: Task[],
  teamNames: Record<string, string> = {},
): string[] {
  if (tasks.length === 0) return ["No tasks found."];
  return chunks([
    `*Tasks (${tasks.length})*`,
    ...tasks.map((task) => formatTask(task, teamNames)),
  ].join("\n\n"));
}
