# Codex messages during a running turn

With a compatible Codex connection, pressing Enter or the primary send button
while Codex is working submits the draft through `_session/steering` by default.
Codex consumes it at the next safe boundary, such as after a tool call. The
composer clears only after delivery is confirmed; a failed insertion keeps the
draft, and a turn-end race queues the full message for the next turn.

The send menu still offers **Queue message**. On compatible Codex connections,
queued messages are also submitted after a tool call completes (or fails).
The queue shows this delivery mode. Escape in the composer, or **Interrupt and
send now**, cancels the current turn; the ordinary queue sends the messages
once cancellation settles. Escape still closes editor menus and cancels queue
editing first. If no further tool call occurs, end-of-turn delivery is the
queue's fallback.

Codex's own `turn/steer` decides the next point at which inserted input enters
model context. This does not interrupt an already running model request.

Native insertion is available regardless of the **Live Feedback** setting.
That setting controls the optional `check_user_feedback` MCP tool; it is off
by default and must not prevent discovery of a connection's native capability.

## Manual check

1. Install the updated Codeg build and start a fresh Codex connection so the
   adapter loads the compatibility patch. Supported adapters are listed below.
2. While a tool call is running, type a short instruction in the ordinary
   composer and press Enter or the **Insert into current turn** button.
3. The instruction should appear as a user message in the running turn once
   accepted, and enter model context at the next safe boundary. It does not wait
   for a feedback-tool check or for the entire turn to finish.
4. Choose **Queue message** from the send menu to exercise explicit queueing.
   The queue should say **Messages will be submitted after the next tool call.**
5. If the turn finishes before insertion, the queue sends it as the next turn.
   Use Escape with a queued message to test interrupt-and-send instead.

If native insertion is unavailable, Enter still queues messages. Check the
installed build, adapter version and fresh connection.
Enabling Live Feedback instead may only expose the cooperative pull channel;
its waiting notes are not evidence that native insertion is active.

## Adapter compatibility

Upstream codex-acp 1.13.1, 2.0.0 and 2.0.1 ignore
`_meta.steering.idleBehavior = "promptRequired"`. If the target turn ends before
injection, they start a detached prompt. Codeg needs the adapter to return
`{ "outcome": "promptRequired" }` without consuming the input instead.

Codeg writes `codex-steering-loader.mjs` into its per-launch scratch directory
and adds a Node loader to that process's `NODE_OPTIONS`. The loader verifies
both package identity and the exact SHA-256 of the published bundle before
making three in-memory edits: retain the idle option, honor it on the fallback
path, and advertise `_meta.steering.codegPromptRequired = 1`. The adapter's
original module URL and dependency resolution are preserved. Installed package
files are never modified. The loader removes its own option before the patched
adapter launches Codex or other child processes.

The capability gate requires this marker plus a reviewed adapter version;
the normal steering advertisement alone is insufficient. Unknown, modified or
standalone bundles keep their previous behavior. Disabling per-launch scratch
isolation also disables this compatibility path. Restart an existing Codex
connection to load the patch. Desktop and server launches share this code.

When upstream implements `promptRequired`, verify its active-turn lifecycle,
set the upstream version floor in the registry, and retire the compatibility
loader once older versions no longer need support. Adding a new bundle hash
requires reviewing its steering implementation again.

## Why cooperative feedback can remain unread

`check_user_feedback` is an optional MCP tool, injected only when live feedback
is enabled at session launch. Its description asks the model to check before
implementation, before major decisions and between subtasks. There is no timer
or automatic call after other tools. A model that never chooses this tool never
receives pending notes. Native steering does not depend on that choice.

## Validation

Use deterministic adapter protocol checks and queue/UI tests. No inference
request is needed: initialize the adapter to inspect its capability, then
exercise the active/idle/racing branches with a stub app-server client. Confirm
that callers without the opt-in retain upstream's fallback, unreviewed bytes
are not patched, failed sends stay queued, and duplicate tool events do not
resubmit the same message.
