import { resolveWorkspace, type WorkspaceClient } from "../delebot/slack/workspace.ts";
import { membershipHelp, TeamLookupError } from "../delebot/slack/teams.ts";

function assert(condition: unknown): asserts condition {
  if (!condition) throw new Error("Assertion failed");
}

Deno.test("channel context selects the workspace rather than an enterprise or home workspace", async () => {
  const client: WorkspaceClient = {
    conversations: {
      info: ({ channel }) => {
        assert(channel === "CTEST");
        return Promise.resolve({ ok: true, channel: { context_team_id: "TCHANNEL" } });
      },
    },
  };
  assert(await resolveWorkspace(client, "CTEST", { team_id: "EORG" }) === "TCHANNEL");
  assert(await resolveWorkspace(client, "CTEST", { team_id: "THOME" }) === "TCHANNEL");
});

Deno.test("workspace profile fallbacks support standard and single-workspace enterprise users", async () => {
  const client: WorkspaceClient = {
    conversations: { info: () => Promise.resolve({ ok: false, error: "missing_scope" }) },
  };
  assert(await resolveWorkspace(client, "CTEST", { team_id: "THOME" }) === "THOME");
  assert(
    await resolveWorkspace(client, "CTEST", {
      team_id: "EORG",
      enterprise_user: { teams: ["TONLY"] },
    }) === "TONLY",
  );
});

Deno.test("missing channel permissions never lead to guessing an enterprise workspace", async () => {
  const client: WorkspaceClient = {
    conversations: { info: () => Promise.resolve({ ok: false, error: "missing_scope" }) },
  };
  try {
    await resolveWorkspace(client, "CTEST", {
      team_id: "EORG",
      enterprise_user: { teams: ["TONE", "TTWO"] },
    });
  } catch (error) {
    assert(error instanceof TeamLookupError);
    assert(membershipHelp(error).includes("channels:read"));
    return;
  }
  throw new Error("Ambiguous workspace should be rejected");
});
