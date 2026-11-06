interface ResetClient {
  apps: {
    datastore: {
      query(args: { datastore: string; limit: number; cursor?: string }): Promise<{
        ok: boolean;
        items?: Record<string, unknown>[];
        next_cursor?: string;
        response_metadata?: { next_cursor?: string };
      }>;
      delete(args: { datastore: string; id: string }): Promise<{ ok: boolean }>;
    };
  };
}

/** Development reset: collect every page before deleting, including tombstones. */
export async function resetTaskDatabase(
  client: ResetClient,
): Promise<{ tasks: number; notifications: number }> {
  const collected = new Map<string, string[]>();
  for (const datastore of ["tasks", "assignment_notifications"]) {
    const ids = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.apps.datastore.query({
        datastore,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!page.ok || !Array.isArray(page.items)) {
        throw new Error("Cannot read reset records.");
      }
      for (const item of page.items) {
        if (typeof item.id !== "string" || !item.id) {
          throw new Error("Invalid reset record.");
        }
        ids.add(item.id);
      }
      cursor = page.next_cursor || page.response_metadata?.next_cursor || undefined;
      if (cursor && cursors.has(cursor)) throw new Error("Repeated reset cursor.");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    collected.set(datastore, [...ids]);
  }
  for (const [datastore, ids] of collected) {
    for (let start = 0; start < ids.length; start += 10) {
      const results = await Promise.allSettled(
        ids.slice(start, start + 10).map((id) =>
          client.apps.datastore.delete({ datastore, id })
        ),
      );
      if (results.some((result) => result.status !== "fulfilled" || !result.value.ok)) {
        throw new Error("Reset could not finish.");
      }
    }
  }
  return {
    tasks: collected.get("tasks")!.length,
    notifications: collected.get("assignment_notifications")!.length,
  };
}
