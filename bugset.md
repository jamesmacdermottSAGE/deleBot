# Bug Sets

## Key

- `->` means "delegates to" -  this takes highest priority
- `,` means "then"
- `<->` means "collaborates with"
- `+` means "accepts"
- `!` means "declines"
- `|` separates branches
- `^` means "updates task"

## Bug set 1

- Access me in task thread not working - fix me keyword
- Access me returns huge paragraph - fix prev bug and shorten return paragraph
- Completion/deletion request rejection should display rejection, not just request confirmation
- All messages should display the task number and name, i.e. if a task is deleted or a completion request is rejected, it should show the name and number of the task involved
- Continuing on this: user should be able to reply in thread, e.g. "assign x", in response to any task-related message, i.e. "task 123 completion rejected"

## Bug set 2

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
