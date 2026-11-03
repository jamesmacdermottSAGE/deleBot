import { Manifest } from "deno-slack-sdk/mod.ts";
import ReplyWorkflow from "./app.ts";
import { APP_NAME } from "./delebot/config.ts";
import { TasksDatastore } from "./delebot/db.ts";
import { AssignmentNotificationsDatastore } from "./delebot/slack/notifications.ts";

export default Manifest({
  name: APP_NAME,
  icon: "assets/icon.png",
  description: "Task delegation assistant for development and testing",
  features: {
    appHome: {
      messagesTabEnabled: true,
      messagesTabReadOnlyEnabled: false,
    },
  },
  workflows: [ReplyWorkflow],
  datastores: [TasksDatastore, AssignmentNotificationsDatastore],
  outgoingDomains: [],
  botScopes: [
    "commands",
    "chat:write",
    "channels:history",
    "channels:read",
    "groups:history",
    "groups:read",
    "im:read",
    "im:write",
    "im:history",
    "users:read",
    "usergroups:read",
    "datastore:read",
    "datastore:write",
  ],
});
