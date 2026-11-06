import type { Task } from "../tasks/models.ts";

/** Help is also the response to messages that are not task commands. */
export const GREETING = [
  "Thread updates get a short confirmation while existing task cards refresh. Use print to show the full task again, or 123 print to select a task by number.",
  "💬 Talk directly to DeleBot in a DM; no bot mention needed.",
  "*Create:* `task Name` — the name is required. Other fields start unset; tasks start unassigned.",
  "*Fields:* `assign @person @team`, `desc text`, `p 1`, `due 6/11/26`, `link https://…`, `jira https://…`, `github https://…`, `access @person @team` (or `access all`). Priority 1 is highest; 5 lowest. Dates use day/month/year.",
  '*Edit:* `edit due 10/11/26 p 2 desc "New text"` replaces fields. `edit completed no` reopens a task. `delete due p desc` clears fields; `delete` alone deletes the task.',
  "*List:* `ls me`, `ls @person`, `ls @team`, `ls team`, `ls soon`, `ls 1 soon`, `ls 6/11/26`, or `ls task Name`. Each task arrives as a separate DM message. Reply to its thread to edit that task. Bare done works after selecting a single task; otherwise specify its number.",
  "*Respond:* `accept`, `reject`, `delegate @person` or `delegate @team` in the task message's thread. Assignment status: ⏳ pending, ✅ accepted, ❌ rejected, ↪️ delegated. New assignees receive their own invitation. Editing and delegation require access.",
  "*Teams:* type `teams`, then use a handle directly, e.g. `assign @alphateam`. Use Slack's people menu for user mentions.",
  "Quote names or descriptions containing field words. Repeat link, jira or github to add multiple links; use edit to replace or delete to clear each field.",
  "*Help:* `task ?` for all fields and `ls ?` for filters. Numbers are automatic and non-consecutive. `delete all` temporarily resets the whole database.",
].join("\n\n");

/** Escape Slack control characters in text supplied by people. */
function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function mention(userId: string): string {
  return /^[UW][A-Z0-9]+$/.test(userId) ? `<@${userId}>` : escapeText(userId);
}

function assignees(task: Task, teamNames: Record<string, string>): string {
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
