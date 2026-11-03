import { DefineWorkflow } from "deno-slack-sdk/mod.ts";
import { WORKFLOW_ID } from "./delebot/config.ts";
import { MessageFunction, MessageProperties } from "./delebot/slack/events.ts";

/** Slack invokes this workflow; there is no always-running local server. */
export const ReplyWorkflow = DefineWorkflow({
  callback_id: WORKFLOW_ID,
  title: "DeleBot replies",
  description: "Respond to mentions and direct messages",
  input_parameters: {
    properties: MessageProperties,
    required: ["channel_id", "channel_type", "user_id", "message_ts"],
  },
});

ReplyWorkflow.addStep(MessageFunction, {
  channel_id: ReplyWorkflow.inputs.channel_id,
  channel_type: ReplyWorkflow.inputs.channel_type,
  user_id: ReplyWorkflow.inputs.user_id,
  message_ts: ReplyWorkflow.inputs.message_ts,
  text: ReplyWorkflow.inputs.text,
  thread_ts: ReplyWorkflow.inputs.thread_ts,
});

export default ReplyWorkflow;
