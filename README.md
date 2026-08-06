# herald

Run many interactive Claude Code instances in tmux and control/observe them all
through plain-text `.herald` files.

Each file is both a **dashboard** (Claude activity is written back as status
markers) and a **control surface** (edits start/stop/clear sessions and queue
prompts). A `tsx` supervisor loop merges every `*.herald` file in the repo dir into
one logical control and reconciles it against live tmux every second. Split your
work across as many `.herald` files as you like (e.g. `work.herald`,
`personal.herald`) — they're combined into one dashboard and each is rewritten in
place. A session (tmux label) may only be driven by one file; if two files declare
the same label, the first wins and the later one is marked `[DUPLICATE]`.

## Setup (once)

```sh
pnpm install
pnpm setup   # makes herald-hook executable, creates state/, installs a
             # command-completion hook for your shell (fish, zsh, and bash are
             # supported), and installs the Stop + Notification +
             # UserPromptSubmit hooks into ~/.claude/settings.json
```

`setup` merges its hooks into your **global** `~/.claude/settings.json` (backing
it up to `settings.json.herald-bak`) and is idempotent — re-run it any time (e.g.
after moving the repo). The Claude hooks are guarded by `$HERALD_LABEL` and the
shell hooks by `$HERALD_SHELL`, so both are a no-op for your normal Claude sessions
and shells and only fire for herald-launched ones.

The **command-completion hook** reports when a `$command` has finished. fish
auto-loads it from `~/.config/fish/conf.d`; bash and zsh get a `source` line
appended to `~/.bashrc` / `~/.zshrc` (each backed up once to `<rc>.herald-bak`).
Only the shell whose config exists is touched, and each hook self-activates just
in its own shell, so whichever shell the session's window runs is handled
automatically.

## Run

```sh
pnpm start            # merge every ./*.herald file and reconcile each second
pnpm start --dry-run  # log intended tmux actions / rewrites without doing them
pnpm herald           # edit .herald in a live Neovim (see below)
pnpm herald work.herald  # …or edit a specific control file
```

## Quickstart

In one terminal, start the supervisor:

```sh
pnpm start
```

In another, put this in a `.herald` file (a bare name resolves to `~/_dev/<name>`):

```
moonbase
	: run the test suite and fix any failures
```

The supervisor spawns tmux session `__moonbase` running `claude` in
`~/_dev/moonbase`, sends the prompt, and marks it `[EXECUTING]`. Watch it work:

```sh
tmux attach -t __moonbase
```

When Claude finishes, the line flips to `[DONE]`. Queue more work by adding lines
**above** it (newest on top) — see the examples below.

## Editing live (`pnpm herald`)

`pnpm herald [file]` opens a `.herald` control file (default `.herald`) in **real
Neovim** (your own config and keybindings) while the supervisor keeps writing to
the same file. Pass a filename to edit a specific one. A small sidecar
attached over nvim's RPC socket folds the controller's out-of-band writes (marker
updates, drained `show` lines, …) into your buffer **without disturbing what you're
typing**:

- It only touches the buffer while you're idle in **normal mode**, so keystrokes are
  never lost — a pending update lands the moment you leave insert.
- With **no unsaved edits**, it's a clean reload (your cursor stays put).
- With **unsaved edits**, it 3-way merges the controller's change into your buffer
  (your line wins on a genuine conflict) and keeps the cursor on the line you were on.

Save with `:w` as usual — the display and file are then in sync. Requires `nvim` on
your `PATH`; respects `HERALD_FILE`. Runs alongside `pnpm start` (that's the point).

## The `.herald` files

The supervisor picks up **every** `*.herald` file in the repo dir and merges them
into one control (sessions from all files combined, alphabetical by filename). Each
file is written back in place, so you can split work across several — one per
context — and still watch them as a single dashboard. The whole of each file is the
managed sessions region; keep your backlog and other notes elsewhere so the
supervisor's rewrites never touch them.

```
moonbase
	brief description (freeform, ignored)
		prompt: newest task, runs last
		prompt: please add feature X, commit, push PR
			[EXECUTING]
		prompt: please start working on X
			[DONE]
moonbase-2
	brief description (freeform, ignored)
		prompt: investigate the flaky test
			[NEEDS ATTENTION]
```

- A line at column 0 is a **session**. It is, in order of precedence:
  - an **alias** listed in `herald-aliases.yaml` → its mapped path, tmux session
    `__<alias>`; or
  - a **path** (`/abs`, `~/…`, or anything containing `/`) → that dir, with the
    label/tmux name taken from its basename (e.g. `~/projects/moonbase` →
    `__moonbase`). Use this to point sessions anywhere on disk; or
  - a **bare name** → dir `~/_dev/<name>`, tmux session `__<name>`.

  A trailing `!` on the header (e.g. `moonbase!`) means **show it now**: the
  supervisor switches your attached tmux client to the session immediately —
  regardless of the queue — then strips the `!` (a one-shot request). The name/path
  resolves from the header without the `!`. This is the eager cousin of a queued
  `show` line (below).
- `prompt: …` lines (`: …` is shorthand) and `$command` lines under a session form
  **one queue** that drains **bottom-to-top**, **one item at a time in file order**
  (oldest at the bottom; append new work at the top). An item runs only once the
  item **below** it — whether a prompt or a command — has finished, so the two
  never overlap and their relative order is exactly their order in the file.
- `prompt:` lines run in the **claude pane**; the supervisor marks one `[EXECUTING]`
  and advances it to `[DONE]` when Claude signals it finished (the hook's Stop
  event). `[NEEDS ATTENTION]` replaces the marker when Claude blocks waiting for
  input mid-task; answering it (submitting a prompt into the pane) flips it back to
  `[EXECUTING]`.
- `$command` lines run **once** in the session's **shell window** (the 2nd window,
  not the claude pane). A command is marked `[EXECUTING]` when dispatched and only
  advances to `[DONE]` once it has actually **exited** (a per-shell hook writes its
  exit status to `state/<label>.cmd` and the controller waits for that done-file). A command
  that never exits (e.g. a server) stays `[EXECUTING]` and blocks the rest of the
  queue — by design. So e.g. `$git push` placed above `: make the change` runs only
  after that prompt is done.
- `#…` lines are **human-action barriers**: a step you must do yourself. When the
  drain reaches one it **stops there** — nothing above it runs, and the `#` line
  never gets a marker — until **you delete the line**. Put one above work that must
  wait on a manual step (e.g. `# rotate the staging secret`). A `#` at the very
  bottom blocks the whole session until removed.
- A bare `show` line is a **queue item** that brings the session **on screen**: when
  the drain reaches it (the item below it is done), the supervisor switches your
  attached tmux client (e.g. the terminal you have open in WezTerm) to it, then
  deletes the `show` line — a one-shot request, ordered like everything else in the
  queue. If the session isn't running yet it's spawned first, then shown when its
  turn comes.
- Only the **current** item keeps a marker — it is the *frontier*: items above it
  (nearer the top) are still pending, items below it have already run. When the
  next item is marked `[EXECUTING]`, the previous marker is stripped, so at most
  one marker is ever shown (the active one, or the final `[DONE]` once the queue
  drains). Delete that final `[DONE]` to re-run the whole queue from the bottom.

## What edits do

| You do | Supervisor does |
| --- | --- |
| Add a session (bare name or path; the dir must exist) | Spawns `tmux` session `__<label>` running `claude` in that dir |
| Add a `prompt:` line | Queues it; sends it to the claude pane when it reaches the front (the item below is done); marks `[EXECUTING]` → `[DONE]` |
| Add a `$command` line | Queues it; runs it once in the shell window when it reaches the front; marks `[EXECUTING]` → `[DONE]` when it exits |
| Add a `#` line | Halts the queue at that point until you delete the line (a human-action barrier) |
| Add a `show` line | When the queue reaches it, switches your attached tmux client to this session, then deletes the line |
| Add a `!` to a session header | Switches your attached tmux client to this session immediately (queue-independent), then strips the `!` |
| Add a space-separated ` !` to any item line (or its marker) | Reveals that item's window immediately — the shell for a `$command`, the claude pane for a prompt — then strips the `!` |
| Delete all prompts under a session | Sends `/clear` (session stays alive, idle) |
| Delete the session name | Kills the tmux session |
| Answer a `[NEEDS ATTENTION]` prompt | Type directly into the tmux; the marker flips back to `[EXECUTING]` on submit, then `[DONE]` when Claude finishes |

Each spawned session has **two windows**: window `claude` (driven by the
controller) and window `shell` (a free shell for you to run commands in). The
claude pane is tagged with a pane-scoped tmux option (`@herald = claude`), so
prompts always target it regardless of which window/pane is focused.

Attach to a session with `tmux attach -t __<label>` (switch windows with your
tmux prefix + `n`/`p`).

## Usage examples

All of these are just text you put in a `.herald` file while `pnpm start` runs.
Remember the queue drains **bottom-to-top**, one item at a time, so **new work
goes on top**. Indentation is with **tabs**.

### Queue several prompts (they run oldest-first)

```
moonbase
	: write a design doc for the new billing flow
	: implement it and add tests
	: open a PR
		[EXECUTING]
```

The bottom item runs first; each next one starts only when the item below it is
`[DONE]`. Here "open a PR" is the active frontier — the two above it are still
pending and carry no marker.

### Mix prompts and shell commands

`$command` lines run in the session's **shell window** and only advance once the
command actually exits, so you can interleave them with prompts and trust the
ordering:

```
moonbase
	$ pnpm test
	: fix whatever the tests flagged
	$ git add -A && git commit -m "wip"
		[EXECUTING]
```

Reading bottom-up: commit the current state, let Claude fix the tests, then run
the suite again. A long-running `$command` (e.g. `$ pnpm dev`) stays `[EXECUTING]`
and intentionally holds the queue — put it last (top) if you want it to linger.

### Pause for a manual step (`#` barrier)

```
moonbase
	: deploy to staging
	# rotate the staging secret, then delete this line
	: prepare the release branch
		[DONE]
```

The drain finishes "prepare the release branch", then **stops** at the `#` line —
nothing above runs until **you delete it**. Use it wherever a human must act
before Claude continues.

### Bring a session on screen

A queued `show` line switches your attached tmux client when the drain reaches it
(ordered like everything else). A bare `!` line is shorthand for `show`:

```
moonbase
	: crunch through the migration
	show
	: warm up the caches
		[DONE]
```

A trailing `!` on the **header** instead switches **immediately**, regardless of
the queue, then strips itself — the "look at this one right now" button:

```
moonbase!
	: something just broke — look now
```

A space-separated trailing `!` on **any item line** reveals *that item's* window
right away: the shell window for a `$command`, the claude pane for a prompt. The `!`
strips itself once shown. The separating space keeps ordinary end punctuation as text
(`: ship it!` stays text; `: ship it !` is a reveal):

```
moonbase
	: crunch through the migration
	$ tail -f build.log !
	: warm up the caches
```

(The same `!` also works appended to an item's status marker, e.g. `[EXECUTING]!`.)

### Clear a session without killing it

Delete all the prompt/command lines under a header but keep the header:

```
moonbase
```

The supervisor sends `/clear` to the claude pane; the tmux session stays alive and
idle, ready for the next prompt. Delete the header line itself to **kill** the
session.

### Answer a blocked task

When Claude stops mid-task to ask something, its line shows `[NEEDS ATTENTION]`:

```
moonbase
	: refactor the auth module
		[NEEDS ATTENTION]
```

Attach (`tmux attach -t __moonbase`) and type your answer into the claude pane.
On submit the marker flips back to `[EXECUTING]`, then `[DONE]` when it finishes.

### Re-run a finished queue

Only the final `[DONE]` remains once a queue drains. Delete that marker line and
the whole queue re-runs from the bottom.

### Several sessions at once

```
moonbase
	: run the test suite
		[EXECUTING]
infra
	$ terraform plan
		[EXECUTING]
scratch
	: prototype the new parser
		[DONE]
```

Each header is an independent session with its own queue; they run in parallel.
`infra` and `scratch` resolve to `~/_dev/infra` and `~/_dev/scratch`; give any of
them a full path or an alias instead (below).

### Point a session anywhere / use an alias

```
~/work/infra-monorepo
	: bump the node version
/tmp/experiment
	: throwaway spike
infra
	: same repo as above, via alias
```

A header containing `/` is used as a path (tmux name = its basename); a bare name
that matches `herald-aliases.yaml` uses the mapped path. See the aliases section.

## Notes

- Permissions: launched Claudes inherit your global bypass setting
  (`skipDangerousModePermissionPrompt`); the supervisor does nothing about them.
- Identity: each Claude launches with `HERALD_LABEL`/`HERALD_STATE` exported; the
  hooks inherit these and write `state/<label>.json`, which the loop reads (using
  the file's mtime as the event time).
- Missing `~/_dev/<label>` ⇒ the session is annotated `[NO DIR …]` and skipped.
- The loop is the sole writer of markers; it computes changes, writes each file,
  then runs tmux actions, and defers if you edit any `.herald` file mid-tick.
- A tmux label is driven by one file only: if two `.herald` files declare the same
  session, the first (alphabetical) wins and the later one is marked `[DUPLICATE]`.

## Repo aliases (`herald-aliases.yaml`)

Optional. A YAML map of `label: path`, so a header in a `.herald` file can be a
short label instead of a full path. `~` expands to your home dir; the label
becomes the tmux session name. See `herald-aliases.example.yaml`.

```yaml
moonbase: ~/projects/moonbase
infra: ~/work/infra-monorepo
```

The file is re-read every tick, so alias edits take effect without a restart. A
header that isn't a listed alias falls back to the path / bare-name rules above.

## Env overrides (mainly for testing)

- `HERALD_DIR` — scan a different directory for `*.herald` files instead of the repo dir.
- `HERALD_FILE` — single-file mode: watch exactly this one file (ignores the `*.herald` scan).
- `HERALD_ALIASES` — read aliases from a different file instead of `./herald-aliases.yaml`.
- `HERALD_READY_MS` — boot grace before the first prompt is sent (default 6000).

## Test

```sh
pnpm test         # parser round-trip + reconciler unit tests
pnpm type-check
```
