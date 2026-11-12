import { DefineWorkflow } from "deno-slack-sdk/mod.ts";
import { WORKFLOW_ID } from "./delebot/config.ts";
import { MessageFunction, MessageProperties } from "./delebot/slack/events.ts";

/** Slack invokes this workflow; there is no always-running local server. */
export const ReplyWorkflow = DefineWorkflow({
  callback_id: WORKFLOW_ID,
  title: "DeleBot replies",
  description: "Create and find tasks from mentions and direct messages",
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

/** Slow delegation work runs outside the modal's three-second response window. */
export const DelegationWorkflow = DefineWorkflow({
  callback_id: "delebot_delegate",
  title: "DeleBot delegation",
  description: "Verify and deliver a submitted task delegation",
  input_parameters: {
    properties: {
      submission: MessageProperties.delegation_submission,
      channel_id: MessageProperties.channel_id,
      user_id: MessageProperties.user_id,
      message_ts: MessageProperties.message_ts,
    },
    required: ["submission", "channel_id", "user_id", "message_ts"],
  },
});
DelegationWorkflow.addStep(MessageFunction, {
  delegation_submission: DelegationWorkflow.inputs.submission,
  channel_id: DelegationWorkflow.inputs.channel_id,
  channel_type: "im",
  user_id: DelegationWorkflow.inputs.user_id,
  message_ts: DelegationWorkflow.inputs.message_ts,
});
