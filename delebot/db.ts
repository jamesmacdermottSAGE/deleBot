import { DefineDatastore, Schema } from "deno-slack-sdk/mod.ts";

/** One row per source message; task numbers are display references, not primary keys. */
export const TasksDatastore = DefineDatastore({
  name: "tasks",
  primary_key: "id",
  attributes: {
    id: { type: Schema.types.string },
    number: { type: Schema.types.integer },
    name: { type: Schema.types.string },
    links: { type: Schema.types.array, items: { type: Schema.types.string } },
    assignees: { type: Schema.types.array, items: { type: Schema.slack.types.user_id } },
    assigned_to: { type: Schema.types.array, items: { type: Schema.types.string } },
    assignment_version: { type: Schema.types.integer },
    completed: { type: Schema.types.boolean },
    deleted: { type: Schema.types.boolean },
    description: { type: Schema.types.string },
    due_date: { type: Schema.types.string },
    urgency: { type: Schema.types.integer },
    priority: { type: Schema.types.integer },
    thread_ts: { type: Schema.types.string },
    applied_events: { type: Schema.types.array, items: { type: Schema.types.string } },
    assignment_events: { type: Schema.types.string },
    teams: { type: Schema.types.array, items: { type: Schema.types.string } },
    created_by: { type: Schema.slack.types.user_id },
    created_at: { type: Schema.types.string },
    channel_id: { type: Schema.slack.types.channel_id },
    message_ts: { type: Schema.types.string },
    status: { type: Schema.types.string },
  },
});
