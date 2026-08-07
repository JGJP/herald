#!/usr/bin/env tsx
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fire } from '@jgjp/fire'
import { $, sleep, YAML } from 'zx'

const HERE = dirname(fileURLToPath(import.meta.url))
// The controller merges every `*.herald` file in the control dir (default: the repo
// dir) into one logical control — each file is an independent slice of sessions and
// is rewritten in place. `HERALD_DIR` overrides the dir; `HERALD_FILE` forces
// single-file mode (one explicit file, mainly for tests/one-offs).
const CONTROL_DIR = process.env.HERALD_DIR ? resolve(process.env.HERALD_DIR) : HERE
const SINGLE_FILE = process.env.HERALD_FILE ? resolve(process.env.HERALD_FILE) : null
const CONTROL_EXT = '.herald'
// Optional YAML file of `label: /path/to/repo` aliases, so a header in a `.herald`
// file can be a short label instead of a full path.
const ALIASES_FILE = process.env.HERALD_ALIASES ? resolve(process.env.HERALD_ALIASES) : join(HERE, 'herald-aliases.yaml')
const STATE = join(HERE, 'state')
const RT_PATH = join(STATE, 'controller.json')
const LOCK = join(STATE, 'supervisor.lock')
const DEV_DIR = join(homedir(), '_dev')
// Labels the controller never manages (a blacklist). Empty by default.
const RESERVED = new Set<string>([])
const TICK_MS = 1000
// Grace period for a freshly launched claude to boot before we send its first prompt.
const READY_MS = Number(process.env.HERALD_READY_MS) || 6000
const DRY = process.argv.includes('--dry-run')

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`)

const expandHome = (p: string): string =>
	p.startsWith('~') ? join(homedir(), p.slice(p[1] === '/' ? 2 : 1)) : p

export type Aliases = Record<string, string>

// Resolve a session header to a tmux label and working dir. Precedence:
//   1. an exact alias key → label = the alias, dir = its mapped path;
//   2. a path (bare `/`, `~/…`, or anything with `/`) → that dir, label = basename;
//   3. a bare name → dir `~/_dev/<name>`, label = name.
function resolveTarget(header: string, aliases: Aliases = {}): { label: string; dir: string } {
	if (aliases[header]) return { label: header, dir: resolve(expandHome(aliases[header])) }
	if (header.startsWith('/') || header.startsWith('~') || header.includes('/')) {
		const dir = resolve(expandHome(header))
		return { label: basename(dir), dir }
	}
	return { label: header, dir: join(DEV_DIR, header) }
}

// Load the label→path alias map, tolerating a missing/empty/malformed file.
function loadAliases(): Aliases {
	try {
		const parsed = YAML.parse(readFileSync(ALIASES_FILE, 'utf8'))
		if (!parsed || typeof parsed !== 'object') return {}
		const out: Aliases = {}
		for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
		return out
	} catch {
		return {}
	}
}

// ---------------------------------------------------------------- parse model

type Kind = 'EXECUTING' | 'DONE' | 'ATTENTION'
const MARKER: Record<Kind, string> = {
	EXECUTING: '[EXECUTING]',
	DONE: '[DONE]',
	ATTENTION: '[NEEDS ATTENTION]',
}
interface Prompt {
	text: string
	lineIdx: number
	indent: string
	marker: { kind: Kind; lineIdx: number } | null
	desiredKind: Kind | null
	// A `$command` line: runs once in the session's shell window, then is marked
	// [DONE] like a finished prompt. It never enters the claude prompt queue.
	isCmd: boolean
	// The 1-based lane/pane this item belongs to. `:`/`$` are lane 1 (today's single
	// queue); `:2`/`::`, `$2`/`$$` are lane 2, and so on. Within a lane items serialize
	// bottom-to-top (claude window for prompts, shell for `$`); different lanes run
	// concurrently, each in its own claude<N>/shell<N> window.
	pane: number
	// A bare `show` line: a queue item that, when the drain reaches it (the item
	// below is done), switches the attached tmux client to this session. It fires
	// instantly and never gets a marker; `fired` is set that tick so buildOps
	// deletes the line — the request is consumed, not left as clutter.
	isShow: boolean
	fired: boolean
	// A `!` appended to this item — either to its status marker (`[NEEDS ATTENTION]!`)
	// or directly to its own line (`: do the thing !`, `$ run me !`) — is a one-shot
	// "reveal this item's window now" request, like `!` on a header. It fires once
	// (`showNowFired`) and buildOps strips the `!`, consuming the request.
	showNow?: boolean
	showNowFired?: boolean
	// The `!` is on this item's own line (not its marker), so consuming it rewrites
	// that line to `strippedLine` (the line without the trailing `!`).
	showNowInline?: boolean
	strippedLine?: string
}
interface Session {
	label: string
	dir: string
	headerIdx: number
	lastChildIdx: number
	prompts: Prompt[]
	sessionMarker: { text: string; lineIdx: number } | null
	desiredSession: string | null
	// The header text with any trailing `!` stripped (what to rewrite the line to
	// once a "show now" request is consumed).
	header: string
	// A `!` suffix on the header ("show now"): switch the tmux client to this session
	// immediately, regardless of the queue. `showNowFired` is set the tick we act on
	// it, so buildOps strips the `!` — a one-shot request.
	showNow: boolean
	showNowFired: boolean
}

// A prompt line starts with `prompt:` or the shorthand `:`. A run of colons or a
// trailing number selects the lane/pane: `:`→1, `::`/`:2`→2, `:::`/`:3`→3, …
const PROMPT_RE = /^(?:prompt:|(:+)(\d*))\s*/i
// A command line starts with `$` (runs in the shell window); `$$`/`$2`→lane 2, etc.
const CMD_RE = /^(\$+)(\d*)\s*/
// A sigil run of length `run` (e.g. `::` → 2) or an explicit `digits` suffix (which
// wins) picks the 1-based lane. `prompt:`/plain sigils fall through to lane 1.
const paneFromSigil = (run: string | undefined, digits: string | undefined): number => (digits ? Math.max(1, parseInt(digits, 10) || 1) : run ? run.length : 1)
const isAttention = (x: string | null): boolean => !!x && /NEEDS ATTENTION/i.test(x)
const clearAttention = (s: Session) => {
	if (isAttention(s.desiredSession)) s.desiredSession = null
}

export function parse(content: string, aliases: Aliases = {}): { lines: string[]; sessions: Session[] } {
	const lines = content.split('\n')
	// The whole file is the sessions region; keep your backlog/footer in other
	// files. Blank lines are skipped, so nothing else is preserved verbatim.
	const sessions: Session[] = []
	let cur: Session | null = null
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (line.trim() === '') continue
		// A `#` row is a comment at *any* indent: ignored entirely (never a session,
		// task, or marker) and preserved verbatim, like a blank line. It attaches to the
		// current session's region so a session marker still lands after it.
		if (line.trim().startsWith('#')) {
			if (cur) cur.lastChildIdx = i
			continue
		}
		const tabs = line.match(/^\t*/)?.[0] ?? ''
		if (tabs.length === 0) {
			const raw = line.trim()
			// A trailing `!` on the header means "show this session immediately".
			const showNow = raw.endsWith('!')
			const header = showNow ? raw.slice(0, -1).trimEnd() : raw
			const { label, dir } = resolveTarget(header, aliases)
			cur = {
				label,
				dir,
				headerIdx: i,
				lastChildIdx: i,
				prompts: [],
				sessionMarker: null,
				desiredSession: null,
				header,
				showNow,
				showNowFired: false,
			}
			sessions.push(cur)
			continue
		}
		if (!cur) continue
		cur.lastChildIdx = i
		const t = line.trim()
		if (PROMPT_RE.test(t) || CMD_RE.test(t)) {
			// A space-separated trailing `!` on a prompt or `$command` line means "reveal
			// this item's window now" (the shell for a command, the claude pane
			// otherwise), just like `!` on its marker. The space keeps ordinary end
			// punctuation (`: ship it!`) as text; only `: ship it !` is a reveal. It's
			// stripped from the line once consumed.
			const isCmd = CMD_RE.test(t)
			const re = isCmd ? CMD_RE : PROMPT_RE
			const m = t.match(re)!
			const pane = paneFromSigil(m[1], m[2])
			const bang = /\s!$/.test(t)
			const body = bang ? t.slice(0, -1).trimEnd() : t
			cur.prompts.push({
				text: body.replace(re, ''),
				lineIdx: i,
				indent: tabs,
				marker: null,
				desiredKind: null,
				isCmd,
				pane,
				isShow: false,
				fired: false,
				showNow: bang || undefined,
				showNowInline: bang || undefined,
				strippedLine: bang ? tabs + body : undefined,
			})
		} else if (/^show$/i.test(t) || t === '!') {
			// A bare `!` line is shorthand for `show`.
			cur.prompts.push({
				text: '',
				lineIdx: i,
				indent: tabs,
				marker: null,
				desiredKind: null,
				isCmd: false,
				pane: 1,
				isShow: true,
				fired: false,
			})
		} else if (/^\[.*\]!?$/.test(t)) {
			// A trailing `!` on a marker means "reveal this item's window now".
			const bang = t.endsWith('!')
			const body = bang ? t.slice(0, -1).trimEnd() : t
			const kind: Kind | null = /executing/i.test(body)
				? 'EXECUTING'
				: /attention/i.test(body)
					? 'ATTENTION'
					: /done/i.test(body)
						? 'DONE'
						: null
			// A status marker attaches to the nearest preceding prompt without a
			// marker; anything unrecognised (e.g. [NO DIR …]) is a session marker.
			const target = kind ? [...cur.prompts].reverse().find((p) => !p.marker && !p.isShow) : undefined
			if (kind && target) {
				target.marker = { kind, lineIdx: i }
				target.desiredKind = kind
				if (bang) target.showNow = true
			} else {
				cur.sessionMarker = { text: body, lineIdx: i }
				cur.desiredSession = body
			}
		}
	}
	return { lines, sessions }
}

// ------------------------------------------------- lossless in-place rewrite

type Op = { pos: number; type: 'replace' | 'delete' | 'insert'; text?: string }

export function buildOps(sessions: Session[]): Op[] {
	const ops: Op[] = []
	for (const s of sessions) {
		for (const p of s.prompts) {
			// A fired `show` item is consumed by deleting its line; it has no marker.
			if (p.isShow) {
				if (p.fired) ops.push({ pos: p.lineIdx, type: 'delete' })
				continue
			}
			// A fired inline `!` sits on the item's own line, which the marker logic
			// below never rewrites, so strip it here unconditionally.
			if (p.showNowFired && p.showNowInline && p.strippedLine !== undefined) ops.push({ pos: p.lineIdx, type: 'replace', text: p.strippedLine })
			const cur = p.marker?.kind ?? null
			if (cur === p.desiredKind) {
				// A fired marker `!` ("reveal now") is consumed by stripping the `!`.
				if (p.showNowFired && !p.showNowInline && p.marker) ops.push({ pos: p.marker.lineIdx, type: 'replace', text: `${p.indent}\t${MARKER[cur!]}` })
				continue
			}
			if (p.marker) {
				if (p.desiredKind === null) ops.push({ pos: p.marker.lineIdx, type: 'delete' })
				else ops.push({ pos: p.marker.lineIdx, type: 'replace', text: `${p.indent}\t${MARKER[p.desiredKind]}` })
			} else if (p.desiredKind !== null) {
				ops.push({ pos: p.lineIdx, type: 'insert', text: `${p.indent}\t${MARKER[p.desiredKind]}` })
			}
		}
		// A fired "show now" (`!` header) is consumed by stripping the `!`.
		if (s.showNow && s.showNowFired) ops.push({ pos: s.headerIdx, type: 'replace', text: s.header })
		const cur = s.sessionMarker?.text ?? null
		if (cur === s.desiredSession) continue
		if (s.sessionMarker) {
			if (s.desiredSession === null) ops.push({ pos: s.sessionMarker.lineIdx, type: 'delete' })
			else ops.push({ pos: s.sessionMarker.lineIdx, type: 'replace', text: `\t${s.desiredSession}` })
		} else if (s.desiredSession !== null) {
			ops.push({ pos: s.lastChildIdx, type: 'insert', text: `\t${s.desiredSession}` })
		}
	}
	return ops
}

export function applyOps(lines: string[], ops: Op[]): string[] {
	const out = [...lines]
	const key = (o: Op) => o.pos + (o.type === 'insert' ? 0.5 : 0)
	for (const op of [...ops].sort((a, b) => key(b) - key(a))) {
		if (op.type === 'replace') out[op.pos] = op.text!
		else if (op.type === 'delete') out.splice(op.pos, 1)
		else out.splice(op.pos + 1, 0, op.text!)
	}
	return out
}

// Merge the per-file session lists (in file order) into one global list. tmux labels
// are global, so the first file to claim a label wins; a later file's duplicate is
// annotated `[DUPLICATE]` and dropped from the returned list — its own file still
// rewrites it in place (via buildOps on that file's sessions), so the marker shows up.
export function mergeSessions(perFile: Session[][]): { sessions: Session[]; labels: Set<string> } {
	const labels = new Set<string>()
	const sessions: Session[] = []
	for (const group of perFile) {
		for (const s of group) {
			if (RESERVED.has(s.label)) continue
			if (labels.has(s.label)) {
				s.desiredSession = '[DUPLICATE]'
				continue
			}
			labels.add(s.label)
			sessions.push(s)
		}
	}
	return { sessions, labels }
}

// --------------------------------------------------------------- runtime state

// Per-lane queue state. Each lane (pane) is an independent serial queue, so its
// timers/counters are tracked separately; planQueue reads/writes exactly these fields.
interface LaneRt {
	sentAt: number
	// When the in-flight shell command was dispatched; its done-file must be
	// newer than this to count as finished.
	cmdSentAt: number
	prevPromptCount: number
	// A lane whose claude pane was just created boots before it can take prompts
	// (n>1 only; lane 1's claude boots with the session, gated by RtEntry.starting).
	starting: boolean
	startedAt: number
}
// The subset planQueue itself touches — lets tests pass a plain object.
type QueueRt = Pick<LaneRt, 'sentAt' | 'cmdSentAt' | 'prevPromptCount'>
interface RtEntry {
	starting: boolean
	startedAt: number
	lanes: Record<number, LaneRt>
}
type Rt = Record<string, RtEntry>

const loadRt = (): Rt => {
	try {
		return JSON.parse(readFileSync(RT_PATH, 'utf8'))
	} catch {
		return {}
	}
}
const saveRt = (rt: Rt) => {
	if (!DRY) writeFileSync(RT_PATH, JSON.stringify(rt, null, 2))
}

interface StateEvent {
	event: string
	mtimeMs: number
}
// Done-files are per lane. Lane 1 keeps the bare `<label>.json`/`<label>.cmd` names
// (back-compat, incl. tmux-resurrect restores that predate HERALD_PANE); lane n>1 uses
// `<label>.<n>.json`/`<label>.<n>.cmd`, matching the `HERALD_PANE` suffix the hooks add.
const paneSuffix = (n: number) => (n > 1 ? `.${n}` : '')
const statePath = (label: string, n: number) => join(STATE, `${label}${paneSuffix(n)}.json`)
function readState(label: string, n: number): StateEvent | null {
	const p = statePath(label, n)
	try {
		const event = JSON.parse(readFileSync(p, 'utf8')).event as string
		return { event, mtimeMs: statSync(p).mtimeMs }
	} catch {
		return null
	}
}
const rmState = (label: string, n: number) => {
	try {
		unlinkSync(statePath(label, n))
	} catch {}
}
// A finished `$command` writes its exit status to state/<label>[.n].cmd; the
// controller polls this file's mtime to know the command has actually exited.
const cmdDonePath = (label: string, n: number) => join(STATE, `${label}${paneSuffix(n)}.cmd`)
const readCmdDone = (label: string, n: number): number | null => {
	try {
		return statSync(cmdDonePath(label, n)).mtimeMs
	} catch {
		return null
	}
}
const rmCmdDone = (label: string, n: number) => {
	try {
		unlinkSync(cmdDonePath(label, n))
	} catch {}
}
// Remove every lane's done-files for a label (session teardown), including numbered
// panes, so a later reuse of the label doesn't read a stale completion.
const rmAllDoneFiles = (label: string) => {
	for (const f of readdirSync(STATE)) {
		if (f === `${label}.json` || f === `${label}.cmd` || new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+\\.(json|cmd)$`).test(f)) {
			try {
				unlinkSync(join(STATE, f))
			} catch {}
		}
	}
}
const safeMtime = (p: string): number => {
	try {
		return statSync(p).mtimeMs
	} catch {
		return -1
	}
}

// ------------------------------------------------------------------ tmux glue

const PREFIX = '__'
const T = (label: string) => `${PREFIX}${label}`
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

async function listTmux(): Promise<Set<string>> {
	const r = await $({ nothrow: true, quiet: true })`tmux list-sessions -F '#{session_name}'`
	const out = new Set<string>()
	for (const line of r.stdout.split('\n')) {
		const n = line.trim()
		if (n.startsWith(PREFIX)) out.add(n.slice(PREFIX.length))
	}
	return out
}

// Each lane has a claude window (prompts) and a shell window (`$command`s). We tag each
// pane with a pane-scoped user option (@herald = the role string) which — unlike pane
// titles — the running program can't clobber, and which survives focus changes, non-zero
// base-index, and controller restart. Lane 1 uses the bare roles `claude`/`shell` (the
// window names too), lane n>1 uses `claude<n>`/`shell<n>`. -s searches all windows.
type PaneKind = 'claude' | 'shell'
const paneRole = (kind: PaneKind, n: number): string => (n > 1 ? `${kind}${n}` : kind)

// Resolve a lane's pane by role: prefer the @herald tag, else the window still named for
// that role (tag lost on tmux-resurrect, or a pre-tag session). Null if absent.
async function paneFor(label: string, kind: PaneKind, n: number): Promise<string | null> {
	const role = paneRole(kind, n)
	const r = await $({
		nothrow: true,
		quiet: true,
	})`tmux list-panes -s -t ${T(label)} -F ${'#{pane_id}\t#{@herald}\t#{window_name}'}`
	let byName: string | null = null
	for (const line of r.stdout.split('\n')) {
		const [id, tag, win] = line.split('\t')
		if (!id) continue
		if (tag === role) return id
		if (win === role) byName ??= id
	}
	return byName
}

// The lane-1 claude pane, never null: falls back to the first pane / session target so
// select-window and reveals always have something to point at during a partial spawn.
async function claudePane(label: string, n = 1): Promise<string> {
	const found = await paneFor(label, 'claude', n)
	if (found) return found
	const r = await $({ nothrow: true, quiet: true })`tmux list-panes -s -t ${T(label)} -F ${'#{pane_id}'}`
	return r.stdout.split('\n')[0]?.trim() || T(label)
}
const shellPane = (label: string, n = 1) => paneFor(label, 'shell', n)

// The pane *only* if it still carries its @herald tag. A tmux-resurrect restore brings a
// session back with fresh panes that ran `exec fish` under the session env alone: they
// lost the per-window HERALD_SHELL=1/HERALD_PANE that make the completion hook fire, and
// lost the @herald tag. Such a pane is found by paneFor()'s name fallback but returns null
// here, which is what flags it for repair.
async function taggedPane(label: string, kind: PaneKind, n: number): Promise<string | null> {
	const role = paneRole(kind, n)
	const r = await $({
		nothrow: true,
		quiet: true,
	})`tmux list-panes -s -t ${T(label)} -F ${'#{pane_id}\t#{@herald}'}`
	for (const line of r.stdout.split('\n')) {
		const [id, tag] = line.split('\t')
		if (id && tag === role) return id
	}
	return null
}

async function typeInto(pane: string, text: string, vimInsert = false) {
	const tm = $({ nothrow: true, quiet: true })
	// Claude runs with vim keybindings: drop to normal mode then re-enter insert so
	// the text lands as input, not as normal-mode commands. The gap after Escape
	// keeps the terminal from folding Esc+i into a single Alt-i meta key.
	if (vimInsert) {
		await tm`tmux send-keys -t ${pane} Escape`
		await sleep(80)
		await tm`tmux send-keys -t ${pane} i`
		await sleep(80)
	}
	await tm`tmux send-keys -t ${pane} -l -- ${text}`
	await sleep(120)
	await tm`tmux send-keys -t ${pane} Enter`
}

// `vimInsert` prep only makes sense for a running claude (prompts, /clear); the
// launch line below is typed into the shell before claude starts.
async function sendLine(label: string, text: string, vimInsert = false, n = 1) {
	log(`${DRY ? '[dry] ' : ''}send ${T(label)}${n > 1 ? `:${n}` : ''}: ${JSON.stringify(text)}`)
	if (DRY) return
	await typeInto(await claudePane(label, n), text, vimInsert)
}

// Run a `$command` line in lane `n`'s shell window. The per-shell hook in that window
// writes the command's exit status to its done-file *after* it exits, so the controller
// can tell when the command has actually finished (not just sent).
async function sendCmd(label: string, text: string, n = 1) {
	log(`${DRY ? '[dry] ' : ''}cmd ${T(label)}${n > 1 ? `:${n}` : ''}: ${JSON.stringify(text)}`)
	if (DRY) return
	const pane = await shellPane(label, n)
	if (!pane) {
		log(`no shell pane ${n} for ${T(label)}, skipping command`)
		return
	}
	// The command's exit status is written to its done-file by the per-shell hook
	// in the shell window (see herald-{fish,bash,zsh}.*), so we type it verbatim.
	await typeInto(pane, text)
}

// Create lane `n`'s pane of `kind` as a new window, wired for completion reporting:
// HERALD_LABEL/HERALD_STATE (so a pane recreated on an env-less session still reports),
// HERALD_SHELL to mark a shell as the command-runner, and HERALD_PANE=n (n>1) so the hook
// suffixes its done-file. A claude pane also launches `claude` (the caller waits out the
// boot grace before dispatching to it). Returns the new pane id.
async function ensurePaneWindow(label: string, dir: string, kind: PaneKind, n: number): Promise<string> {
	const tm = $({ nothrow: true, quiet: true })
	const role = paneRole(kind, n)
	const env = ['-e', `HERALD_LABEL=${label}`, '-e', `HERALD_STATE=${STATE}`]
	if (kind === 'shell') env.push('-e', 'HERALD_SHELL=1')
	if (n > 1) env.push('-e', `HERALD_PANE=${n}`)
	const created = (await tm`tmux new-window -P -F ${'#{pane_id}'} -t ${T(label)} -n ${role} -c ${dir} ${env}`).stdout.trim()
	await tm`tmux set-option -p -t ${created} @herald ${role}`
	if (kind === 'claude') {
		await sleep(300)
		await typeInto(created, 'claude')
	}
	return created
}
// Lane 1's shell window (the original free shell); kept as a thin alias for the callers
// (doSpawn / repairShell) that only ever touch lane 1.
const makeShellWindow = (label: string, dir: string) => ensurePaneWindow(label, dir, 'shell', 1)

// The @herald roles present on a session's panes (e.g. {claude, shell}). A complete
// session has both; anything missing means a tmux step during spawn silently failed.
async function taggedRoles(label: string): Promise<Set<string>> {
	const r = await $({ nothrow: true, quiet: true })`tmux list-panes -s -t ${T(label)} -F ${'#{@herald}'}`
	return new Set(r.stdout.split('\n').map((x) => x.trim()).filter(Boolean))
}

async function doSpawn(label: string, dir: string) {
	log(`spawning ${T(label)} in ${dir}`)
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	// HERALD_LABEL/HERALD_STATE are set on the whole session (claude inherits them for
	// its Stop/Notification hook); HERALD_SHELL marks only the shell window, where the
	// per-shell hook writes command done-files (see herald-{fish,bash,zsh}.*).
	await tm`tmux new-session -d -s ${T(label)} -n claude -c ${dir} -e ${`HERALD_LABEL=${label}`} -e ${`HERALD_STATE=${STATE}`}`
	// Tag the claude pane, then open a second window as a free shell for the user.
	await tm`tmux set-option -p -t ${T(label)} @herald claude`
	await makeShellWindow(label, dir)
	await sleep(300)
	await sendLine(label, 'claude')
	// Leave the claude window focused so an attach shows it first.
	await tm`tmux select-window -t ${await claudePane(label)}`
	// The tmux steps above run with nothrow; a partial spawn leaves a half-formed
	// session that blocks command dispatch. Warn loudly (the readiness gate repairs it).
	const roles = await taggedRoles(label)
	if (!roles.has('claude') || !roles.has('shell')) log(`WARN incomplete spawn of ${T(label)} (tagged: ${[...roles].join(',') || 'none'})`)
}

// Recreate lane `n`'s shell window so command completion is reported again. Two cases:
// a partial/absent pane, or a tmux-resurrect restore that brought the shell back stripped
// of its HERALD_SHELL/HERALD_PANE env and @herald tag (see taggedPane). In the restore
// case a stale, untagged shell pane exists — kill its window first so we don't leave a
// duplicate — then create a fresh, tagged one. Leaves the lane-1 claude window focused.
async function repairShell(label: string, dir: string, n = 1) {
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	const stale = await shellPane(label, n)
	log(`repairing ${T(label)} shell${n > 1 ? n : ''}: ${stale ? 'recreating restored window (restoring HERALD_SHELL)' : 'recreating missing window'}`)
	if (stale) await tm`tmux kill-window -t ${stale}`
	await ensurePaneWindow(label, dir, 'shell', n)
	await tm`tmux select-window -t ${await claudePane(label)}`
}

async function doKill(label: string, switchTo: string | null) {
	log(`killing ${T(label)}`)
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	// If a client is currently viewing this session, move it to a surviving
	// controller session first — otherwise killing drops the client onto an
	// unrelated session or detaches it entirely.
	if (switchTo) {
		const r = await tm`tmux list-clients -F ${'#{client_name}\t#{client_session}'}`
		for (const line of r.stdout.split('\n')) {
			const [client, session] = line.split('\t')
			if (client && session === T(label)) await tm`tmux switch-client -c ${client} -t ${T(switchTo)}`
		}
	}
	await tm`tmux kill-session -t ${T(label)}`
}

// Bring this session on screen by switching the first client that's currently
// viewing a controller-managed (`__*`) session — i.e. the terminal you use to watch
// herald sessions (e.g. WezTerm). Clients parked on your own non-`__` sessions are
// left alone. Run outside tmux there is no "current" client, so we target it by name.
async function showSession(label: string, window?: Window) {
	log(`showing ${T(label)}${window ? ` (${paneRole(window.kind, window.n)})` : ''}`)
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	// Bring WezTerm (the terminal watching these sessions) to the foreground, so a
	// `show`/`!` actually surfaces it even when another macOS app is focused. Best-effort.
	await tm`osascript -e ${'tell application "WezTerm" to activate'}`
	// Reveal the window the caller asked for (e.g. the shell for a `$command` show, or a
	// numbered lane's pane), so switching the client lands on it rather than the session's
	// last-active window.
	if (window) {
		const pane = await paneFor(label, window.kind, window.n)
		if (pane) await tm`tmux select-window -t ${pane}`
	}
	const r = await tm`tmux list-clients -F ${'#{client_name}\t#{client_session}'}`
	for (const line of r.stdout.split('\n')) {
		const [client, session] = line.split('\t')
		if (client && session?.startsWith(PREFIX)) {
			await tm`tmux switch-client -c ${client} -t ${T(label)}`
			return
		}
	}
}

const atomicWrite = (path: string, content: string) => {
	if (DRY) {
		log(`[dry] ${basename(path)} would be rewritten`)
		return
	}
	const tmp = `${path}.tmp`
	writeFileSync(tmp, content)
	renameSync(tmp, path)
}

// Every `*.herald` file in the control dir, sorted for a stable merge order. In
// single-file mode (HERALD_FILE) it's just that one file, if it exists.
function controlFiles(): string[] {
	if (SINGLE_FILE) return existsSync(SINGLE_FILE) ? [SINGLE_FILE] : []
	let names: string[]
	try {
		names = readdirSync(CONTROL_DIR)
	} catch {
		return []
	}
	return names
		.filter((n) => n.endsWith(CONTROL_EXT))
		.sort()
		.map((n) => join(CONTROL_DIR, n))
		.filter((p) => {
			try {
				return statSync(p).isFile()
			} catch {
				return false
			}
		})
}

// -------------------------------------------------------------- reconcile tick

// Prompts, `$command` lines, and `show` lines share ONE queue that drains
// bottom-to-top, one item at a time in file order: an item runs only once the item
// below it (its predecessor) has finished. A prompt runs in the claude pane (done
// on the hook's Stop event); a command runs in the shell window (done when its
// done-file is written); a `show` switches the tmux client and completes instantly,
// consuming its own line. Exactly one item ever carries a marker — the "frontier":
// items above it (smaller lineIdx) are pending, items below it have already run.

export type DispatchType = 'prompt' | 'cmd' | 'clear' | 'show'
// A concrete pane to reveal: kind (claude/shell) + 1-based lane. `!` on a `:2`/`$2`
// line reveals `claude2`/`shell2`; a header `!`/`show` reveals the frontier item's pane.
export interface Window {
	kind: PaneKind
	n: number
}
const windowOf = (p: Prompt): Window => ({ kind: p.isCmd ? 'shell' : 'claude', n: p.pane })
export interface Dispatch {
	type: DispatchType
	text?: string
	// For a `show`: the window the last task before it used, so the reveal lands on
	// that window (the shell for a `$command`, the claude pane for a prompt).
	window?: Window
}
export interface PlanIO {
	now: number
	state: { event: string; mtimeMs: number } | null
	cmdDoneMtime: number | null
}

// Nearest pending item above `idx` (the next to run, drain being bottom-to-top).
const nearestAbove = (s: Session, idx: number): Prompt | null => {
	const cands = s.prompts.filter((p) => p.lineIdx < idx && p.desiredKind === null)
	return cands.length ? cands.reduce((a, b) => (b.lineIdx > a.lineIdx ? b : a)) : null
}

// The bottom-to-top frontier: the top-most already-run item, or the file bottom on
// a fresh queue. Shared by planQueue's fresh-dispatch branch and the spawn gate.
const frontierIdx = (s: Session): number => {
	const done = s.prompts.filter((p) => p.desiredKind === 'DONE')
	return done.length ? Math.min(...done.map((p) => p.lineIdx)) : Number.POSITIVE_INFINITY
}

// Whether a session has a pending item the next tick would dispatch. A bare header
// (no prompts/commands) or a fully drained one has nothing to input, so we don't spawn a
// tmux session for it — we only spawn once there's work to feed it.
export const hasPendingInput = (s: Session): boolean => {
	if (s.prompts.some((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION')) return true
	return nearestAbove(s, frontierIdx(s)) !== null
}

// The window used by the last real task before a `show` (the nearest prompt/command
// below it in file order, since the queue drains bottom-to-top). Defaults to the
// claude pane when nothing ran before it.
const lastTaskWindow = (s: Session, showIdx: number): Window => {
	const below = s.prompts
		.filter((p) => p.lineIdx > showIdx && !p.isShow)
		.sort((a, b) => a.lineIdx - b.lineIdx)[0]
	return below ? windowOf(below) : { kind: 'claude', n: 1 }
}

// The window of the session's frontier item — whatever is currently [EXECUTING] (or
// [NEEDS ATTENTION]), else the most recently [DONE] one (the top-most, since the queue
// drains bottom-to-top). Undefined when nothing has run yet. Points a header `!` at
// the right window.
export const frontierWindow = (s: Session): Window | undefined => {
	const active = s.prompts.find((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION')
	const done = s.prompts.filter((p) => p.desiredKind === 'DONE').sort((a, b) => a.lineIdx - b.lineIdx)[0]
	const item = active ?? done
	return item ? windowOf(item) : undefined
}

// The distinct lanes (pane numbers) present in a session, ascending. Each is planned
// independently and runs concurrently with the others.
export const lanesOf = (s: Session): number[] => [...new Set(s.prompts.map((p) => p.pane))].sort((a, b) => a - b)
// A lane's own view: only its items. planQueue on this mutates the shared Prompt objects
// but confines drain/frontier/keepOnly to the lane, so each lane keeps its own marker.
const laneView = (s: Session, n: number): Session => ({ ...s, prompts: s.prompts.filter((p) => p.pane === n) })
const laneHasClaude = (s: Session, n: number) => s.prompts.some((p) => p.pane === n && !p.isCmd && !p.isShow)
const laneHasShell = (s: Session, n: number) => s.prompts.some((p) => p.pane === n && p.isCmd)
const lanePromptCount = (s: Session, n: number) => s.prompts.filter((p) => p.pane === n && !p.isCmd && !p.isShow).length

// Only the frontier item keeps a marker: strip every other [EXECUTING]/[DONE].
const keepOnly = (s: Session, keep: Prompt | null) => {
	for (const p of s.prompts) {
		if (p === keep) continue
		if (p.desiredKind === 'EXECUTING' || p.desiredKind === 'DONE') p.desiredKind = null
	}
}

// Decide the next transition for one (spawned, ready) session. Mutates the items'
// desiredKind and the runtime timers; returns the lines to send this tick. Pure
// w.r.t. I/O so it can be unit-tested by feeding synthetic events.
export function planQueue(s: Session, rt: QueueRt, io: PlanIO): Dispatch[] {
	const out: Dispatch[] = []
	const promptCount = s.prompts.filter((p) => !p.isCmd && !p.isShow).length

	const dispatch = (item: Prompt) => {
		item.desiredKind = 'EXECUTING'
		if (item.isCmd) {
			rt.cmdSentAt = io.now
			out.push({ type: 'cmd', text: item.text })
		} else {
			rt.sentAt = io.now
			out.push({ type: 'prompt', text: item.text })
		}
		keepOnly(s, item)
	}
	// Walk up the queue from `cursor` (bottom-to-top): fire and consume any `show`
	// items instantly (they switch the tmux client, then their line is deleted), until
	// we reach a real item to dispatch or the top. `hold` (a just-finished item) keeps
	// the frontier marker if nothing dispatches.
	const drainUp = (cursor: number, hold: Prompt | null) => {
		for (;;) {
			const next = nearestAbove(s, cursor)
			if (next?.isShow) {
				out.push({ type: 'show', window: lastTaskWindow(s, next.lineIdx) })
				next.fired = true
				cursor = next.lineIdx
				continue
			}
			if (next) dispatch(next)
			else if (hold) keepOnly(s, hold) // drained: hold the frontier
			return
		}
	}

	const active = s.prompts.find((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION')
	if (active) {
		if (active.isCmd) {
			if (io.cmdDoneMtime !== null && io.cmdDoneMtime > (rt.cmdSentAt ?? 0)) {
				active.desiredKind = 'DONE'
				drainUp(active.lineIdx, active)
			}
		} else if (active.text.trim() === '/clear') {
			// `/clear` clears the conversation without invoking the model, so it never
			// fires a Stop hook — an explicit `: /clear` queue item would hang forever at
			// [EXECUTING] waiting for one. It's complete the moment it's been sent (a tick
			// ago, since dispatch happens below), so mark it done and keep draining.
			active.desiredKind = 'DONE'
			drainUp(active.lineIdx, active)
		} else if (io.state && io.state.event === 'Stop' && io.state.mtimeMs > rt.sentAt) {
			active.desiredKind = 'DONE'
			drainUp(active.lineIdx, active)
		} else if (io.state && io.state.event === 'Notification' && io.state.mtimeMs > rt.sentAt) {
			// Claude is blocked waiting for input mid-task: flag this prompt.
			active.desiredKind = 'ATTENTION'
		} else if (io.state && io.state.event === 'UserPromptSubmit' && io.state.mtimeMs > rt.sentAt) {
			// A prompt was submitted into the pane — the user answered a blocking
			// question — so Claude is working again: clear [NEEDS ATTENTION] back to
			// [EXECUTING]. (A no-op while already executing.)
			active.desiredKind = 'EXECUTING'
		}
	} else if (rt.prevPromptCount >= 1 && promptCount === 0) {
		// Every prompt was deleted: reset the claude conversation.
		out.push({ type: 'clear' })
	} else {
		// Nothing running: dispatch the next pending item above the frontier (the
		// top-most already-run item), or the bottom-most item on a fresh queue.
		drainUp(frontierIdx(s), null)
	}

	rt.prevPromptCount = promptCount
	return out
}

interface Control {
	path: string
	content: string
	lines: string[]
	sessions: Session[]
	mtime: number
}

async function tick(rt: Rt) {
	const live = await listTmux()
	const aliases = loadAliases()
	// Read + parse every `.herald` file. Each file's sessions carry line indices into
	// that file's own `lines`, so markers are written back to the file they came from.
	const files = controlFiles()
	// No control files at all means "not configured yet", not "kill everything" — do
	// nothing rather than tearing down every live session over a missing/renamed file.
	// (An empty `.herald` file is the explicit way to drain all sessions.)
	if (files.length === 0) return
	const controls: Control[] = files.map((path) => {
		const mtime = safeMtime(path)
		const content = readFileSync(path, 'utf8')
		const { lines, sessions } = parse(content, aliases)
		return { path, content, lines, sessions, mtime }
	})
	// Merge into one global session list; the first file (alphabetical) to claim a
	// tmux label wins, later duplicates are skipped so only one driver owns each session.
	const { sessions, labels: modelLabels } = mergeSessions(controls.map((c) => c.sessions))
	const actions: (() => Promise<void>)[] = []

	for (const s of sessions) {
		const label = s.label
		if (RESERVED.has(label)) continue
		const dir = s.dir
		if (!existsSync(dir)) {
			s.desiredSession = `[NO DIR ${dir}]`
			continue
		}
		if (!live.has(label)) {
			// Only spawn once there's something to feed the session; a bare header
			// (or a fully drained one) gets no tmux session until work appears. A
			// pending `show`, or a `!` "show now" header, also counts — you can't
			// switch to a session that isn't there yet — so it spawns first.
			if (!hasPendingInput(s) && !s.showNow) continue
			rt[label] = { starting: true, startedAt: Date.now(), lanes: {} }
			actions.push(() => doSpawn(label, dir))
			continue
		}
		// A `!` "show now" header switches the client immediately (even mid-boot — the
		// tmux session exists), independent of the queue; consumed by stripping the `!`.
		if (s.showNow) {
			actions.push(() => showSession(label, frontierWindow(s)))
			s.showNowFired = true
		}
		// A `!` appended to an item's marker or its own line reveals that item's pane —
		// the shell for a `$command`, the claude pane otherwise, in the item's lane.
		for (const p of s.prompts) {
			if (!p.showNow || p.showNowFired) continue
			const window = windowOf(p)
			actions.push(() => showSession(label, window))
			p.showNowFired = true
		}
		// Every session we see live for the first time is un-ready until it clears the
		// grace below. A fresh spawn set this above (with a boot deadline); a reconnect
		// or pre-existing session gets startedAt 0 so the boot grace is already satisfied.
		// This gates lane 1's claude (it boots with the session); lanes >1 gate their own.
		rt[label] ??= { starting: true, startedAt: 0, lanes: {} }
		const re = rt[label]
		re.lanes ??= {} // migrate a flat entry persisted before per-lane rt existed
		if (re.starting && Date.now() - re.startedAt < READY_MS) continue // let claude boot
		re.starting = false
		if (s.desiredSession && /NO DIR/i.test(s.desiredSession)) s.desiredSession = null
		// Attention is a per-prompt marker now; strip any legacy session-level one.
		clearAttention(s)

		// Plan each lane independently: filtered view + its own done-files + its own rt.
		// Different lanes advance concurrently, one active item each.
		for (const n of lanesOf(s)) {
			re.lanes[n] ??= { sentAt: 0, cmdSentAt: 0, prevPromptCount: lanePromptCount(s, n), starting: false, startedAt: 0 }
			const lr = re.lanes[n]
			// Ensure the panes this lane needs exist and can report completion, else create
			// them and wait (skipped in --dry-run, where panes aren't real).
			if (!DRY) {
				// A `:N` lane needs its claude<N> window (n>1; claude1 came with the session).
				if (n > 1 && laneHasClaude(s, n) && (await paneFor(label, 'claude', n)) === null) {
					lr.starting = true
					lr.startedAt = Date.now()
					actions.push(() => ensurePaneWindow(label, dir, 'claude', n).then(() => {}))
					continue
				}
				if (lr.starting && Date.now() - lr.startedAt < READY_MS) continue // let claude<N> boot
				lr.starting = false
				// A `$N` lane isn't ready until it has a *tagged* shell<N> pane — the pane
				// whose per-shell hook reports completion. Missing ⇒ partial spawn; untagged ⇒
				// tmux-resurrect stripped HERALD_SHELL/HERALD_PANE (commands would hang at
				// [EXECUTING]). Either way recreate it (self-heal) before dispatching.
				if (laneHasShell(s, n) && (await taggedPane(label, 'shell', n)) === null) {
					actions.push(() => repairShell(label, dir, n))
					continue
				}
			}
			// Capture what an in-flight command's completion would look like *before*
			// planQueue mutates markers/timers, so we can clear its done-file afterwards.
			const cmdSentAtBefore = lr.cmdSentAt
			const hadActiveCmd = s.prompts.some((p) => p.pane === n && p.isCmd && p.desiredKind === 'EXECUTING')
			const cmdDoneMtime = readCmdDone(label, n)
			const dispatches = planQueue(laneView(s, n), lr, { now: Date.now(), state: readState(label, n), cmdDoneMtime })
			if (hadActiveCmd && cmdDoneMtime !== null && cmdDoneMtime > cmdSentAtBefore) rmCmdDone(label, n)
			for (const d of dispatches) {
				if (d.type === 'prompt') actions.push(() => sendLine(label, d.text!, true, n))
				else if (d.type === 'cmd') actions.push(() => sendCmd(label, d.text!, n))
				else if (d.type === 'clear') actions.push(() => sendLine(label, '/clear', true, n))
				else if (d.type === 'show') actions.push(() => showSession(label, d.window))
			}
		}
	}

	// A session that stays in the control file (and is live) is a safe place to
	// park a client before we kill the session it's watching.
	const survivor = [...live].find((label) => modelLabels.has(label) || RESERVED.has(label)) ?? null
	for (const label of live) {
		if (modelLabels.has(label) || RESERVED.has(label)) continue
		actions.push(() => doKill(label, survivor))
		rmAllDoneFiles(label)
		delete rt[label]
	}

	// If the user edited any `.herald` file while we computed, defer: skip writes AND
	// actions so nothing (e.g. a queued prompt) fires against a stale view.
	for (const c of controls) {
		if (safeMtime(c.path) !== c.mtime) {
			log(`${basename(c.path)} changed mid-tick, deferring`)
			return
		}
	}
	// Rewrite each file in place — only the ones whose markers actually changed.
	for (const c of controls) {
		const newContent = applyOps(c.lines, buildOps(c.sessions)).join('\n')
		if (newContent !== c.content) atomicWrite(c.path, newContent)
	}
	for (const a of actions) await a()
	saveRt(rt)
}

// Two supervisors watching the same control file race on its atomic write and one
// crashes, so we refuse to start a second. We hold a PID lockfile; a stale lock
// (owner no longer alive, e.g. after a crash) is reclaimed. Released on exit/signals.
const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM' // exists, just not ours to signal
	}
}
const acquireLock = () => {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(LOCK, String(process.pid), { flag: 'wx' })
			const release = () => {
				try {
					if (readFileSync(LOCK, 'utf8') === String(process.pid)) unlinkSync(LOCK)
				} catch {}
			}
			process.on('exit', release)
			for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => (release(), process.exit(1)))
			return
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
			const owner = Number(readFileSync(LOCK, 'utf8').trim())
			if (owner && owner !== process.pid && pidAlive(owner)) {
				log(`another herald supervisor is already running (pid ${owner}); refusing to start a second`)
				process.exit(1)
			}
			try {
				unlinkSync(LOCK) // stale lock (owner gone) — reclaim it
			} catch {}
		}
	}
	log('could not acquire supervisor lock')
	process.exit(1)
}

const isMain = (() => {
	const entry = process.argv[1]
	if (!entry) return false
	try {
		return statSync(entry).ino === statSync(fileURLToPath(import.meta.url)).ino
	} catch {
		return false
	}
})()

if (isMain)
	void fire(async () => {
		$.verbose = false
		if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true })
		const rt = loadRt()
		const found = controlFiles()
		if (DRY) {
			// One-shot preview: show what a single tick would do, then exit.
			log(`herald dry-run against ${found.length ? found.map((f) => basename(f)).join(', ') : `(no ${CONTROL_EXT} files found)`}`)
			await tick(rt)
			log('dry-run complete (no changes made)')
			return
		}
		acquireLock()
		log(`herald watching ${SINGLE_FILE ?? `${CONTROL_DIR}/*${CONTROL_EXT}`} (${found.length} file(s))`)
		while (true) {
			await tick(rt)
			await sleep(TICK_MS)
		}
	})
