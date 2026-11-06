import { DefineDatastore, Schema } from "deno-slack-sdk/mod.ts";

export const DmContextsDatastore = DefineDatastore({
  name: "task_conversations",
  primary_key: "id",
  attributes: {
    id: { type: Schema.types.string },
    user_id: { type: Schema.types.string },
    task_ids: { type: Schema.types.array, items: { type: Schema.types.string } },
    message_kind: { type: Schema.types.string },
  },
});
export interface DmContexts {
  get(channel: string, thread: string, user: string): Promise<string[]>;
  save(
    channel: string,
    thread: string,
    user: string,
    ids: string[],
    kind?: "card" | "context" | "invitation",
  ): Promise<void>;
}
interface Client {
  apps: {
    datastore: {
      get(
        args: { datastore: string; id: string },
      ): Promise<{ ok: boolean; item?: Record<string, unknown> }>;
      put(
        args: { datastore: string; item: Record<string, unknown> },
      ): Promise<{ ok: boolean }>;
    };
  };
}
export class SlackDmContexts implements DmContexts {
  constructor(private client: Client) {}
  async get(channel: string, thread: string, user: string): Promise<string[]> {
    const id = `${channel}:${thread}:${user}`;
    const result = await this.client.apps.datastore.get({
      datastore: DmContextsDatastore.name,
      id,
    });
    if (!result.ok) throw new Error("Cannot read DM task context.");
    if (!result.item || !Object.keys(result.item).length) return [];
    if (
      result.item.id !== id || result.item.user_id !== user ||
      !Array.isArray(result.item.task_ids) ||
      !result.item.task_ids.every((value) => typeof value === "string")
    ) throw new Error("Invalid DM context.");
    return result.item.task_ids as string[];
  }
  async save(
    channel: string,
    thread: string,
    user: string,
    ids: string[],
    kind?: "card" | "context" | "invitation",
  ) {
    const result = await this.client.apps.datastore.put({
      datastore: DmContextsDatastore.name,
      item: {
        id: `${channel}:${thread}:${user}`,
        user_id: user,
        task_ids: [...new Set(ids)],
        ...(kind ? { message_kind: kind } : {}),
      },
    });
    if (!result.ok) throw new Error("Cannot save DM task context.");
  }
}

/** Slack does not offer the same group autocomplete in all DM composers. */
export function expandTeamHandles(text: string, names: Record<string, string>): string {
  const handles = new Map(
    Object.entries(names).map(([id, name]) => [name.replace(/^@/, "").toLowerCase(), id]),
  );
  // Preserve quoted prose, Slack tokens and URLs verbatim.
  return text.replace(
    /"(?:\\.|[^"\\])*"|'[^']*'|<[^>]*>|https?:\/\/\S+|(^|\s)@([a-z0-9_-]+)/gi,
    (match, space, handle) => {
      const id = handle && handles.get(handle.toLowerCase());
      return id ? `${space}<!subteam^${id}>` : match;
    },
  );
}
