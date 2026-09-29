# Codex messages during a running turn

With live feedback enabled and a compatible Codex connection, messages queued
while Codex is working are submitted through `_session/steering` after a tool
call completes (or fails). The queue shows this delivery mode. Escape in the
composer, or **Interrupt and send now**, cancels the current turn; the ordinary
queue sends the messages once cancellation settles. Escape still closes editor
menus and cancels queue editing first.

The tool-boundary event triggers delivery; Codex's own `turn/steer` decides the
next point at which the input enters model context. This does not interrupt an
already running model request. If no further tool call occurs, ordinary
end-of-turn delivery remains the fallback. Failed inserts retain the draft.

## Adapter compatibility

Upstream codex-acp 1.13.1 and 2.0.0 ignore
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
