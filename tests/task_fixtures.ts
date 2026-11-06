import type { Task, TaskInput } from "../delebot/tasks/models.ts";
import type { TaskRepository } from "../delebot/tasks/repository.ts";
import type { TeamDirectory } from "../delebot/slack/teams.ts";
import type { TaskAccess } from "../delebot/tasks/models.ts";
import { canAccessTask, taskReferencedTeamIds } from "../delebot/tasks/access.ts";

export function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

export const input: TaskInput = {
  name: "Clean PRs",
  links: ["https://example.slack.com/archives/C123/p1793690000000001"],
  assignees: ["SFRONTEND"],
  description: "Review outstanding pull requests.",
  dueDate: "2026-11-06",
  priority: 2,
  completed: false,
  viewPerms: ["UCREATOR", "SFRONTEND"],
  editPerms: ["UCREATOR", "SFRONTEND"],
};

export class MemoryTaskRepository implements TaskRepository {
  rows = new Map<string, Task>();
  writes = 0;

  referencedTeamIds(): Promise<string[]> {
    return Promise.resolve([
      ...new Set(
        [...this.rows.values()].flatMap(taskReferencedTeamIds),
      ),
    ]);
  }

  findInThread(channelId: string, threadTs: string): Promise<Task[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((task) =>
        !task.deleted && task.channelId === channelId && task.threadTs === threadTs
      ),
    );
  }

  findBySource(channelId: string, messageTs: string): Promise<Task | null> {
    return Promise.resolve(this.rows.get(`${channelId}:${messageTs}`) ?? null);
  }

  findById(id: string): Promise<Task | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  save(task: Task): Promise<void> {
    this.writes++;
    this.rows.set(task.id, structuredClone(task));
    return Promise.resolve();
  }

  delete(task: Task): Promise<void> {
    this.writes++;
    this.rows.set(task.id, structuredClone({ ...task, deleted: true }));
    return Promise.resolve();
  }

  list(access: TaskAccess): Promise<Task[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((t) => canAccessTask(t, access)),
    );
  }
}

export const teamDirectory: TeamDirectory = {
  load: (userId) =>
    Promise.resolve({
      access: { userId, teamIds: ["SFRONTEND"] },
      knownTeamIds: ["SFRONTEND", "SBACKEND"],
      teamNames: { SFRONTEND: "frontend", SBACKEND: "firesquadbackend" },
    }),
};
