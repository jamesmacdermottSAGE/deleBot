/** Priority 1 is highest; priority 5 is lowest. */
export type Priority = 1 | 2 | 3 | 4 | 5;
/** Legacy type alias for datastore compatibility. */
export type Urgency = Priority;

export interface TaskInput {
  name: string;
  links: string[];
  assignees: string[];
  description: string;
  /** Calendar date, YYYY-MM-DD; null means no due date. */
  dueDate: string | null;
  priority: Priority | null;
  completed: boolean;
}
export interface TaskAccess {
  userId: string;
  teamIds: string[];
}
export interface Task extends TaskInput {
  teams: string[];
  assignmentBased: boolean;
  id: string;
  number: number;
  createdBy: string;
  createdAt: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  status: "open" | "completed";
  appliedEvents?: string[];
  /** Durable notification intent survives retries between saving and delivery. */
  assignmentEvents?: Record<string, string[]>;
  /** Retained to prevent delayed creation-event replays from restoring a deleted task. */
  deleted?: boolean;
}
export type TaskTarget =
  | { kind: "me" }
  | { kind: "user"; userId: string }
  | { kind: "team"; teamId: string }
  | { kind: "my-teams" };

export type TaskQuery =
  | { kind: "all" }
  | { kind: "number"; number: number }
  | { kind: "name"; name: string }
  | { kind: "assignee"; userId: string }
  | { kind: "priority"; priority: Priority }
  | { kind: "due"; dueDate: string }
  | { kind: "team"; teamId: string }
  | { kind: "completed"; completed: boolean }
  | {
    kind: "filters";
    targets?: TaskTarget[];
    priority?: Priority;
    dueDate?: string;
    soon?: boolean;
  };
