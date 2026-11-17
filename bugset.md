# Bug Sets

## Index

- [Key](#key)
- [Bug Set 1](#bug-set-1)
- [Bug Set 2](#bug-set-2)
- [Bug Set 3](#bug-set-3)
- [Bug Set 4](#bug-set-4)

## Key

- `->` means "delegates to" - this takes highest priority
- `,` means "then"
- `<->` means "collaborates with"
- `+` means "accepts"
- `!` means "declines"
- `|` separates branches
- `^` means "updates task"
- `^^` means "makes request update"
- `^+ , ^!` means "accepts/rejects update request"

## Bug Set 1

- Access me in task thread not working - fix me keyword
- Access me returns huge paragraph - fix prev bug and shorten return paragraph
- Completion/deletion request rejection should display rejection, not just request confirmation
- All messages should display the task number and name, i.e. if a task is deleted or a completion request is rejected, it should show the name and number of the task involved
- Continuing on this: user should be able to reply in thread, e.g. "assign x", in response to any task-related message, i.e. "task 123 completion rejected"

## Bug Set 2

- Ensure deadlock prevention - implement locks on tasks?
- Reassigning a task already assigned to someone reopens the assignment request for the original assignee - add a new response for that. Currently it displays the new assignment accept/reject message; we want a new case
- Rework `ls` - when `ls` is used in a task thread it should print the task that is the subject of the current thread the user is in. Also add the keyword `complete` to `ls` to only show completed tasks; the default will only display incomplete tasks
- Add a tick or X emoji for deletion/completion requests to improve the visual
- Change the keyword `done` to `complete`; add the keyword `incomplete` in task editing that removes completion from a task. This must be request based, and the user must have access
- Getting a bug when just running `assign x` to a task. It unexpectedly broke, but worked on an identical rerun. Terminal output:

  ```text
  2026-11-12 13:30:35 [info] [Datastore:tasks] (Trace=Tr0CH8UUL32Q) Datastore get succeeded with 'id: D0CE1ALD9ST:1794489977.611629'
  2026-11-12 13:30:36 [error] [Fn0CE0CG6C0M] (Trace=Tr0CH8UUL32Q) Function 'Handle a DeleBot task command' (app function) failed
          event_dispatch_failed
  2026-11-12 13:30:36 [error] [Wf0CE5FQ82CS] (Trace=Tr0CH8UUL32Q) Workflow step 'Handle a DeleBot task command' failed
  2026-11-12 13:30:36 [error] [Wf0CE5FQ82CS] (Trace=Tr0CH8UUL32Q) Workflow 'DeleBot replies' failed
          Function failed to execute
  2026-11-12 13:30:36 [error] [Fn0CDQA0AD71] (Trace=Tr0CH8UUL32Q) Function 'DeleBot replies' (workflow function) failed
          Function failed to execute
  ```

- Improve the update response message from `(Tick Emoji) Task #3644025515275626: 3 — Updated.` to remove the em dash and display which field has been completed
- Edge case: for `x -> y -> x`, consider this as the task bouncing back to the creator
- Edge case: for `x -> (y -> x | z)`, this can be considered as y rejecting the task: update the task to show that y rejects it, but the task should not bounce back until z acts
- A user with access should always be able to edit a task, regardless of whether they are a creator or collaborator
- The collaboration request message should update once the invitee has responded, i.e. accepted or rejected the collaboration
- Update messages should be shown to everyone, not just in response to the thread the task was edited in. For example, `x -> y`, `y <-> x+ | x^` = y should show that update in their own thread

## Bug Set 3

- Notify the user when their task is deleted, and identify the user who deleted it in the deletion message (e.g. "Deleted by ...").
- Fix the task acceptance form remaining open after clicking Accept, even when the task is accepted and assigned.
- Investigate the "Task saved. Earlier task messages could not be refreshed; list the task again for its latest state." popup.
- Improve bot response speed.
- Fix deleted tasks continuing to display their previous version. Terminal output:

  ```text
  2026-11-12 15:07:21 [error] [Fn0CE0CG6C0M] (Trace=Tr0CGQU94MU7) Function 'Handle a DeleBot task command' (app function) failed
          Reply sent, but I couldn't remember its task context. Use the task number for your next update.
  2026-11-12 15:07:21 [error] [Wf0CE5FQ82CS] (Trace=Tr0CGQU94MU7) Workflow step 'Handle a DeleBot task command' failed
  2026-11-12 15:07:21 [error] [Wf0CE5FQ82CS] (Trace=Tr0CGQU94MU7) Workflow 'DeleBot replies' failed
          Reply sent, but I couldn't remember its task context. Use the task number for your next update.
  2026-11-12 15:07:21 [error] [Fn0CDQA0AD71] (Trace=Tr0CGQU94MU7) Function 'DeleBot replies' (workflow function) failed
          Reply sent, but I couldn't remember its task context. Use the task number for your next update.
  ```

- When access is initiated, grant access only to the creator. Add `access all` to grant access to everyone, rather than granting everyone access at task creation.
- When a completion request is made with `x^(access = x) -> y, y^^(complete = true), x^+`, send the completion request only to the person who made the request. The request message should update instead of being posted again, so the requestee does not receive a duplicate. Apply the same behavior to collaboration requests, and send the assignee a confirmation that updates rather than creating multiple messages.
- Allow an optional message when rejecting requests (e.g. deletion or reopening requests) to provide more information to the requestee. Add the keyword `reopen`, identical to `incomplete`.
- Remove task numbers from messages except for initial task creation and task lists. For example, a request should show the task name followed by the request, rather than the long task number and name.
- Update the delegation text box to accept only person or team mentions, with no free text. Consider allowing multiple mentions.
- Fix the assignment message delivery/update failure after using `ls` on a task bounceback: "Your response was saved, but some assignment messages could not be delivered or updated. Retry this response, or update the task to retry delivery."
- Investigate the `restricted_action_read_only_channel` error when sending a reply in a DM, which seems to occur after the server has been running while the computer is off or idle:

  ```text
  09:59:45 [error] [Fn0CE0CG6C0M] (Trace=Tr0CHHJL04JV) Function 'Handle a DeleBot task command' (app function) failed
  Cannot send reply: restricted_action_read_only_channel
  ```

- Remove the `clear` function and replace it with a `space` keyword that prints a large block in the chat to help users separate information in their DM.
- Fix collaboration rejection failing with "I could not apply this response. Please try again." Terminal output:

  ```text
  2026-11-13 11:48:34 [error] [Fn0CE0CG6C0M] (Trace=Tr0CHL88C9L4) Function 'Handle a DeleBot task command' (app function) failed
          Reply sent, but I couldn't remember its task context. Use the task number for your next update.
  2026-11-13 11:48:34 [error] [Wf0CE5FQ82CS] (Trace=Tr0CHL88C9L4) Workflow step 'Handle a DeleBot task command' failed
  2026-11-13 11:48:34 [error] [Wf0CE5FQ82CS] (Trace=Tr0CHL88C9L4) Workflow 'DeleBot replies' failed
          Reply sent, but I couldn't remember its task context. Use the task number for your next update.
  ```

- When a task is assigned to two people, show a rejection message in the thread when either assignee rejects. Currently, the message appears for the first assignee but not the second.

## Bug Set 4

- Fix task deletion displaying a second message instead of only updating the original. Send deletion notifications in DMs so users can see them without opening the thread; also notify users about amendments.

  Example:

  ```text
  DeleBot Dev (local) [11:45 AM]
  test

  :wastebasket: Deleted by @JamesM2.
  ```

- Include who amended a task in the amendment message, and replace the tick emoji with a unique amendment emoji.
- Investigate the assignment message delivery/update failure:

  ```text
  Your response was saved, but some assignment messages could not be delivered or updated. Retry this response, or update the task to retry delivery.
  ```

- Fix the bounceback case where `x -> y(t1, t2, t3, t4)`, `y(+t1, !t2, !t3, +t4)` sends the task back to `x`, but `x` does not receive a decision notification to accept or delete it. The equivalent `t2` case works as expected.
- Ensure accepted assignees can make collaboration requests, while access is still required to delete and complete tasks. For example, with `x^(access = x) -> y+`, `y <-> x`, `y` incorrectly receives "Only the accepted assignee can invite collaborators."
- Add a `block` command (for example, `block x`) to prevent editing field `x` unless the user has been granted access.
- Blank action buttons after they are clicked or while processing (for example, accepting a task or rejecting a collaboration request) to prevent repeated clicks from breaking the bot.
- Improve rejection response speed.
- Update the `space` message: remove the two lines at the top and bottom so it appears as a large blank message, and increase its size to fill computer screens and look like a new DM.
- Investigate the error when running `delete all`; it may be related to the computer being switched off or idle:

  ```text
  2026-11-17 09:37:55 [info] [Wf0CE5FQ82CS] (Trace=Tr0CJ82Y1G75) Event trigger successfully started execution of function 'DeleBot replies'
  2026-11-17 09:37:55 [info] [Fn0CDQA0AD71] (Trace=Tr0CJ82Y1G75) Function 'DeleBot replies' (app function) started
  2026-11-17 09:37:55 [info] [Wf0CE5FQ82CS] (Trace=Tr0CJ82Y1G75) Workflow 'DeleBot replies' started
  2026-11-17 09:37:55 [info] [Wf0CE5FQ82CS] (Trace=Tr0CJ82Y1G75) Workflow step 1 of 1 started
  2026-11-17 09:37:55 [error] [Fn0CE0CG6C0M] (Trace=Tr0CJ82Y1G75) Function 'Handle a DeleBot task command' (app function) failed
          event_dispatch_failed
  2026-11-17 09:37:56 [error] [Wf0CE5FQ82CS] (Trace=Tr0CJ82Y1G75) Workflow step 'Handle a DeleBot task command' failed
  2026-11-17 09:37:56 [error] [Wf0CE5FQ82CS] (Trace=Tr0CJ82Y1G75) Workflow 'DeleBot replies' failed
          Function failed to execute
  2026-11-17 09:37:56 [error] [Fn0CDQA0AD71] (Trace=Tr0CJ82Y1G75) Function 'DeleBot replies' (app function) failed
          Function failed to execute
  ```

- When a user rejects any request, notify them in their DM (for example, "You rejected task t").
- Add priority emojis: two exclamation mark emojis for `p1`, one for `p2`, and none for other priority values.
- Shorten the README substantially and remove comments from files.
- (Follow-up to Bug Set 3) When a task assigned to two people is rejected by both, show the second person's rejection in the original creation thread before continuing the usual bounceback procedure. The first person's rejection currently appears; the second person's does not.
