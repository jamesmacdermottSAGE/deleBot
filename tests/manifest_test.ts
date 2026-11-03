import manifest from "../manifest.ts";
import trigger from "../triggers/messages.ts";
import replyTrigger from "../triggers/thread_replies.ts";

Deno.test("manifest targets Slack hosting and allows people to send DMs", () => {
  if (manifest.settings.function_runtime !== "slack") {
    throw new Error("App must use Slack's hosted runtime");
  }
  if (manifest.features.app_home?.messages_tab_read_only_enabled !== false) {
    throw new Error("Direct messages must remain writable");
  }
  if (!manifest.workflows?.delebot_reply || !manifest.functions?.delebot_handle_message) {
    throw new Error("Reply workflow and function must be registered");
  }
  const scopes = manifest.oauth_config.scopes.bot ?? [];
  for (
    const scope of [
      "chat:write",
      "channels:history",
      "channels:read",
      "groups:history",
      "groups:read",
      "im:read",
      "im:write",
      "users:read",
      "usergroups:read",
      "datastore:read",
      "datastore:write",
    ]
  ) {
    if (!scopes.includes(scope)) throw new Error(`Missing required scope: ${scope}`);
  }
  if (!manifest.datastores?.tasks) throw new Error("Task datastore must be registered");
  if (!manifest.datastores?.assignment_notifications) {
    throw new Error("Assignment notification datastore must be registered");
  }
  const attributes = manifest.datastores.tasks.attributes;
  for (
    const field of [
      "priority",
      "thread_ts",
      "applied_events",
      "assignment_events",
      "deleted",
    ]
  ) {
    if (!(field in attributes)) throw new Error(`Missing task field: ${field}`);
  }
});

Deno.test("trigger connects messages to the registered workflow with thread context", () => {
  if (trigger.workflow !== "#/workflows/delebot_reply") {
    throw new Error("Trigger must reference the registered reply workflow");
  }
  if (trigger.inputs?.thread_ts?.value !== "{{data.message_ts}}") {
    throw new Error("New messages must use their own non-null timestamp");
  }
  if (replyTrigger.inputs?.thread_ts?.value !== "{{data.thread_ts}}") {
    throw new Error("Thread replies must preserve their thread root");
  }
  if (!trigger.event?.filter) throw new Error("MessagePosted requires an event filter");
});
