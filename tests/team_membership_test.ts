import { SlackTeamDirectory, type TeamClient } from "../delebot/slack/teams.ts";

function assert(condition: unknown, message = "Assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejects(action: () => Promise<unknown>, expected: string) {
  try {
    await action();
  } catch (error) {
    assert(error instanceof Error && error.message.includes(expected));
    return;
  }
  throw new Error(`Expected an error containing ${expected}`);
}

function group(id: string, users: string[], extra: Record<string, unknown> = {}) {
  return { id, users, user_count: String(users.length), date_delete: 0, ...extra };
}

function fixture(groups: unknown[] = []) {
  const calls: Array<{
    include_users: boolean;
    include_count: boolean;
    include_disabled: boolean;
  }> = [];
  const client: TeamClient = {
    usergroups: {
      users: { list: () => Promise.resolve({ ok: false, error: "usergroup_not_found" }) },
      list: (args) => {
        calls.push(args);
        return Promise.resolve({ ok: true, usergroups: groups });
      },
    },
  };
  return { client, calls, directory: new SlackTeamDirectory(client) };
}

Deno.test("team directory loads actual user-group membership and known active teams", async () => {
  const { directory, calls } = fixture([
    group("SENG", ["UJAMES", "WOTHER"], { handle: "engineering", name: "Engineers" }),
    group("SOPS", ["UALICE"], { name: "Operations" }),
    group("SSALES", ["UJAMES"]),
    group("SEMPTY", []),
  ]);
  const snapshot = await directory.load("UJAMES");
  assert(snapshot.access.userId === "UJAMES");
  assert(JSON.stringify(snapshot.access.teamIds) === JSON.stringify(["SENG", "SSALES"]));
  assert(
    JSON.stringify(snapshot.knownTeamIds) ===
      JSON.stringify(["SENG", "SOPS", "SSALES", "SEMPTY"]),
  );
  assert(calls.length === 1);
  assert(snapshot.teamNames.SENG === "engineering");
  assert(snapshot.teamNames.SOPS === "Operations");
  assert(snapshot.teamNames.SSALES === "SSALES");
  assert(calls[0].include_users && calls[0].include_count);
  assert(calls[0].include_disabled === false);
});

Deno.test("disabled and sidebar groups cannot grant membership or be selected", async () => {
  const { directory } = fixture([
    group("SOLD", ["UJAMES"], { date_delete: 1793700000 }),
    group("SSECTION", ["UJAMES"], { is_section: true }),
    group("SOTHER", ["UJAMES"], { is_usergroup: false }),
    group("SENG", ["UJAMES"]),
  ]);
  const snapshot = await directory.load("UJAMES");
  assert(JSON.stringify(snapshot.access.teamIds) === JSON.stringify(["SENG"]));
  assert(JSON.stringify(snapshot.knownTeamIds) === JSON.stringify(["SENG"]));
});

Deno.test("memberships are refreshed after a user leaves or a group is removed", async () => {
  const groups = [group("SENG", ["UJAMES"]), group("SOPS", ["UJAMES"])];
  const { directory, calls } = fixture(groups);
  assert((await directory.load("UJAMES")).access.teamIds.length === 2);
  groups[0] = group("SENG", ["UALICE"]);
  groups.pop();
  const after = await directory.load("UJAMES");
  assert(after.access.teamIds.length === 0);
  assert(JSON.stringify(after.knownTeamIds) === JSON.stringify(["SENG"]));
  assert(calls.length === 2);
});

Deno.test("no groups or no memberships returns no team access", async () => {
  const { directory } = fixture();
  const snapshot = await directory.load("UJAMES");
  assert(snapshot.access.teamIds.length === 0 && snapshot.knownTeamIds.length === 0);
});

Deno.test("Slack API errors and missing user-group list fail closed", async () => {
  const { directory, client } = fixture();
  client.usergroups.list = () => Promise.resolve({ ok: false, error: "missing_scope" });
  await rejects(() => directory.load("UJAMES"), "missing_scope");
  client.usergroups.list = () => Promise.resolve({ ok: true });
  await rejects(() => directory.load("UJAMES"), "incomplete team membership");
});

Deno.test("missing or malformed membership fields fail closed for the whole snapshot", async () => {
  for (
    const invalid of [
      { id: "SENG", date_delete: 0 },
      { id: "SENG", users: ["UJAMES"] },
      group("SENG", ["UJAMES"], { users: "UJAMES" }),
      group("SENG", ["UJAMES"], { users: ["UJAMES", 3] }),
      group("SENG", ["UJAMES"], { users: ["UJAMES", "UJAMES"] }),
      group("SENG", ["UJAMES"], { user_count: "2" }),
      group("SENG", ["UJAMES"], { user_count: "unknown" }),
      group("SENG", ["UJAMES"], { user_count: -1 }),
      group("SENG", ["UJAMES"], { date_delete: "0" }),
      group("invalid", ["UJAMES"]),
      null,
    ]
  ) {
    const { directory } = fixture([group("SVALID", ["UJAMES"]), invalid]);
    await rejects(() => directory.load("UJAMES"), "incomplete team membership");
  }
});

Deno.test("duplicate group ids fail closed instead of merging contradictory membership", async () => {
  const { directory } = fixture([
    group("SENG", ["UJAMES"]),
    group("SENG", ["UALICE"]),
  ]);
  await rejects(() => directory.load("UJAMES"), "incomplete team membership");
});

Deno.test("numeric counts are supported and returned snapshots are independent", async () => {
  const { directory } = fixture([group("SENG", ["UJAMES"], { user_count: 1 })]);
  const first = await directory.load("UJAMES");
  first.access.teamIds.length = 0;
  first.knownTeamIds.push("SFAKE");
  first.teamNames.SENG = "fake";
  const second = await directory.load("UJAMES");
  assert(JSON.stringify(second.access.teamIds) === JSON.stringify(["SENG"]));
  assert(JSON.stringify(second.knownTeamIds) === JSON.stringify(["SENG"]));
  assert(second.teamNames.SENG === "SENG");
});

Deno.test("invalid requester ids are rejected before making an API request", async () => {
  const { directory, calls } = fixture();
  await rejects(() => directory.load("james"), "invalid Slack user");
  assert(calls.length === 0);
});

Deno.test("enterprise mention IDs and workspace IDs share verified membership", async () => {
  const { directory } = fixture([
    group("SLOCAL", ["UJAMES"], {
      enterprise_subteam_id: "SENTERPRISE",
      handle: "alphasquad_backend",
    }),
    group("SOTHER", ["UALICE"], { enterprise_subteam_id: "SOTHERORG" }),
  ]);
  const result = await directory.load("UJAMES", "TWORKSPACE");
  assert(result.knownTeamIds.includes("SENTERPRISE"));
  assert(
    result.access.teamIds.includes("SENTERPRISE") &&
      result.access.teamIds.includes("SLOCAL"),
  );
  assert(result.teamNames.SENTERPRISE === "alphasquad_backend");
  assert(!result.access.teamIds.includes("SOTHERORG"));
});

Deno.test("mentionable subteams are accepted even with a false legacy usergroup flag", async () => {
  const { directory } = fixture([
    group("SALPHA", ["UJAMES"], { is_usergroup: false, is_subteam: true }),
    group("SSECTION", ["UJAMES"], { is_subteam: true, is_section: true }),
  ]);
  const result = await directory.load("UJAMES");
  assert(result.access.teamIds.join() === "SALPHA");
});

Deno.test("conflicting enterprise aliases fail closed", async () => {
  const { directory } = fixture([
    group("SLOCAL", ["UJAMES"], { enterprise_subteam_id: "SSHARED" }),
    group("SOTHER", ["UALICE"], { enterprise_subteam_id: "SSHARED" }),
  ]);
  await rejects(() => directory.load("UJAMES"), "incomplete team membership");
});

Deno.test("enterprise membership requests include the sender's workspace context", async () => {
  const { directory, client } = fixture();
  let workspace: string | undefined;
  client.usergroups.list = (args) => {
    workspace = args.team_id;
    return Promise.resolve({ ok: true, usergroups: [] });
  };
  await directory.load("UJAMES", "TWORKSPACE");
  assert(workspace === "TWORKSPACE");
  await directory.load("UJAMES", "EENTERPRISE");
  assert(workspace === undefined);
});

Deno.test("direct membership verifies selected groups absent from the workspace listing", async () => {
  const { directory, client } = fixture();
  let member = true;
  client.usergroups.users.list = (args) => {
    assert(args.usergroup === "SALPHA" && args.team_id === "TWORKSPACE");
    assert(args.include_disabled === false);
    return Promise.resolve({ ok: true, users: member ? ["UJAMES"] : ["UALICE"] });
  };
  const first = await directory.load("UJAMES", "TWORKSPACE", ["SALPHA", "SALPHA"]);
  assert(
    first.knownTeamIds.join() === "SALPHA" && first.access.teamIds.join() === "SALPHA",
  );
  member = false;
  const revoked = await directory.load("UJAMES", "TWORKSPACE", ["SALPHA"]);
  assert(revoked.knownTeamIds.join() === "SALPHA" && revoked.access.teamIds.length === 0);
});

Deno.test("direct verification never grants access on API errors or incomplete member data", async () => {
  const { directory, client } = fixture();
  client.usergroups.users.list = () =>
    Promise.resolve({ ok: false, error: "missing_scope" });
  await rejects(
    () => directory.load("UJAMES", "TWORKSPACE", ["SALPHA"]),
    "missing_scope",
  );
  client.usergroups.users.list = () => Promise.resolve({ ok: true });
  await rejects(() => directory.load("UJAMES", "TWORKSPACE", ["SALPHA"]), "incomplete");
});

Deno.test("disabled groups stay blocked while section IDs require direct verification", async () => {
  const { directory, client } = fixture([
    group("SOLD", ["UJAMES"], { date_delete: 1 }),
    group("SSECTION", ["UJAMES"], { is_section: true }),
  ]);
  client.usergroups.users.list = ({ usergroup }) => {
    assert(usergroup === "SSECTION", "Disabled groups must not be queried");
    return Promise.resolve({ ok: false, error: "usergroup_not_found" });
  };
  const result = await directory.load("UJAMES", "TWORKSPACE", ["SOLD", "SSECTION"]);
  assert(result.access.teamIds.length === 0);
  assert(result.disabledTeamIds?.includes("SOLD"));
});

Deno.test("active groups with a shared-section flag use authoritative membership", async () => {
  const { directory, client } = fixture([
    group("SALPHA", ["UJAMES"], { is_section: true, is_usergroup: false }),
  ]);
  client.usergroups.users.list = ({ usergroup }) => {
    assert(usergroup === "SALPHA");
    return Promise.resolve({ ok: true, users: ["UJAMES"] });
  };
  const result = await directory.load("UJAMES", "TWORKSPACE", ["SALPHA"]);
  assert(result.access.teamIds.includes("SALPHA"));
});

Deno.test("DM team discovery resolves flagged handles only after membership verification", async () => {
  const { directory, client } = fixture([
    group("SALPHA", ["UJAMES"], {
      handle: "alphateam",
      is_section: true,
      is_usergroup: false,
    }),
  ]);
  client.usergroups.users.list = () => Promise.resolve({ ok: true, users: ["UJAMES"] });
  const result = await directory.load("UJAMES", "TWORKSPACE", [], true);
  assert(
    result.teamNames.SALPHA === "alphateam" && result.knownTeamIds.includes("SALPHA"),
  );
  client.usergroups.users.list = () =>
    Promise.resolve({ ok: false, error: "usergroup_not_found" });
  const absent = await directory.load("UJAMES", "TWORKSPACE", [], true);
  assert(!absent.teamNames.SALPHA && !absent.knownTeamIds.includes("SALPHA"));
});
