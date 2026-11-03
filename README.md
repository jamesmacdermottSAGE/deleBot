# DeleBot

DeleBot creates and manages tasks from Slack mentions and individual DMs. Create a task
with a name, then add its details in the same message or in replies to its thread. Task
numbers are automatic and non-consecutive. Tasks persist in a Slack-hosted datastore.

Mention the actual installed bot from Slack's @ menu. The development bot may be named
**DeleBot Dev (local)**. In a DM with the bot, omit its mention. Ordinary channel
messages, bot messages, and group DMs are ignored.

## Create a task

A name is always required in the original creation command. This is enough to create one:

```text
@DeleBot task errands
```

A new task is initially incomplete and unassigned unless assignees are provided.
Description, priority, due date, and links can be left unset. The reply confirms the task
and displays its current fields, including **Unassigned** and **Not set** where
appropriate. Priorities display as a plain number, and links display their full URLs.

Add any combination of named fields after the name:

```text
@DeleBot task errands assign @james p 2 due 6/11/26 describe Run my errands link https://example.com/list
@DeleBot task Clean PRs assign @james @alphasquad_backend describe Review open PRs p 1 due 10/11/26
```

Select actual people and Slack user groups from the mention menu. People and teams can
share the same assignment field. The supported fields are:

| Command               | Meaning                                | Example                           |
| --------------------- | -------------------------------------- | --------------------------------- |
| `assign`              | Add people or teams to the assignees   | `assign @james @frontend`         |
| `describe`            | Append description text                | `describe Review the open PRs`    |
| `descibe`             | Accepted spelling alias for `describe` | `descibe Run my errands`          |
| `description`         | Another alias for `describe`           | `description Read the proposal`   |
| `p` or `priority`     | Set priority, 1 highest to 5 lowest    | `p 1`                             |
| `due`                 | Set a UK day/month/year date           | `due 6/11/26`                     |
| `due -`               | Clear the due date                     | `due -`                           |
| `link` or `links`     | Add HTTP/HTTPS links                   | `link https://example.com/review` |
| `done` or `work done` | Mark the task completed                | `done`                            |

A task name is required even when every other field is supplied. The previous dotted field
format has been replaced by these named commands.

## Update a task in its thread

Reply in the task's thread and mention DeleBot. The bot uses the thread context to find
the task, so no task number is needed:

```text
@DeleBot assign @alice
@DeleBot describe Include the archived PRs p 1 due 10/11/26
@DeleBot link https://example.com/a
@DeleBot link https://example.com/b
@DeleBot link https://example.com/c link https://example.com/d
@DeleBot done
```

Assignments and links are additive. Repeating an assignment or link does not duplicate it.
`assign -` adds the requesting user. `assign all` replaces the existing assignment set
with everyone; adding specific people or teams to an `all` task replaces `all` with those
assignments. Use `assign -` on its own in a command; to combine yourself with others,
select your own mention explicitly. Repeated descriptions append paragraphs. A command can
update several fields at once, and its reply displays the complete current task data after
saving the changes. Conflicting repeated priority or due values are rejected; repeating
the same value is accepted.

The task creator and current assignees, including members of assigned teams, can update
the task. If multiple tasks belong to the same thread, use a task number to select one.
The bot will not guess which task to update. Creating a task inside an existing thread
associates it with that thread's root.

Outside a task thread, prefix the update with its task number:

```text
@DeleBot 123 assign @alice link https://example.com/review
@DeleBot 123 done
@DeleBot 123 work done
```

Use the actual number from the task confirmation or list. `done` is idempotent: marking an
already completed task done keeps it completed. Reopening tasks is not a supported
command.

Delete a task from its thread with `@DeleBot delete`, or select it elsewhere with
`@DeleBot 123 delete`. The creator and current assignees can delete a task. DeleBot
replies in the original thread with a confirmation; deleted tasks no longer appear in
lists. Send `delete` on its own, without other field changes in the same command.

## Parsing names and descriptions

Command words delimit fields when they appear as separate, unquoted words. Quote a name or
description that should contain those words literally:

```text
@DeleBot task "Review due dates" describe "Please assign an owner and link the notes" p 2
```

Quotes also preserve multi-word text clearly. Slack links and mention labels are treated
as whole tokens, so their internal spaces and punctuation do not start a new field.
Command words inside URLs are preserved. Names and ordinary descriptions may contain
spaces without quotes when they do not contain command words. Parentheses can also wrap
the task name: `@DeleBot task (Clean PRs)`.

Dates use UK **day/month/year**: `6/11/26` means **6 November 2026**. Two-digit years mean
2000–2099; four-digit years are accepted. Invalid calendar dates, malformed mentions,
unsupported links, missing names, and invalid priority values return usage instructions
without partially applying the command. Names are limited to 200 characters, description
text to 2,000, combined assignees to 20, and links to 10 of at most 1,000 characters each.

## Lists and help

Lists arrive in a DM from DeleBot. Each result includes its complete current fields,
including descriptions, full link URLs, and plain-number priority values. Task entries are
separated by a blank line under a task count. Long results are split into multiple
messages without dropping tasks.

```text
@DeleBot ls
@DeleBot ls me
@DeleBot ls @james
@DeleBot ls @alphasquad_backend
@DeleBot ls team
@DeleBot ls soon
@DeleBot ls 6/11/26
@DeleBot ls 1
@DeleBot ls 1 soon
@DeleBot ls @james soon
@DeleBot ls team 1 soon
```

| Command      | Results                                                                    |
| ------------ | -------------------------------------------------------------------------- |
| `ls`         | All tasks you can access                                                   |
| `ls me`      | Tasks assigned directly to you                                             |
| `ls @person` | Tasks assigned directly to that person, within your access                 |
| `ls @team`   | Tasks assigned to that Slack user group, within your access                |
| `ls team`    | Tasks assigned to any of your current Slack user groups                    |
| `ls soon`    | Your direct assignments due today through three days from today, inclusive |
| `ls 6/11/26` | Your direct assignments due on that date                                   |
| `ls 1`       | Your direct assignments with priority 1; use any priority from 1 to 5      |

Combine filters to require every condition: `ls 1 soon` means your priority 1 tasks due
soon. An explicit person or team replaces the implicit personal target, so
`ls @james soon` means James's tasks due soon, and `ls team 1 soon` means priority 1 tasks
assigned to any of your teams and due soon. Assignee filters never grant access to another
person's private tasks. Unassigned tasks can appear in bare `ls` for their creator, but do
not match personal or team assignment filters.

`soon` uses London calendar dates, including today and the following three days. You can
also write priority as `ls (1)` or `ls p1`, and an exact date as `ls (6/11/26)` or
`ls date (6/11/26)`. Use either `soon` or one exact date in a list command.

For individual lookup, `ls task 123` selects a task number and `ls task Clean PRs` selects
an exact name ignoring case; duplicate names return all accessible matches. A bare number
after `ls` is a priority filter. Lists include completed and incomplete tasks unless
filtered with `ls tasks completed no` or `ls tasks completed yes`. The older `ls tasks`
and `tasks ls` spellings still work; old priority and due filters use the same personal
defaults as their short forms.

Use `@DeleBot task ?` for full creation and update instructions, `@DeleBot ?` for general
usage, or `@DeleBot ls ?` for list commands. `ls tasks ?` and `tasks ls ?` are equivalent.
Help replies appear in the original thread without querying task storage or team
membership.

## Assignment notifications and access

Newly assigned people receive a private message from DeleBot after the task has been
saved. Assigning a team notifies its current members, with overlapping people
deduplicated. Assigning `all` shares a task with everyone without broadcasting assignment
DMs to the workspace. Existing assignees are not notified again merely because another
field changes. Notification delivery state is saved separately so a retry can resume
failed deliveries. A task can be saved even if Slack cannot deliver one of its assignment
notifications. A later authorized task update also retries saved, undelivered assignment
notifications.

Creation and update replies stay in the original thread. In channels, private task details
are shown only to the requesting user in the thread, following an acknowledgement
containing no task details. These private replies can disappear after Slack is reloaded.
Tasks shared with `all` receive ordinary thread replies. List results are always delivered
by DM. The original commands remain visible to anyone who can read the channel; use a DM
when entering private details. Task access does not grant access to linked Slack messages
or documents.

The creator can access new tasks after delegation. Named assignees can access tasks
directly, and team members can access tasks assigned to their current groups. Every list
and individual lookup enforces visibility before showing fields. Group membership is
freshly verified, including direct group membership lookup when Slack's group discovery
omits a selected or saved group. Failed verification grants no team access. On a
membership lookup failure, directly assigned tasks and shared tasks can still be shown
with a notice that team results are hidden.

## Existing tasks and persistence

Existing records retain their task numbers, assignments, and visibility. Old urgency
values are read as priority, and missing thread references fall back to the original
creation message. Unset optional fields display **Not set**. Datastore fields are added
without changing existing attribute types or deleting old task records.

The source channel and creation-message timestamp form a task's storage key, so replaying
the same creation event does not create a second task. Thread updates retain their event
identity to avoid applying the same update twice. Slack datastores do not expose atomic
conditional updates; simultaneous edits from separate workflow executions can still race.
Notification delivery and Slack messaging likewise cannot form a single database
transaction, so an interrupted delivery may need retrying.

Restart `slack run` or redeploy the hosted app to register the new datastore fields and
assignment-notification datastore. Approve the added `im:write` permission for DMs if
requested. Local and deployed apps have separate task data and identities.

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
  db.ts                        # Slack-hosted task datastore definition
  slack/
    auth.ts                    # Notes on Slack-managed authentication
    events.ts                  # Message checks, task commands, threaded replies
    messages.ts                # Command help, task details, batched task lists
    teams.ts                   # Fresh Slack user-group membership checks
    notifications.ts           # Assignment DMs and durable delivery state
    actions.ts                 # Future button/modal handlers
  tasks/
    models.ts                  # Task fields, priority, and lookup filters
    access.ts                  # Team and legacy-task visibility rules
    commands.ts                # Explicit task and list command parsing
    service.ts                 # Automatic numbering, creation, task filtering
    repository.ts              # Datastore reads/writes and paginated queries
  ai/
    client.ts                  # Optional future integration
    detection.ts               # Optional future detection
    prompts.ts                 # Optional future instructions
tests/                         # Command, service, persistence, reply, and manifest tests
data/                          # Private legacy files and migration backup; ignored
```

## What changed from Python

This is a Deno workflow app that can be deployed onto Slack's infrastructure. `app.ts`
defines a workflow rather than a server to run with `deno run`. Slack invokes
`delebot/slack/events.ts` when the message trigger fires.

The CLI handles installing the hosted app and Slack supplies function tokens. The
TypeScript app does not read the old `.env` tokens, run an OAuth callback server, use
Socket Mode, or require a Cloudflare tunnel. Existing `.env` files, OAuth installation
data, and the ignored Python environment are retained locally. The previous Python source
and README are backed up under `data/migration-backup/python/` (excluded from Git).

The existing dashboard-created Bolt app and its installation are not converted in place by
this source migration. The CLI installs a workflow app with its own identity. Use that new
app for testing; the old installed app can still respond with its old running Python
process until you stop that process. Only stop it once the hosted replacement is tested.

## Requirements

- Deno and Slack CLI, installed on this Mac during migration.
- A paid Slack workspace that allows workflow apps, or an eligible developer sandbox.
- Workspace/admin approval if required by that workspace.

The local development app has its own identity and data. Use the installed local bot for
development testing; deployed apps use a separate environment.

## Check the code locally

From this project directory:

```sh
deno task check
deno task test
deno task lint
```

Format code with `deno task fmt`. Tests use fake Slack clients and do not send messages,
consume AI credits, or require Slack credentials. Only the future AI detection test file
is a placeholder.

## Connect and test a local workflow app

1. Run `slack login` and follow the instructions in the eligible workspace.
2. Run `slack run` from this directory. Choose the intended workspace and create the local
   development app when prompted. Leave that terminal running.
3. In a second terminal in this directory, run:

   ```sh
   slack trigger create --trigger-def triggers/messages.ts
   slack trigger create --trigger-def triggers/thread_replies.ts
   ```

   Select the **local** app created in the previous step. Create each trigger once per app
   environment; duplicate triggers can produce duplicate replies.
4. Invite the local bot to a test channel and mention its actual name, then try an
   individual direct message. It should return command help. Create a task, check the
   confirmation, and check that each list command above sends its full results by DM. Add
   a person in the task thread and confirm that they receive an assignment DM. Add
   repeated links, set a description, priority and due date, then mark the task done and
   delete it. Test another person's access as well.

The two non-overlapping triggers use MessagePosted. New messages pass their own timestamp;
thread replies pass their existing thread root. This avoids passing a null thread
timestamp into Slack workflow validation. Each trigger considers DMs and messages
containing a user mention in conversations the app belongs to. The function then verifies
the exact bot mention and the sender before replying, so mentions of other people never
trigger commands. `users:read` is used for bot sender checks. Task commands use
`datastore:read` and `datastore:write`; the `tasks` datastore is registered in the
manifest. `usergroups:read` allows the bot to fetch user groups and current membership
with `usergroups.list` and `include_users`. Private replies in a channel use
`chat.postEphemeral` with the existing `chat:write` permission. Assignment notifications
and task lists use `im:write` to open a DM and `chat:write` to send the message. No AI is
involved.

For enterprise installations, the bot resolves the workspace from the conversation's
`context_team_id` before looking up user groups. This needs `channels:read` for public
channels and `groups:read` for private channels (`im:read` covers DMs). Restart
`slack run` and approve the updated permissions after adding these scopes. A
single-workspace user profile can serve as a fallback, but an enterprise ID is never used
as a workspace ID.

`slack run` is local development and stops working when its local process stops. This is
distinct from deploying onto Slack.

## Deploy onto Slack

After local testing and workspace approval:

```sh
slack deploy
slack trigger create --trigger-def triggers/messages.ts
slack trigger create --trigger-def triggers/thread_replies.ts
```

Select the deployed app when creating its trigger. Local and deployed apps have separate
triggers and identities. Invite the deployed bot to your test channel and repeat the task
creation and list tests. Once deployed, the hosted bot does not require a local terminal,
a running Mac, a paid external server, or a tunnel.

If replies do not arrive, check the selected workspace/app, trigger existence, channel
membership, granted scopes, and `slack activity`. If a new installation needs approval,
complete that through the workspace's normal approval process.

Existing installations need their local app refreshed or redeployed to register the
datastore fields and notification delivery state, plus **`usergroups:read`** for team
access and **`im:write`** for assignment DMs. Grant any requested workspace approval
before testing. Local and deployed environments have separate task data. This change has
local automated coverage; live task commands still need to be tested against your
installed app.

## References

- [Deno Slack SDK and plan requirements](https://docs.slack.dev/tools/deno-slack-sdk/)
- [Creating event triggers](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-event-triggers/)
- [Creating custom functions](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-custom-functions/)
- [Creating and deploying apps](https://docs.slack.dev/tools/deno-slack-sdk/guides/creating-an-app/)
- [Using Slack datastores](https://docs.slack.dev/tools/deno-slack-sdk/guides/using-datastores/)
- [Datastore put semantics](https://docs.slack.dev/reference/methods/apps.datastore.put/)
- [Datastore query pagination](https://docs.slack.dev/reference/methods/apps.datastore.query/)
- [Slack user groups and membership](https://docs.slack.dev/reference/methods/usergroups.list/)
- [Opening direct messages](https://docs.slack.dev/reference/methods/conversations.open/)
