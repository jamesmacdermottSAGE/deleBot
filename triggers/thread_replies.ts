import { TriggerEventTypes, TriggerTypes } from "deno-slack-api/mod.ts";
import type { Trigger } from "deno-slack-api/types.ts";
import ReplyWorkflow from "../app.ts";

/** Thread replies only: preserve the existing thread root. */
const trigger: Trigger<typeof ReplyWorkflow.definition> = {
  type: TriggerTypes.Event,
  name: "DeleBot thread replies",
  description: "Watch conversations DeleBot belongs to for mentions and DMs",
  workflow: `#/workflows/${ReplyWorkflow.definition.callback_id}`,
  event: {
    event_type: TriggerEventTypes.MessagePosted,
    all_resources: true,
    filter: {
      version: 1,
      root: {
        operator: "AND",
        inputs: [
          { operator: "NOT", inputs: [{ statement: "{{data.thread_ts}} == null" }] },
          {
            operator: "OR",
            inputs: [
              { statement: "{{data.channel_type}} == dm" },
              { statement: "{{data.text}} CONTAINS '<@'" },
            ],
          },
        ],
      },
    },
  },
  inputs: {
    channel_id: { value: "{{data.channel_id}}" },
    channel_type: { value: "{{data.channel_type}}" },
    user_id: { value: "{{data.user_id}}" },
    message_ts: { value: "{{data.message_ts}}" },
    text: { value: "{{data.text}}" },
    thread_ts: { value: "{{data.thread_ts}}" },
  },
};

export default trigger;
