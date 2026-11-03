# DeleBot

A Slack-hosted TypeScript bot built with the Deno Slack SDK. The current version
replies to a human mentioning the bot in a public/private channel, or sending it
an individual direct message. Replies stay in the original thread. Messages from
bots, ordinary channel messages, and group DMs are ignored.

Task creation, acceptance, reassignment, and task lists are the next features.
The task and AI modules are placeholders; no task or AI functionality is enabled.

## Project structure

```text
app.ts                         # Reply workflow; replaces the Python entry point
manifest.ts                    # Hosted app definition, permissions, function registration
deno.jsonc                     # Pinned SDK imports and local checks
.slack/hooks.json              # Slack CLI hooks
assets/icon.png                # App icon
triggers/messages.ts           # New-message event trigger
triggers/thread_replies.ts     # Existing-thread reply trigger
delebot/
  config.ts                    # Shared application settings
  db.ts                        # Future Slack datastore definitions
  slack/
    auth.ts                    # Notes on Slack-managed authentication
    events.ts                  # Implemented greeting handler and custom function
    messages.ts                # Greeting text and future task cards
    actions.ts                 # Future button/modal handlers
  tasks/
    models.ts                  # Future task fields and statuses
    service.ts                 # Future task lifecycle rules
    repository.ts              # Future datastore operations
  ai/
    client.ts                  # Optional future integration
    detection.ts               # Optional future detection
    prompts.ts                 # Optional future instructions
tests/                         # Greeting/manifest tests and task test placeholders
data/                          # Private legacy files and migration backup; ignored
```

## What changed from Python

This is a Deno workflow app that can be deployed onto Slack's infrastructure.
`app.ts` defines a workflow rather than a server to run with `deno run`.
Slack invokes `delebot/slack/events.ts` when the message trigger fires.

The CLI handles installing the hosted app and Slack supplies function tokens.
The TypeScript app does not read the old `.env` tokens, run an OAuth callback
server, use Socket Mode, or require a Cloudflare tunnel. Existing `.env` files,
OAuth installation data, and the ignored Python environment are retained locally.
The previous Python source and README are backed up under
`data/migration-backup/python/` (excluded from Git).

The existing dashboard-created Bolt app and its installation are not converted
in place by this source migration. The CLI installs a workflow app with its own
identity. Use that new app for testing; the old installed app can still respond
with its old running Python process until you stop that process. Only stop it
once the hosted replacement is tested.

## Requirements

- Deno and Slack CLI, installed on this Mac during migration.
- A paid Slack workspace that allows workflow apps, or an eligible developer sandbox.
- Workspace/admin approval if required by that workspace.

The existing free test workspace may not qualify for hosted workflows. The
migration is prepared and locally tested, but the new app has not been installed
or deployed. Eligibility and CLI login must be confirmed before live testing.

## Check the code locally

From this project directory:

```sh
deno task check
deno task test
deno task lint
```

Format code with `deno task fmt`. Tests use fake Slack clients and do not send
messages, consume AI credits, or require Slack credentials. Task test files are
placeholders and contain no tests yet.

## Connect and test a local workflow app

1. Run `slack login` and follow the instructions in the eligible workspace.
2. Run `slack run` from this directory. Choose the intended workspace and create
   the local development app when prompted. Leave that terminal running.
3. In a second terminal in this directory, run:

   ```sh
   slack trigger create --trigger-def triggers/messages.ts
   slack trigger create --trigger-def triggers/thread_replies.ts
   ```

   Select the **local** app created in the previous step. Create each trigger
   once per app environment; duplicate triggers can produce duplicate replies.
4. Invite the local bot to a test channel and mention its actual name, then try
   an individual direct message. It should return the same greeting as before.

The two non-overlapping triggers use MessagePosted. New messages pass their own
timestamp; thread replies pass their existing thread root. This avoids passing a
null thread timestamp into Slack workflow validation. Each trigger considers DMs
and messages containing a user mention in conversations the app belongs to. The
function then verifies the exact bot mention and the sender before replying, so
mentions of other people never receive a greeting. `users:read` is used for bot
sender checks. No task database or AI is involved.

`slack run` is local development and stops working when its local process stops.
This is distinct from deploying onto Slack.

## Deploy onto Slack

After local testing and workspace approval:

```sh
slack deploy
slack trigger create --trigger-def triggers/messages.ts
slack trigger create --trigger-def triggers/thread_replies.ts
```

Select the deployed app when creating its trigger. Local and deployed apps have
separate triggers and identities. Invite the deployed bot to your test channel
and repeat the greeting test. Once deployed, the hosted bot does not require a
local terminal, a running Mac, a paid external server, or a tunnel.

If replies do not arrive, check the selected workspace/app, trigger existence,
channel membership, granted scopes, and `slack activity`. If a new installation
needs approval, complete that through the workspace's normal approval process.

## Next development step

Add explicit task creation to `tasks/service.ts`, define its data in
`tasks/models.ts`, and store it through `tasks/repository.ts` using a Slack
hosted datastore registered in `manifest.ts`. Then wire the command into the
message handler and implement acceptance/reassignment in `slack/actions.ts`.

## References

- [Deno Slack SDK and plan requirements](https://docs.slack.dev/tools/deno-slack-sdk/)
- [Creating event triggers](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-event-triggers/)
- [Creating custom functions](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-custom-functions/)
- [Creating and deploying apps](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-an-app/)
