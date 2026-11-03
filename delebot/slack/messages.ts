import type { Task } from "../tasks/models.ts";

/** Help is also the response to messages that are not task commands. */
export const GREETING = [
  "Hello! DeleBot can create, update, list, and delete tasks.",
  "*Help:* `@DeleBot ?` for general usage, `@DeleBot task ?` for full creation/update instructions, " +
  "or `@DeleBot ls ?` for list commands. Omit the mention in a DM.",
  "*Create:* `@DeleBot task Name` — a name is required; other fields can be added now or in its thread.",
  "New tasks are unassigned until you use `assign`. Other optional fields begin unset.",
  "*Fields:* `assign @person @team`, `describe text` (also `descibe`), `p 1`, " +
  "`due 6/11/26`, `link https://example.com`. Priority is 1–5; 1 is highest.",
  "*Example:* `@DeleBot task Clean PRs assign @james p 2 due 6/11/26 describe Review open PRs`",
  "*Thread updates:* `@DeleBot assign @alice link https://example.com/review`, or `@DeleBot done`. " +
  "Outside its thread, use the task number: `@DeleBot 123 done`.",
  "Repeat `assign` or `link` to add more, including in one message: " +
  "`link https://example.com/a link https://example.com/b`. `work done` also marks completion.",
  "Put names or descriptions containing command words in double quotes, " +
  'e.g. `task "Review due dates" describe "Please assign an owner"`.',
  "*List:* `@DeleBot ls` shows all tasks you can access. `ls me` shows your direct assignments; " +
  "`ls @person` or `ls @team` selects an assignee; `ls team` selects tasks assigned to any of your teams.",
  "`ls soon` shows your direct assignments due today through three days from today, using London calendar dates; " +
  "`ls 6/11/26` (also `ls date (6/11/26)`) selects your tasks due that date; " +
  "`ls 1` (also `ls (1)` or `ls p1`) selects your priority 1 tasks.",
  "Combine filters to require every condition: `ls 1 soon` or `ls @alice soon`. " +
  "An explicit person or team replaces the personal default for date and priority filters. " +
  "Lists include full task details and arrive by DM.",
  "*Delete:* `@DeleBot delete` in the task's thread, or `@DeleBot 123 delete` elsewhere. " +
  "Send delete by itself, without other changes.",
  "Creation and update replies stay in the original thread; private task details in channels are shown only to you. " +
  "New assignees receive a DM. Team assignments notify their members; `all` does not broadcast DMs.",
  "Create private task details in a DM: a command posted in a channel remains visible there.",
  "Numbers are automatic and non-consecutive; copy a number or look up a name.",
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
  if (ids.includes("all")) return "Everyone";
  return ids.map((id) =>
    /^S/.test(id)
      ? escapeText(teamNames[id] ? `@${teamNames[id].replace(/^@/, "")}` : `Team ${id}`)
      : mention(id)
  ).join(", ") || "Unassigned";
}

function dueDate(value: string | null): string {
  if (!value) return "Not set";
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
    `*Description:* ${task.description ? escapeText(task.description) : "Not set"}`,
    `*Due:* ${dueDate(task.dueDate)}`,
    `*Priority:* ${task.priority === null ? "Not set" : task.priority}`,
    `*Completed:* ${task.completed ? "Yes" : "No"}`,
    task.links.length ? `*Links:*\n${task.links.map(link).join("\n")}` : "*Links:* None",
    `*Created by:* ${mention(task.createdBy)}`,
  ].join("\n");
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
