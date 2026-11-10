/** Read people and user-group mentions from Slack's native message composer. */
export function recipientMentions(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const block = value as Record<string, unknown>;
  if (block.type !== "rich_text" || !Array.isArray(block.elements)) return undefined;
  const parts: string[] = [];
  for (const rawSection of block.elements) {
    if (!rawSection || typeof rawSection !== "object") return undefined;
    const section = rawSection as Record<string, unknown>;
    if (section.type !== "rich_text_section" || !Array.isArray(section.elements)) {
      return undefined;
    }
    for (const raw of section.elements) {
      if (!raw || typeof raw !== "object") return undefined;
      const element = raw as Record<string, unknown>;
      if (
        element.type === "user" && typeof element.user_id === "string" &&
        /^[UW][A-Z0-9]+$/.test(element.user_id)
      ) {
        parts.push(`<@${element.user_id}>`);
      } else if (
        element.type === "usergroup" && typeof element.usergroup_id === "string" &&
        /^S[A-Z0-9]+$/.test(element.usergroup_id)
      ) {
        parts.push(`<!subteam^${element.usergroup_id}>`);
      } else if (element.type === "text" && typeof element.text === "string") {
        parts.push(element.text);
      } else return undefined;
    }
    parts.push(" ");
  }
  const text = parts.join("").trim();
  return text.length <= 2000 ? text : undefined;
}
