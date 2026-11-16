import type { Task } from "../tasks/models.ts";
import { formatDueDate } from "../tasks/commands.ts";

/** Describe actual field changes, including no-op assignment commands. */
export function describeTaskChanges(before: Task, after: Task): string {
  const fields: Array<[keyof Task, string]> = [
    ["name", "Name"],
    ["description", "Description"],
    ["assignees", "Assignees"],
    ["priority", "Priority"],
    ["dueDate", "Due date"],
    ["links", "Links"],
    ["jiraLinks", "Jira links"],
    ["githubLinks", "GitHub links"],
    ["viewPerms", "Viewing permissions"],
    ["editPerms", "Access"],
    ["completed", "Completion"],
  ];
  const changes: string[] = [];
  for (const [field, label] of fields) {
    if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
    if (field === "completed") {
      changes.push(after.completed ? "Completed" : "Marked incomplete");
    } else if (field === "priority") {
      changes.push(
        after.priority === null
          ? "Priority cleared"
          : `Priority updated to ${after.priority}`,
      );
    } else if (field === "dueDate") {
      changes.push(
        after.dueDate
          ? `Due date updated to ${formatDueDate(after.dueDate)}`
          : "Due date cleared",
      );
    } else changes.push(`${label} updated`);
  }
  return changes.length ? changes.join(". ") : "No fields changed";
}
