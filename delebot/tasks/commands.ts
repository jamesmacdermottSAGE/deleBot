import type { TaskQuery } from "./models.ts";

export type Priority = 1 | 2 | 3 | 4 | 5;
export interface TaskPatch {
  assignees?: string[];
  description?: string;
  priority?: Priority;
  dueDate?: string | null;
  links?: string[];
  completed?: boolean;
}

export const TASK_CREATE_USAGE = [
  "*Create:* `@DeleBot task Name` — a name is required; all other fields are optional.",
  "New tasks start open and unassigned; description, priority, due date, and links start unset. Add or update fields in the task's thread.",
  '*Example:* `@DeleBot task "Clean PRs" assign @james @frontend describe "Review open pull requests" p 1 due 6/11/26 link https://example.com/review`',
  "Select real people or teams from Slack's @ menu. `assign` accepts people, teams, or both; `assign -` assigns yourself; `assign all` shares with everyone. To combine yourself with others, select your own @ mention.",
  "*Fields:* `assign @person`, `describe text` (also `descibe`), `p 1` or `priority 1`, `due 6/11/26`, and `link https://…`. Priority 1 is highest, 5 lowest. Dates use day/month/year (two- or four-digit year). `due -` clears a due date.",
  "Combine fields in any order. Repeat `assign` or `link` to add multiple values: `link https://a.example link https://b.example`. Repeated descriptions add paragraphs. Conflicting repeated priority or due values are rejected.",
  'Quote names or descriptions containing command words, e.g. `task "Review due dates" describe "Please assign owners"`. Names can also use parentheses: `task (Clean PRs)`.',
  "*In the task's thread:* `@DeleBot assign @james p 2 due 10/11/26`, `@DeleBot link https://example.com/another`, or `@DeleBot done`.",
  "*By number:* `@DeleBot 123 done` or `@DeleBot 123 link https://example.com/another`. `work done` also marks completion.",
  "*Delete:* `@DeleBot delete` in the task's thread, or `@DeleBot 123 delete`. Send delete on its own, without other changes.",
  "DeleBot replies with the current task fields. Use a DM to enter private task details.",
].join("\n\n");

export const TASK_LIST_USAGE = [
  "*List:* `@DeleBot ls` shows all tasks available to you. All list results are sent to you in a DM. Use `ls me`, `ls @person`, `ls @team`, or `ls team` for tasks assigned to your teams. Select people and teams from Slack's @ menu.",
  "*Filters:* `ls 1` (or `ls (1)`), `ls p1`, `ls 6/11/26` (or `ls date (6/11/26)`), and `ls soon` filter your assigned tasks. Priority 1 is highest. Dates use day/month/year. Soon means due from today through the next three calendar days, inclusive, using London dates.",
  "Combine targets and filters: `ls @person soon`, `ls 1 soon`, `ls me p1`, or `ls team priority 1`. Multiple people or teams match any selected target; priority and due filters apply together. Use either soon or one exact date.",
  "*Lookup:* `ls task 5` or `ls task Clean PRs`. Existing forms also work: `ls tasks`, `tasks ls`, `ls tasks @person`, `ls tasks @team`, `ls tasks team all`, `ls tasks priority 1`, `ls tasks due 6/11/26`, and `ls tasks completed no`.",
].join("\n\n");
export const TASK_USAGE = `${TASK_CREATE_USAGE}\n\n${TASK_LIST_USAGE}`;

export type TaskCommand =
  | { kind: "help"; topic: "general" | "create" | "list" }
  | { kind: "create"; name: string; patch: TaskPatch }
  | { kind: "update"; number?: number; patch: TaskPatch }
  | { kind: "delete"; number?: number }
  | { kind: "list"; query: TaskQuery }
  | { kind: "error"; message: string }
  | { kind: "unknown" };

function invalid(message: string): TaskCommand {
  return { kind: "error", message: `${message}\n\n${TASK_USAGE}` };
}

function parseAssignees(value: string): string[] | undefined {
  if (value === "-") return [];
  if (/^all$/i.test(value)) return ["all"];
  const pattern = /<@([UW][A-Z0-9]+)(?:\|[^>]+)?>|<!subteam\^(S[A-Z0-9]+)(?:\|[^>]+)?>/g;
  const matches = [...value.matchAll(pattern)];
  if (!matches.length || !/^[\s,]*$/.test(value.replace(pattern, ""))) return undefined;
  return [...new Set(matches.map((match) => match[1] ?? match[2]))];
}

function parseCompleted(value: string): boolean | undefined {
  if (/^(yes|true|1)$/i.test(value)) return true;
  if (/^(no|false|0)$/i.test(value)) return false;
  return undefined;
}

function parseTeams(value: string): string[] | undefined {
  if (/^all$/i.test(value)) return ["all"];
  const pattern = /<!subteam\^(S[A-Z0-9]+)(?:\|[^>]+)?>/g;
  const groups = [...value.matchAll(pattern)];
  if (!groups.length || !/^[\s,]*$/.test(value.replace(pattern, ""))) return undefined;
  return [...new Set(groups.map((group) => group[1]))];
}

/** Calendar dates stay timezone-free and are checked against actual month lengths. */
export function parseDueDate(value: string): string | undefined {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value);
  if (!match) return undefined;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]) + (match[3].length === 2 ? 2000 : 0);
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function formatDueDate(value: string): string {
  const [year, month, day] = value.split("-");
  return `${Number(day)}/${Number(month)}/${year}`;
}

function parsePriority(value: string): Priority | undefined {
  return /^[1-5]$/.test(value) ? Number(value) as Priority : undefined;
}

interface Token {
  value: string;
  quoted: boolean;
}
type Field = "assign" | "describe" | "priority" | "due" | "link" | "done" | "delete";
interface Operation {
  field: Field;
  size: number;
}

/** Protect quotes, complete Slack tokens and URLs before recognising field words. */
function tokenize(text: string): Token[] | string {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index])) {
      index++;
      continue;
    }
    const start = index;
    const quote = text[index];
    const closeQuote = quote === '"'
      ? '"'
      : quote === "'"
      ? "'"
      : quote === "“"
      ? "”"
      : quote === "‘"
      ? "’"
      : undefined;
    if (closeQuote) {
      index++;
      let value = "";
      let closed = false;
      while (index < text.length) {
        const character = text[index++];
        if (character === closeQuote) {
          closed = true;
          break;
        }
        if (
          character === "\\" && index < text.length &&
          [closeQuote, "\\"].includes(text[index])
        ) value += text[index++];
        else value += character;
      }
      if (!closed) {
        return "Close the quoted name or description before sending the command.";
      }
      if (index < text.length && !/\s/.test(text[index])) {
        return "Put a space after a closing quote.";
      }
      tokens.push({ value, quoted: true });
      continue;
    }
    // Parentheses are a name wrapper only directly after the creation keyword.
    if (text[index] === "(" && tokens.length === 1 && /^task$/i.test(tokens[0].value)) {
      let depth = 1;
      index++;
      const nameStart = index;
      while (index < text.length && depth) {
        if (text[index] === "(") depth++;
        if (text[index] === ")") depth--;
        index++;
      }
      if (depth) return "Close the parentheses around the task name.";
      if (index < text.length && !/\s/.test(text[index])) {
        return "Put a space after the task name's closing parenthesis.";
      }
      tokens.push({ value: text.slice(nameStart, index - 1), quoted: true });
      continue;
    }
    if (
      text[index] === "<" && /^<(?:https?:\/\/|@|!subteam\^)/i.test(text.slice(index))
    ) {
      const end = text.indexOf(">", index);
      if (end < 0) return "Close the Slack mention or link before sending the command.";
      index = end + 1;
      tokens.push({ value: text.slice(start, index), quoted: false });
      continue;
    }
    while (index < text.length && !/\s/.test(text[index])) index++;
    tokens.push({ value: text.slice(start, index), quoted: false });
  }
  return tokens;
}

function operationAt(tokens: Token[], index: number): Operation | undefined {
  const token = tokens[index];
  if (!token || token.quoted) return undefined;
  const word = token.value.toLowerCase();
  if (word === "assign") return { field: "assign", size: 1 };
  if (["describe", "descibe", "description"].includes(word)) {
    return { field: "describe", size: 1 };
  }
  if (["p", "priority", "urgency"].includes(word)) return { field: "priority", size: 1 };
  if (word === "due") return { field: "due", size: 1 };
  if (["link", "links"].includes(word)) return { field: "link", size: 1 };
  if (word === "done") return { field: "done", size: 1 };
  if (word === "delete") return { field: "delete", size: 1 };
  if (
    word === "work" && !tokens[index + 1]?.quoted &&
    /^done$/i.test(tokens[index + 1]?.value ?? "")
  ) return { field: "done", size: 2 };
  return undefined;
}

function textOf(tokens: Token[]): string {
  return tokens.map((token) => token.value).join(" ").trim();
}

function parseLinks(tokens: Token[]): string[] | undefined {
  if (!tokens.length) return undefined;
  const links: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    let token = tokens[index].value;
    if (token === ",") continue;
    if (token.startsWith("<")) {
      if (!/^<https?:\/\/[^>]+>$/i.test(token)) return undefined;
      token = token.slice(1, -1).split("|")[0];
    } else if (
      token.endsWith(",") && /^(?:<)?https?:\/\//i.test(tokens[index + 1]?.value ?? "")
    ) {
      token = token.slice(0, -1);
    }
    token = token.replaceAll("&amp;", "&");
    if (/[\s<>]/.test(token) || token.length > 1000) return undefined;
    try {
      const url = new URL(token);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return undefined;
    } catch {
      return undefined;
    }
    links.push(token);
  }
  return links.length ? [...new Set(links)] : undefined;
}

function parsePatch(tokens: Token[], start: number): TaskPatch | string {
  const patch: TaskPatch = {};
  let selfAssignment = false;
  let index = start;
  while (index < tokens.length) {
    const operation = operationAt(tokens, index);
    if (!operation) {
      return `Unrecognised field '${
        tokens[index].value
      }'. Use assign, describe, p, due, link, or done.`;
    }
    index += operation.size;
    const valueStart = index;
    while (index < tokens.length && !operationAt(tokens, index)) index++;
    const values = tokens.slice(valueStart, index);
    const value = textOf(values);
    switch (operation.field) {
      case "assign": {
        const people = parseAssignees(value);
        if (!people) {
          return "After assign, select one or more people or teams from Slack's @ menu, use '-' for yourself, or 'all'.";
        }
        if (
          (!people.length && patch.assignees?.length) || (people.length && selfAssignment)
        ) {
          return "Use your own Slack mention when combining yourself with other assignees; do not mix assign - with other assignment values in one command.";
        }
        selfAssignment ||= people.length === 0;
        patch.assignees = [...new Set([...(patch.assignees ?? []), ...people])];
        if (patch.assignees.includes("all") && patch.assignees.length > 1) {
          return "Use assign all by itself; do not combine all with people or teams.";
        }
        if (patch.assignees.length > 20) {
          return "Assign at most 20 people or teams in one command.";
        }
        break;
      }
      case "describe": {
        if (!value) {
          return "Add description text after describe; quote text containing field words.";
        }
        patch.description = [patch.description, value].filter(Boolean).join("\n\n");
        if (patch.description.length > 2000) {
          return "Keep the description to 2,000 characters or fewer.";
        }
        break;
      }
      case "priority": {
        const priority = values.length === 1 ? parsePriority(value) : undefined;
        if (!priority) {
          return "Priority must be a whole number from 1 (highest) to 5 (lowest), e.g. p 1.";
        }
        if (patch.priority !== undefined && patch.priority !== priority) {
          return "Use one priority value per command; conflicting repeated values are not allowed.";
        }
        patch.priority = priority;
        break;
      }
      case "due": {
        const dueDate = value === "-"
          ? null
          : values.length === 1
          ? parseDueDate(value)
          : undefined;
        if (dueDate === undefined) {
          return "Use a valid due date in day/month/year format, e.g. due 6/11/26, or due - to clear it.";
        }
        if (patch.dueDate !== undefined && patch.dueDate !== dueDate) {
          return "Use one due date per command; conflicting repeated dates are not allowed.";
        }
        patch.dueDate = dueDate;
        break;
      }
      case "link": {
        const links = parseLinks(values);
        if (!links) {
          return "After link, include one or more valid http:// or https:// URLs, each at most 1,000 characters.";
        }
        patch.links = [...new Set([...(patch.links ?? []), ...links])];
        if (patch.links.length > 10) {
          return "Add at most 10 different links in one command.";
        }
        break;
      }
      case "done":
        if (values.length) {
          return "Use done (or work done) without a value. Put other changes after their field keyword.";
        }
        patch.completed = true;
        break;
      case "delete":
        return "Use delete on its own in the task's thread, or after a task number; do not combine deletion with other changes.";
    }
  }
  return patch;
}

function numberValue(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

type FilterQuery = Extract<TaskQuery, { kind: "filters" }>;
type ListTarget = NonNullable<FilterQuery["targets"]>[number];

function unwrapped(value: string): string | undefined {
  if (!value.includes("(") && !value.includes(")")) return value;
  return /^\([^()]+\)$/.test(value) ? value.slice(1, -1) : undefined;
}

function parseListFilters(text: string): TaskCommand {
  const tokens = tokenize(text);
  if (typeof tokens === "string") return invalid(tokens);
  if (!tokens.length) return { kind: "list", query: { kind: "all" } };
  const query: FilterQuery = { kind: "filters" };
  const targets: ListTarget[] = [];
  const addTarget = (target: ListTarget) => {
    if (!targets.some((item) => JSON.stringify(item) === JSON.stringify(target))) {
      targets.push(target);
    }
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.quoted) {
      return invalid(
        "Use list filters without quotes; select people and teams from Slack's @ menu.",
      );
    }
    const value = unwrapped(token.value);
    if (value === undefined) {
      return invalid(
        "Close parentheses around a priority or date, e.g. ls (1) or ls date (6/11/26).",
      );
    }
    const word = value.toLowerCase();
    if (word === "me") {
      addTarget({ kind: "me" });
      continue;
    }
    if (word === "team" || word === "teams") {
      const next = tokens[index + 1];
      const groups = next && !next.quoted ? parseTeams(next.value) : undefined;
      if (groups?.length === 1) {
        addTarget({ kind: "team", teamId: groups[0] });
        index++;
      } else addTarget({ kind: "my-teams" });
      continue;
    }
    const people = parseAssignees(token.value);
    if (people?.length === 1 && people[0] !== "all") {
      addTarget(
        /^S/.test(people[0])
          ? { kind: "team", teamId: people[0] }
          : { kind: "user", userId: people[0] },
      );
      continue;
    }
    if (word === "soon") {
      if (query.dueDate !== undefined) {
        return invalid("Use either soon or an exact date in one list command, not both.");
      }
      query.soon = true;
      continue;
    }
    if (word === "date" || word === "due" || value.includes("/")) {
      const next = word === "date" || word === "due" ? tokens[++index] : token;
      const dateText = next && !next.quoted ? unwrapped(next.value) : undefined;
      const dueDate = dateText === undefined ? undefined : parseDueDate(dateText);
      if (!dueDate) {
        return invalid(
          "Use a valid due date in day/month/year format, e.g. ls date 6/11/26.",
        );
      }
      if (query.soon) {
        return invalid("Use either soon or an exact date in one list command, not both.");
      }
      if (query.dueDate !== undefined && query.dueDate !== dueDate) {
        return invalid(
          "Use one exact date per list command; conflicting dates are not allowed.",
        );
      }
      query.dueDate = dueDate;
      continue;
    }
    let priorityText = value;
    if (["p", "priority", "urgency"].includes(word)) {
      const next = tokens[++index];
      priorityText = next && !next.quoted ? unwrapped(next.value) ?? "" : "";
    } else {
      const attached = /^(?:p|priority|urgency)(\d+)$/i.exec(value);
      if (attached) priorityText = attached[1];
      else if (!/^\d+$/.test(value)) {
        return invalid(
          `Unrecognised list filter '${token.value}'. Use me, @person, @team, team, priority 1, date 6/11/26, or soon.`,
        );
      }
    }
    const priority = parsePriority(priorityText);
    if (!priority) return invalid("Priority must be a whole number from 1 to 5.");
    if (query.priority !== undefined && query.priority !== priority) {
      return invalid(
        "Use one priority per list command; conflicting priorities are not allowed.",
      );
    }
    query.priority = priority;
  }
  query.targets = targets.length ? targets : [{ kind: "me" }];
  return { kind: "list", query };
}

function parseList(command: string): TaskCommand {
  const single = /^ls\s+task\s+([\s\S]+)$/i.exec(command);
  if (single) {
    let selector = single[1].trim();
    if (/^[+-]?\d+$/.test(selector)) {
      const number = numberValue(selector);
      return number
        ? { kind: "list", query: { kind: "number", number } }
        : invalid("Task numbers must be positive whole numbers.");
    }
    selector = selector.replace(/^\*(.*)\*$/, "$1").trim();
    if (
      (selector.startsWith('"') && selector.endsWith('"')) ||
      (selector.startsWith("'") && selector.endsWith("'"))
    ) selector = selector.slice(1, -1).trim();
    return selector
      ? { kind: "list", query: { kind: "name", name: selector } }
      : invalid("Provide a task number or name.");
  }
  if (/^ls\s+task$/i.test(command)) {
    return invalid("Provide a task number or name after ls task.");
  }
  const many = /^ls\s+tasks(?:\s+([\s\S]+))?$/i.exec(command);
  if (!many) return parseListFilters(command.replace(/^ls(?:\s+|$)/i, ""));
  const filter = many[1]?.trim();
  if (!filter) return { kind: "list", query: { kind: "all" } };
  const teams = parseTeams(filter.replace(/^team\s+/i, ""));
  if (teams?.length === 1) {
    return { kind: "list", query: { kind: "team", teamId: teams[0] } };
  }
  const completedMatch = /^completed\s+(\S+)$/i.exec(filter);
  if (completedMatch) {
    const completed = parseCompleted(completedMatch[1]);
    return completed === undefined
      ? invalid("Completed must be yes/no or true/false.")
      : { kind: "list", query: { kind: "completed", completed } };
  }
  const people = parseAssignees(filter);
  if (people?.length === 1 && /^[UW]/.test(people[0])) {
    return { kind: "list", query: { kind: "assignee", userId: people[0] } };
  }
  return parseListFilters(filter);
}

/** Parse only explicit commands; applying a patch is a separate, atomic validation step. */
export function parseTaskCommand(text: string): TaskCommand {
  const command = text.trim().replace(/^tasks\s+ls(?=\s|$)/i, "ls tasks")
    .replace(/^#(\d+)(?=\s|$)/, "$1")
    .replace(/^\((\d+)\)(?=\s|$)/, "$1");
  if (command === "?") return { kind: "help", topic: "general" };
  if (/^task\s+\?$/i.test(command)) return { kind: "help", topic: "create" };
  if (/^ls(?:\s+tasks?)?\s+\?$/i.test(command)) return { kind: "help", topic: "list" };
  if (/^ls(?:\s|$)/i.test(command)) return parseList(command);
  const tokens = tokenize(command);
  if (typeof tokens === "string") return invalid(tokens);
  if (!tokens.length) return { kind: "unknown" };
  if (!tokens[0].quoted && /^task$/i.test(tokens[0].value)) {
    let end = 1;
    while (end < tokens.length && !operationAt(tokens, end)) end++;
    const name = textOf(tokens.slice(1, end));
    if (tokens.slice(1, end).some((token) => !token.quoted && token.value === ".")) {
      return invalid(
        "Use field keywords instead of the old dotted format, e.g. task Errands assign @person describe text p 2 due 6/11/26.",
      );
    }
    if (!name) {
      return invalid(
        'A task needs a name immediately after task. Quote names containing field words, e.g. task "Review due dates".',
      );
    }
    if (name.length > 200) {
      return invalid("Keep the task name to 200 characters or fewer.");
    }
    const patch = parsePatch(tokens, end);
    return typeof patch === "string" ? invalid(patch) : { kind: "create", name, patch };
  }
  let start = 0;
  let number: number | undefined;
  if (!tokens[0].quoted && /^[+-]?\d+$/.test(tokens[0].value)) {
    number = numberValue(tokens[0].value);
    if (!number) return invalid("Task numbers must be positive whole numbers.");
    start = 1;
    if (start === tokens.length) {
      return invalid("Add a change after the task number, e.g. 123 done.");
    }
  } else if (!operationAt(tokens, 0)) return { kind: "unknown" };
  if (
    tokens.length === start + 1 && !tokens[start].quoted &&
    /^delete$/i.test(tokens[start].value)
  ) return { kind: "delete", ...(number ? { number } : {}) };
  const patch = parsePatch(tokens, start);
  return typeof patch === "string"
    ? invalid(patch)
    : { kind: "update", ...(number ? { number } : {}), patch };
}
