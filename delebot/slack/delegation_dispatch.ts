import { DefineDatastore, Schema } from "deno-slack-sdk/mod.ts";
import type { SlackAPIClient } from "deno-slack-api/types.ts";
import { withKeyLock } from "../tasks/mutation.ts";

export const DelegationDispatchDatastore = DefineDatastore({
  name: "delegation_dispatch",
  primary_key: "id",
  attributes: { id: { type: Schema.types.string }, url: { type: Schema.types.string } },
});

export function isDelegationEndpoint(value: unknown): value is string {
  return typeof value === "string" &&
    /^https:\/\/hooks\.slack\.com\/triggers\/[A-Za-z0-9/_-]+$/.test(value);
}

/** Created before opening the form, never on its deadline-sensitive submission. */
export async function delegationEndpoint(client: SlackAPIClient): Promise<string> {
  return await withKeyLock("delegation-dispatch-endpoint", async () => {
    const saved = await client.apps.datastore.get({
      datastore: "delegation_dispatch",
      id: "worker",
    });
    if (!saved.ok) throw new Error("Cannot load delegation workflow configuration.");
    if (isDelegationEndpoint(saved.item?.url)) return saved.item.url;
    const created = await client.workflows.triggers.create({
      type: "webhook",
      name: "Process DeleBot delegation",
      workflow: "#/workflows/delebot_delegate",
      inputs: {
        submission: { value: "{{data.submission}}" },
        channel_id: { value: "{{data.channel_id}}" },
        user_id: { value: "{{data.user_id}}" },
        message_ts: { value: "{{data.message_ts}}" },
      },
    });
    const url = created.trigger?.webhook_url;
    if (!created.ok || !isDelegationEndpoint(url)) {
      throw new Error(
        "Cannot create delegation workflow. Restart the app and approve its updated permissions.",
      );
    }
    const result = await client.apps.datastore.put({
      datastore: "delegation_dispatch",
      item: { id: "worker", url },
    });
    if (!result.ok) throw new Error("Cannot save delegation workflow configuration.");
    return url;
  });
}

/** Await Slack's durable workflow handoff; no detached work survives this handler. */
export async function dispatchDelegation(
  url: string,
  submission: unknown,
  channelId: string,
  userId: string,
): Promise<void> {
  if (!isDelegationEndpoint(url)) {
    throw new Error("Invalid delegation workflow endpoint.");
  }
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(2000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      submission: JSON.stringify(submission),
      channel_id: channelId,
      user_id: userId,
      message_ts: `${Math.floor(Date.now() / 1000)}.000001`,
    }),
  });
  const result = await response.json();
  if (!response.ok || result?.ok !== true) {
    throw new Error("Slack did not accept the delegation. Please retry.");
  }
}
