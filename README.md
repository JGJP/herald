# bot-cmder

Run many interactive Claude Code instances in tmux and control/observe them all
through a single plain-text file, `cmder`.

The file is both a **dashboard** (Claude activity is written back as status
markers) and a **control surface** (edits start/stop/clear sessions and queue
prompts). A `tsx` supervisor loop reconciles the file against live tmux every
second.

## Setup (once)

```sh
pnpm install
pnpm setup   # makes cmder-hook executable, creates state/, and installs the
             # Stop + Notification hooks into ~/.claude/settings.json
```

`setup` merges two hooks into your **global** `~/.claude/settings.json` (backing
it up to `settings.json.cmder-bak`). Both are guarded by `$CMDER_LABEL`, so they
are a no-op for your normal Claude sessions and only fire for cmder-launched ones.

## Run

```sh
pnpm start           # watch ./cmder and reconcile every second
pnpm start --dry-run # log intended tmux actions / rewrites without doing them
```

## The `cmder` file

The whole file is the managed sessions region — keep your backlog and other
notes in separate files so the supervisor's rewrites never touch them.

```
superapp
	brief description (freeform, ignored)
		prompt: newest task, runs last
		prompt: please add feature X, commit, push PR
			[EXECUTING]
		prompt: please start working on X
			[DONE]
superapp-2
	[NEEDS ATTENTION]
```

- A line at column 0 is a **session**. It is either:
  - a **bare name** → dir `~/_dev/<name>`, tmux session `__<name>`; or
  - a **path** (`/abs`, `~/…`, or anything containing `/`) → that dir, with the
    label/tmux name taken from its basename (e.g. `~/_dev/_startale/superapp` →
    `__superapp`). Use this to point sessions anywhere on disk.
- `prompt: …` lines under a session are a **queue**. They drain **bottom-to-top**
  (oldest at the bottom; append new tasks at the top).
- Markers are written by the supervisor: `[DONE]`, `[EXECUTING]` per prompt;
  `[NEEDS ATTENTION]` per session (Claude is idle/asking with nothing queued).

## What edits do

| You do | Supervisor does |
| --- | --- |
| Add a session (bare name or path; the dir must exist) | Spawns `tmux` session `__<label>` running `claude` in that dir |
| Add a `prompt:` line | Sends it (once the running one finishes); marks `[EXECUTING]` → `[DONE]` |
| Delete all prompts under a session | Sends `/clear` (session stays alive, idle) |
| Delete the session name | Kills the tmux session |
| Answer a `[NEEDS ATTENTION]` prompt | Type directly into the tmux; state follows |

Each spawned session has **two windows**: window `claude` (driven by the
controller) and window `shell` (a free shell for you to run commands in). The
claude pane is tagged with a pane-scoped tmux option (`@cmder = claude`), so
prompts always target it regardless of which window/pane is focused.

Attach to a session with `tmux attach -t __<label>` (switch windows with your
tmux prefix + `n`/`p`).

## Notes

- Permissions: launched Claudes inherit your global bypass setting
  (`skipDangerousModePermissionPrompt`); the supervisor does nothing about them.
- Identity: each Claude launches with `CMDER_LABEL`/`CMDER_STATE` exported; the
  hooks inherit these and write `state/<label>.json`, which the loop reads (using
  the file's mtime as the event time).
- Missing `~/_dev/<label>` ⇒ the session is annotated `[NO DIR …]` and skipped.
- The loop is the sole writer of markers; it computes changes, writes the file,
  then runs tmux actions, and defers if you edit `cmder` mid-tick.

## Env overrides (mainly for testing)

- `CMDER_FILE` — watch a different control file instead of `./cmder`.
- `CMDER_READY_MS` — boot grace before the first prompt is sent (default 6000).

## Test

```sh
pnpm test         # parser round-trip + reconciler unit tests
pnpm type-check
```
