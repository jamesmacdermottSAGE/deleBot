# DeleBot

Replies that edit or respond to a task in its thread now give a short confirmation; the
existing task cards refresh automatically. Use `print` in that thread, or `123 print`
elsewhere, to show the complete task again. Delegations display as one chain, e.g.
`@alice ↪️ Delegated → @james ⏳ Pending`, instead of repeating the recipient separately.
The all-users display label is **All**; the command value remains `all`.

Displayed task cards refresh after edits, assignment responses and completion. Cards
already posted in other task threads or list results are updated in place; deleted tasks
are marked deleted, and copies lose visibility when the viewer's access is removed.
Previously posted single-task DM cards can be recovered from saved conversation context.
Task numbers are also stored as exact text to prevent long references being rounded by
Slack's numeric storage. Restart the local app to register `task_displays` and the
`number_text` field. If Slack cannot refresh a copy, DeleBot reports the incomplete
refresh rather than treating it as a successful update of every message.

Empty task fields display blank values. Access displays `all` for everyone; Created by
continues to show the creator. Creating, editing or looking up one task starts or
continues a reply thread. Collection lists such as `ls me` send task-picker messages in
the main DM.

Task cards now show **Access** (the editing access field), regular links, **Jira** links,
and **GitHub** links. The view-permissions field is omitted from cards. Existing stored
visibility rules remain enforced for older restricted tasks.

Use `jira https://jira.example/ABC-1`, `github https://github.com/org/repo/pull/1`, and
`link https://example.com` independently. `edit jira URL` replaces Jira links;
`delete jira github` clears those categories. `access @person @team` changes editing
access; `access all` allows everyone who can view the task to edit it.

Each task returned by `ls me`, `ls@username` (select the real person mention), or another
list command arrives as a separate top-level DM message. Reply to a specific card to edit,
delete, complete, accept, reject, or `delegate @person` / `delegate @team`. Personal
commands without a selected task still require a number when several tasks were shown.
Assignment states are ⏳ pending, ✅ accepted, ❌ rejected, and ↪️ delegated.
Rejected/delegated people remain in the displayed history; each replacement starts a new
pending invitation. The completion field is last and displays ✅ or ⬜.

DM DeleBot directly, with no bot mention. `ls me` followed by `done` completes the task
when exactly one task was shown. Replies in a task-list thread use that list's context;
lists containing several tasks require a number (`123 done`) or `ls task Name` to select
one. Permissions are checked again on each update. Task-picker lists appear in the main
DM; other commands start or continue a thread.

Type `teams` to list team handles, then enter `assign @alphateam`, `ls @alphateam`, or
`access @alphateam` directly. This works without relying on the Slack composer's team
autocomplete. Task cards use spaced fields, status emojis and a divider.

Temporary development reset: `@DeleBot delete all` permanently clears the app's entire
`tasks` and `assignment_notifications` databases, including hidden tasks and deleted-task
records. Any human who can message the bot can run it; this is intended for development.
Existing Slack messages and DMs remain. Send the command by itself without a task number.

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
appropriate. Priorities display as a plain number, and links display their full URLs. New
tasks start with `viewPerms all` and `editPerms all`, so everyone can view and edit them
until those fields are changed. Assignments and permissions are separate.

Add any combination of named fields after the name:

```text
@DeleBot task errands assign @james p 2 due 6/11/26 describe Run my errands link https://example.com/list
@DeleBot task Clean PRs assign @james @alphasquad_backend describe Review open PRs p 1 due 10/11/26
```

Select actual people and Slack user groups from the mention menu. People and teams can
share the same assignment field. The supported fields are:

| Command               | Meaning                                        | Example                           |
| --------------------- | ---------------------------------------------- | --------------------------------- |
| `assign`              | Add people or teams to the assignees           | `assign @james @frontend`         |
| `describe`            | Append description text                        | `describe Review the open PRs`    |
| `descibe`             | Accepted spelling alias for `describe`         | `descibe Run my errands`          |
| `description`         | Another alias for `describe`                   | `description Read the proposal`   |
| `desc`                | Another alias for `describe`                   | `desc Review the proposal`        |
| `p` or `priority`     | Set priority, 1 highest to 5 lowest            | `p 1`                             |
| `due`                 | Set a UK day/month/year date                   | `due 6/11/26`                     |
| `due -`               | Clear the due date                             | `due -`                           |
| `link` or `links`     | Add HTTP/HTTPS links                           | `link https://example.com/review` |
| `done` or `work done` | Mark the task completed                        | `done`                            |
| `viewPerms`           | Replace the view permission list               | `viewPerms @james @frontend`      |
| `editPerms`           | Replace the edit permission list               | `editPerms @frontend`             |
| `perms match`         | Copy view permissions to edit permissions once | `perms match`                     |

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

People allowed by both view and edit permissions can update the task. If multiple tasks
belong to the same thread, use a task number to select one. The bot will not guess which
task to update. Creating a task inside an existing thread associates it with that thread's
root.

Outside a task thread, prefix the update with its task number:

```text
@DeleBot 123 assign @alice link https://example.com/review
@DeleBot 123 done
@DeleBot 123 work done
```

Use the actual number from the task confirmation or list. `done` is idempotent: marking an
already completed task done keeps it completed. Use `edit completed no` to reopen it.

## Replace or clear fields

Use `edit` when a field should replace its current contents. It applies to all following
fields in the same command:

```text
@DeleBot edit due 6/11/26 p 1 desc "New description"
@DeleBot edit name "Review due dates" assign @alice link https://example.com/new
@DeleBot 123 edit completed no
```

The assignment and link values following `edit` become the complete replacement lists.
Repeated values of the same field within one command are combined and deduplicated;
repeated descriptions form paragraphs. Without `edit`, assignments, links, and
descriptions retain their additive behavior. Do not add and replace the same field in one
command. Invalid commands apply no changes.

Clear fields with `delete` followed by their names, without values:

```text
@DeleBot delete due p desc
@DeleBot 123 delete links assignees
@DeleBot delete completed
```

Clearing links, assignments, and description empties them; clearing priority or due date
unsets it; clearing completed reopens the task. Clearing `viewPerms` or `editPerms` resets
that permission to `all`. A task must retain a name: rename it with `edit name`. Send
field clears separately from other changes.

Delete a task from its thread with `@DeleBot delete`, or select it elsewhere with
`@DeleBot 123 delete`. View and edit permission are required to delete a task. DeleBot
replies in the original thread with a confirmation; deleted tasks no longer appear in
lists. Bare `delete` removes the whole task; `delete` followed by field names clears only
those fields.

## Access

`access @person @team` replaces editing access; `access all` grants editing access to all
viewers. `edit access @person` works too; `delete access` resets editing access to all.
Teams and people can be combined. Old `editPerms` commands remain compatible. The
view-permissions field is omitted from task cards and current help. Existing stored
visibility restrictions are retained so older private tasks are not silently published.

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
person's private tasks. Unassigned tasks can appear in bare `ls` when view permission
allows, but do not match personal or team assignment filters.

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
General and creation help replies appear in the original thread; list help arrives by DM.
Help does not query task storage or team membership.

## Assignment notifications and access

Newly assigned people who have view permission receive a private message from DeleBot
after the task has been saved. Assigning a team notifies its current members who can view
the task, with overlapping people deduplicated. Assigning `all` marks everyone as an
assignee without changing permissions or broadcasting assignment DMs to the workspace.
Existing assignees are not notified again merely because another field changes.
Notification delivery state is saved separately so a retry can resume failed deliveries. A
task can be saved even if Slack cannot deliver one of its assignment notifications. A
later authorized task update also retries saved, undelivered assignment notifications.

Assignment invitations include **Accept**, **Reject**, and **Reassign** buttons:

- **Accept** marks your invitation as accepted in that DM.
- **Reject** deletes your invitation DM and removes your direct user assignment. If you
  received it through a team assignment, the team remains assigned to the task.
- **Reassign** opens a modal with a Slack people picker and an optional teams field. Enter
  team handles such as `@frontend` or paste Slack user-group mentions. Choose at least one
  person or team, up to 20 combined. Reassignment requires both view and edit permission.
  Direct recipients must already have view permission; reassignment does not grant it.
  Your invitation is updated to show its delegation, and eligible new assignees receive
  their own invitations.

Each invitation belongs to its recipient. DeleBot checks current task permissions and
assignment membership again when a button is used. Button availability depends on the
Slack workflow execution lifetime; use the task's thread or its number if controls are no
longer available.

Creation and update replies stay in the original thread. In channels, private task details
are shown only to the requesting user in the thread, following an acknowledgement
containing no task details. These private replies can disappear after Slack is reloaded.
Tasks whose view permission is `all` receive ordinary thread replies. List results are
always delivered by DM. The original commands remain visible to anyone who can read the
channel; use a DM when entering private details. Task access does not grant access to
linked Slack messages or documents.

Every list, lookup, update, deletion, and assignment notification enforces view
permissions before showing fields. Updates and deletion additionally require edit
permission. Group membership is freshly verified, including direct group membership lookup
when Slack's group discovery omits a selected or saved group. Failed verification grants
no group-based access. On a membership lookup failure, explicitly named viewers and tasks
with view permission `all` can still be shown with a notice that team results are hidden.

## Existing tasks and persistence

Existing records retain their task numbers, assignments, and visibility. Old urgency
values are read as priority, and missing thread references fall back to the original
creation message. Unset optional fields display **Not set**. Datastore fields are added
without changing existing attribute types or deleting old task records. Legacy tasks
display **Existing task access** for unset permission fields; this preserves their
previous access rules instead of silently sharing old private data.

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
    actions.ts                 # Assignment invitation button and modal handlers
  tasks/
    models.ts                  # Task fields, priority, and lookup filters
    access.ts                  # View/edit permission checks and legacy visibility
    commands.ts                # Explicit task and list command parsing
    service.ts                 # Creation, edits, permissions, and task filtering
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
