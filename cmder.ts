#!/usr/bin/env tsx
import {
	existsSync,
	mkdirSync,
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
const CMDER = process.env.CMDER_FILE ? resolve(process.env.CMDER_FILE) : join(HERE, 'cmder-control')
// Optional YAML file of `label: /path/to/repo` aliases, so a header in
// cmder-control can be a short label instead of a full path.
const ALIASES_FILE = process.env.CMDER_ALIASES ? resolve(process.env.CMDER_ALIASES) : join(HERE, 'cmder-aliases.yaml')
const STATE = join(HERE, 'state')
const RT_PATH = join(STATE, 'controller.json')
const DEV_DIR = join(homedir(), '_dev')
// Labels the controller never manages (a blacklist). Empty by default.
const RESERVED = new Set<string>([])
const TICK_MS = 1000
// Grace period for a freshly launched claude to boot before we send its first prompt.
const READY_MS = Number(process.env.CMDER_READY_MS) || 6000
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
	// A `#` line: a human action. It never runs or gets a marker; when the drain
	// reaches it the queue halts there until the line is removed.
	isBarrier: boolean
	// A bare `show` line: a queue item that, when the drain reaches it (the item
	// below is done), switches the attached tmux client to this session. It fires
	// instantly and never gets a marker; `fired` is set that tick so buildOps
	// deletes the line — the request is consumed, not left as clutter.
	isShow: boolean
	fired: boolean
	// A `!` appended to this item's status marker (e.g. `[NEEDS ATTENTION]!`) is a
	// one-shot "reveal this item's window now" request, like `!` on a header. It fires
	// once (`showNowFired`) and buildOps strips the `!`, consuming the request.
	showNow?: boolean
	showNowFired?: boolean
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

// A prompt line starts with `prompt:` or the shorthand `:`.
const PROMPT_RE = /^(?:prompt:|:)\s*/i
// A command line starts with `$`; the command runs in the shell window.
const CMD_RE = /^\$\s*/
// A barrier line starts with `#`; it marks a human action that halts the queue.
const BARRIER_RE = /^#\s*/
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
		if (PROMPT_RE.test(t)) {
			cur.prompts.push({
				text: t.replace(PROMPT_RE, ''),
				lineIdx: i,
				indent: tabs,
				marker: null,
				desiredKind: null,
				isCmd: false,
				isBarrier: false,
				isShow: false,
				fired: false,
			})
		} else if (CMD_RE.test(t)) {
			cur.prompts.push({
				text: t.replace(CMD_RE, ''),
				lineIdx: i,
				indent: tabs,
				marker: null,
				desiredKind: null,
				isCmd: true,
				isBarrier: false,
				isShow: false,
				fired: false,
			})
		} else if (BARRIER_RE.test(t)) {
			cur.prompts.push({
				text: t.replace(BARRIER_RE, ''),
				lineIdx: i,
				indent: tabs,
				marker: null,
				desiredKind: null,
				isCmd: false,
				isBarrier: true,
				isShow: false,
				fired: false,
			})
		} else if (/^show$/i.test(t)) {
			cur.prompts.push({
				text: '',
				lineIdx: i,
				indent: tabs,
				marker: null,
				desiredKind: null,
				isCmd: false,
				isBarrier: false,
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
			const target = kind ? [...cur.prompts].reverse().find((p) => !p.marker && !p.isBarrier && !p.isShow) : undefined
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
			const cur = p.marker?.kind ?? null
			if (cur === p.desiredKind) {
				// A fired marker `!` ("reveal now") is consumed by stripping the `!`.
				if (p.showNowFired && p.marker) ops.push({ pos: p.marker.lineIdx, type: 'replace', text: `${p.indent}\t${MARKER[cur!]}` })
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

// --------------------------------------------------------------- runtime state

interface RtEntry {
	starting: boolean
	startedAt: number
	sentAt: number
	// When the in-flight shell command was dispatched; its done-file must be
	// newer than this to count as finished.
	cmdSentAt: number
	prevPromptCount: number
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
function readState(label: string): StateEvent | null {
	const p = join(STATE, `${label}.json`)
	try {
		const event = JSON.parse(readFileSync(p, 'utf8')).event as string
		return { event, mtimeMs: statSync(p).mtimeMs }
	} catch {
		return null
	}
}
const rmState = (label: string) => {
	try {
		unlinkSync(join(STATE, `${label}.json`))
	} catch {}
}
// A finished `$command` writes its exit status to state/<label>.cmd; the
// controller polls this file's mtime to know the command has actually exited.
const cmdDonePath = (label: string) => join(STATE, `${label}.cmd`)
const readCmdDone = (label: string): number | null => {
	try {
		return statSync(cmdDonePath(label)).mtimeMs
	} catch {
		return null
	}
}
const rmCmdDone = (label: string) => {
	try {
		unlinkSync(cmdDonePath(label))
	} catch {}
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

// Each session has two windows: window "claude" (controller-driven) and window
// "shell" (a free shell for the user). We tag the claude pane with a pane-scoped
// user option (@cmder), which — unlike pane titles — the running program
// (fish/claude) can't clobber, and which survives focus changes, non-zero
// base-index, and controller restart. -s searches all windows in the session.
async function claudePane(label: string): Promise<string> {
	const r = await $({
		nothrow: true,
		quiet: true,
	})`tmux list-panes -s -t ${T(label)} -F ${'#{pane_id}\t#{@cmder}\t#{window_name}'}`
	const ids: string[] = []
	let byName: string | null = null
	for (const line of r.stdout.split('\n')) {
		const [id, role, win] = line.split('\t')
		if (!id) continue
		ids.push(id)
		if (role === 'claude') return id
		if (win === 'claude') byName ??= id
	}
	return byName ?? ids[0] ?? T(label) // fall back to the `claude` window, then first pane
}

// The shell pane is the one tagged `@cmder shell` (the session's 2nd window). Fall
// back to the pane in the window still named `shell` — sessions spawned before the
// `@cmder` tag existed (or whose tag was lost) have no tag but keep the window name.
async function shellPane(label: string): Promise<string | null> {
	const r = await $({
		nothrow: true,
		quiet: true,
	})`tmux list-panes -s -t ${T(label)} -F ${'#{pane_id}\t#{@cmder}\t#{window_name}'}`
	let byName: string | null = null
	for (const line of r.stdout.split('\n')) {
		const [id, role, win] = line.split('\t')
		if (!id) continue
		if (role === 'shell') return id
		if (win === 'shell') byName ??= id
	}
	return byName
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
// launch line below is typed into the fish shell before claude starts.
async function sendLine(label: string, text: string, vimInsert = false) {
	log(`${DRY ? '[dry] ' : ''}send ${T(label)}: ${JSON.stringify(text)}`)
	if (DRY) return
	await typeInto(await claudePane(label), text, vimInsert)
}

// Run a `$command` line in the session's shell window. The fish_postexec hook in
// that window writes the command's exit status to its done-file *after* it exits,
// so the controller can tell when the command has actually finished (not just sent).
async function sendCmd(label: string, text: string) {
	log(`${DRY ? '[dry] ' : ''}cmd ${T(label)}: ${JSON.stringify(text)}`)
	if (DRY) return
	const pane = await shellPane(label)
	if (!pane) {
		log(`no shell pane for ${T(label)}, skipping command`)
		return
	}
	// The command's exit status is written to its done-file by the fish_postexec
	// hook in the shell window (see cmder-fish.fish), so we type it verbatim.
	await typeInto(pane, text)
}

async function doSpawn(label: string, dir: string) {
	log(`spawning ${T(label)} in ${dir}`)
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	// CMDER_LABEL/CMDER_STATE are set on the whole session (claude inherits them for
	// its Stop/Notification hook); CMDER_SHELL marks only the shell window, where the
	// fish_postexec hook writes command done-files (see cmder-fish.fish).
	await tm`tmux new-session -d -s ${T(label)} -n claude -c ${dir} -e ${`CMDER_LABEL=${label}`} -e ${`CMDER_STATE=${STATE}`}`
	// Tag the claude pane, then open a second window as a free shell for the user.
	await tm`tmux set-option -p -t ${T(label)} @cmder claude`
	await tm`tmux new-window -t ${T(label)} -n shell -c ${dir} -e CMDER_SHELL=1`
	await tm`tmux set-option -p -t ${T(label)} @cmder shell`
	await sleep(300)
	await sendLine(label, 'claude')
	// Leave the claude window focused so an attach shows it first.
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
// cmder sessions (e.g. WezTerm). Clients parked on your own non-`__` sessions are
// left alone. Run outside tmux there is no "current" client, so we target it by name.
async function showSession(label: string, window?: Window) {
	log(`showing ${T(label)}${window ? ` (${window})` : ''}`)
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	// Reveal the window the caller asked for (e.g. the shell for a `$command` show),
	// so switching the client lands on it rather than the session's last-active window.
	if (window) {
		const pane = window === 'shell' ? await shellPane(label) : await claudePane(label)
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

const atomicWrite = (content: string) => {
	if (DRY) {
		log('[dry] cmder-control would be rewritten')
		return
	}
	const tmp = `${CMDER}.tmp`
	writeFileSync(tmp, content)
	renameSync(tmp, CMDER)
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
export type Window = 'claude' | 'shell'
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
// (no prompts/commands), a fully drained one, or one blocked on a `#` human-action
// barrier has nothing to input, so we don't spawn a tmux session for it — we only
// spawn once there's work to feed it.
export const hasPendingInput = (s: Session): boolean => {
	if (s.prompts.some((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION')) return true
	const next = nearestAbove(s, frontierIdx(s))
	return next !== null && !next.isBarrier
}

// The window used by the last real task before a `show` (the nearest prompt/command
// below it in file order, since the queue drains bottom-to-top). Defaults to the
// claude pane when nothing ran before it.
const lastTaskWindow = (s: Session, showIdx: number): Window => {
	const below = s.prompts
		.filter((p) => p.lineIdx > showIdx && !p.isShow && !p.isBarrier)
		.sort((a, b) => a.lineIdx - b.lineIdx)[0]
	return below?.isCmd ? 'shell' : 'claude'
}

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
export function planQueue(s: Session, rt: RtEntry, io: PlanIO): Dispatch[] {
	const out: Dispatch[] = []
	const promptCount = s.prompts.filter((p) => !p.isCmd && !p.isBarrier && !p.isShow).length
	const hasBarrier = s.prompts.some((p) => p.isBarrier)

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
	// items instantly (they switch the tmux client, then their line is deleted),
	// until we reach a real item to dispatch, a `#` barrier (halt), or the top.
	// `hold` (a just-finished item) keeps the frontier marker if nothing dispatches.
	const drainUp = (cursor: number, hold: Prompt | null) => {
		for (;;) {
			const next = nearestAbove(s, cursor)
			if (next?.isShow) {
				out.push({ type: 'show', window: lastTaskWindow(s, next.lineIdx) })
				next.fired = true
				cursor = next.lineIdx
				continue
			}
			if (next && !next.isBarrier) dispatch(next)
			else if (hold) keepOnly(s, hold) // drained or barrier ahead: hold the frontier
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
	} else if (rt.prevPromptCount >= 1 && promptCount === 0 && !hasBarrier) {
		// Every prompt was deleted: reset the claude conversation.
		out.push({ type: 'clear' })
	} else {
		// Nothing running: dispatch the next pending item above the frontier (the
		// top-most already-run item), or the bottom-most item on a fresh queue.
		drainUp(frontierIdx(s), null)
	}

	// A `#` barrier holds the whole queue, including a pending /clear: keep the
	// prompt count frozen so the clear still fires once the barrier is removed.
	if (!(hasBarrier && promptCount === 0)) rt.prevPromptCount = promptCount
	return out
}

async function tick(rt: Rt) {
	const live = await listTmux()
	const mtimeA = safeMtime(CMDER)
	const content = readFileSync(CMDER, 'utf8')
	const { lines, sessions } = parse(content, loadAliases())
	const modelLabels = new Set(sessions.map((s) => s.label))
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
			rt[label] = { starting: true, startedAt: Date.now(), sentAt: 0, cmdSentAt: 0, prevPromptCount: s.prompts.filter((p) => !p.isCmd && !p.isBarrier && !p.isShow).length }
			actions.push(() => doSpawn(label, dir))
			continue
		}
		// A `!` "show now" header switches the client immediately (even mid-boot — the
		// tmux session exists), independent of the queue; consumed by stripping the `!`.
		if (s.showNow) {
			actions.push(() => showSession(label))
			s.showNowFired = true
		}
		// A `!` appended to an item's marker (e.g. `[NEEDS ATTENTION]!`) reveals that
		// item's window — the shell for a `$command`, the claude pane otherwise.
		for (const p of s.prompts) {
			if (!p.showNow || p.showNowFired) continue
			const window: Window = p.isCmd ? 'shell' : 'claude'
			actions.push(() => showSession(label, window))
			p.showNowFired = true
		}
		// Every session we see live for the first time is un-ready until it clears the
		// grace below. A fresh spawn set this above (with a boot deadline); a reconnect
		// or pre-existing session gets startedAt 0 so the boot grace is already
		// satisfied and only pane-readiness remains — never dispatch straight away.
		rt[label] ??= { starting: true, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: s.prompts.filter((p) => !p.isCmd && !p.isBarrier && !p.isShow).length }
		if (rt[label].starting) {
			if (Date.now() - rt[label].startedAt < READY_MS) continue // let claude boot
			// A session with `$command`s isn't ready until its shell pane physically
			// exists — a command sent to a not-yet-created pane is lost and leaves the
			// item stuck [EXECUTING]. (Skipped in --dry-run, where panes aren't real.)
			if (!DRY && s.prompts.some((p) => p.isCmd) && (await shellPane(label)) === null) continue
			rt[label].starting = false
		}
		if (s.desiredSession && /NO DIR/i.test(s.desiredSession)) s.desiredSession = null
		// Attention is a per-prompt marker now; strip any legacy session-level one.
		clearAttention(s)

		// Capture what an in-flight command's completion would look like *before*
		// planQueue mutates markers/timers, so we can clear its done-file afterwards.
		const cmdSentAtBefore = rt[label].cmdSentAt ?? 0
		const hadActiveCmd = s.prompts.some((p) => p.isCmd && p.desiredKind === 'EXECUTING')
		const cmdDoneMtime = readCmdDone(label)

		const dispatches = planQueue(s, rt[label], { now: Date.now(), state: readState(label), cmdDoneMtime })

		if (hadActiveCmd && cmdDoneMtime !== null && cmdDoneMtime > cmdSentAtBefore) rmCmdDone(label)
		for (const d of dispatches) {
			if (d.type === 'prompt') actions.push(() => sendLine(label, d.text!, true))
			else if (d.type === 'cmd') actions.push(() => sendCmd(label, d.text!))
			else if (d.type === 'clear') actions.push(() => sendLine(label, '/clear', true))
			else if (d.type === 'show') actions.push(() => showSession(label, d.window))
		}
	}

	// A session that stays in the control file (and is live) is a safe place to
	// park a client before we kill the session it's watching.
	const survivor = [...live].find((label) => modelLabels.has(label) || RESERVED.has(label)) ?? null
	for (const label of live) {
		if (modelLabels.has(label) || RESERVED.has(label)) continue
		actions.push(() => doKill(label, survivor))
		rmState(label)
		rmCmdDone(label)
		delete rt[label]
	}

	// If the user edited cmder-control while we computed, defer: skip write AND actions
	// so nothing (e.g. a queued prompt) fires against a stale view.
	if (safeMtime(CMDER) !== mtimeA) {
		log('cmder-control changed mid-tick, deferring')
		return
	}
	const newContent = applyOps(lines, buildOps(sessions)).join('\n')
	if (newContent !== content) atomicWrite(newContent)
	for (const a of actions) await a()
	saveRt(rt)
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
		if (!existsSync(CMDER)) throw new Error(`control file not found: ${CMDER}`)
		if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true })
		const rt = loadRt()
		if (DRY) {
			// One-shot preview: show what a single tick would do, then exit.
			log(`bot-cmder dry-run against ${CMDER}`)
			await tick(rt)
			log('dry-run complete (no changes made)')
			return
		}
		log(`bot-cmder watching ${CMDER}`)
		while (true) {
			await tick(rt)
			await sleep(TICK_MS)
		}
	})
