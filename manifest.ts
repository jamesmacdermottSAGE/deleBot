import { Manifest } from "deno-slack-sdk/mod.ts";
import ReplyWorkflow from "./app.ts";
import { APP_NAME } from "./delebot/config.ts";

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
  outgoingDomains: [],
  botScopes: [
    "commands",
    "chat:write",
    "channels:history",
    "groups:history",
    "im:read",
    "im:history",
    "users:read",
  ],
});
