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
import { $, sleep } from 'zx'

const HERE = dirname(fileURLToPath(import.meta.url))
const CMDER = process.env.CMDER_FILE ? resolve(process.env.CMDER_FILE) : join(HERE, 'cmder-control')
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

// A session header is either a bare name (dir = ~/_dev/<name>, label = name) or
// a path anywhere (dir = the path, label = its basename / tmux session name).
function resolveTarget(header: string): { label: string; dir: string } {
	if (header.startsWith('/') || header.startsWith('~') || header.includes('/')) {
		const dir = resolve(expandHome(header))
		return { label: basename(dir), dir }
	}
	return { label: header, dir: join(DEV_DIR, header) }
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
	// A `!command` line: runs once in the session's shell window, then is marked
	// [DONE] like a finished prompt. It never enters the claude prompt queue.
	isCmd: boolean
}
interface Session {
	label: string
	dir: string
	headerIdx: number
	lastChildIdx: number
	prompts: Prompt[]
	sessionMarker: { text: string; lineIdx: number } | null
	desiredSession: string | null
}

// A prompt line starts with `prompt:` or the shorthand `:`.
const PROMPT_RE = /^(?:prompt:|:)\s*/i
// A command line starts with `!`; the command runs in the shell window.
const CMD_RE = /^!\s*/
const isAttention = (x: string | null): boolean => !!x && /NEEDS ATTENTION/i.test(x)
const clearAttention = (s: Session) => {
	if (isAttention(s.desiredSession)) s.desiredSession = null
}

export function parse(content: string): { lines: string[]; sessions: Session[] } {
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
			const { label, dir } = resolveTarget(line.trim())
			cur = {
				label,
				dir,
				headerIdx: i,
				lastChildIdx: i,
				prompts: [],
				sessionMarker: null,
				desiredSession: null,
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
			})
		} else if (CMD_RE.test(t)) {
			cur.prompts.push({
				text: t.replace(CMD_RE, ''),
				lineIdx: i,
				indent: tabs,
				marker: null,
				desiredKind: null,
				isCmd: true,
			})
		} else if (/^\[.*\]$/.test(t)) {
			const kind: Kind | null = /executing/i.test(t)
				? 'EXECUTING'
				: /attention/i.test(t)
					? 'ATTENTION'
					: /done/i.test(t)
						? 'DONE'
						: null
			// A status marker attaches to the nearest preceding prompt without a
			// marker; anything unrecognised (e.g. [NO DIR …]) is a session marker.
			const target = kind ? [...cur.prompts].reverse().find((p) => !p.marker) : undefined
			if (kind && target) {
				target.marker = { kind, lineIdx: i }
				target.desiredKind = kind
			} else {
				cur.sessionMarker = { text: t, lineIdx: i }
				cur.desiredSession = t
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
			const cur = p.marker?.kind ?? null
			if (cur === p.desiredKind) continue
			if (p.marker) {
				if (p.desiredKind === null) ops.push({ pos: p.marker.lineIdx, type: 'delete' })
				else ops.push({ pos: p.marker.lineIdx, type: 'replace', text: `${p.indent}\t${MARKER[p.desiredKind]}` })
			} else if (p.desiredKind !== null) {
				ops.push({ pos: p.lineIdx, type: 'insert', text: `${p.indent}\t${MARKER[p.desiredKind]}` })
			}
		}
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
// A finished `!command` writes its exit status to state/<label>.cmd; the
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
	})`tmux list-panes -s -t ${T(label)} -F ${'#{pane_id}\t#{@cmder}'}`
	const ids: string[] = []
	for (const line of r.stdout.split('\n')) {
		const [id, role] = line.split('\t')
		if (!id) continue
		ids.push(id)
		if (role === 'claude') return id
	}
	return ids[0] ?? T(label) // fallback: first pane (claude window is created first)
}

// The shell pane is the one tagged `@cmder shell` (the session's 2nd window).
async function shellPane(label: string): Promise<string | null> {
	const r = await $({
		nothrow: true,
		quiet: true,
	})`tmux list-panes -s -t ${T(label)} -F ${'#{pane_id}\t#{@cmder}'}`
	for (const line of r.stdout.split('\n')) {
		const [id, role] = line.split('\t')
		if (role === 'shell') return id
	}
	return null
}

async function typeInto(pane: string, text: string) {
	await $({ nothrow: true, quiet: true })`tmux send-keys -t ${pane} -l -- ${text}`
	await sleep(120)
	await $({ nothrow: true, quiet: true })`tmux send-keys -t ${pane} Enter`
}

async function sendLine(label: string, text: string) {
	if (DRY) {
		log(`[dry] send ${T(label)}: ${JSON.stringify(text)}`)
		return
	}
	await typeInto(await claudePane(label), text)
}

// Run a `!command` line in the session's shell window. We append a sentinel that
// writes the command's exit status to its done-file *after* it exits, so the
// controller can tell when the command has actually finished (not just been sent).
async function sendCmd(label: string, text: string) {
	if (DRY) {
		log(`[dry] cmd ${T(label)}: ${JSON.stringify(text)}`)
		return
	}
	const pane = await shellPane(label)
	if (!pane) {
		log(`no shell pane for ${T(label)}, skipping command`)
		return
	}
	await typeInto(pane, `${text}; echo $status > ${q(cmdDonePath(label))}`)
}

async function doSpawn(label: string, dir: string) {
	log(`spawning ${T(label)} in ${dir}`)
	if (DRY) return
	const tm = $({ nothrow: true, quiet: true })
	await tm`tmux new-session -d -s ${T(label)} -n claude -c ${dir}`
	// Tag the claude pane, then open a second window as a free shell for the user.
	await tm`tmux set-option -p -t ${T(label)} @cmder claude`
	await tm`tmux new-window -t ${T(label)} -n shell -c ${dir}`
	await tm`tmux set-option -p -t ${T(label)} @cmder shell`
	await sleep(300)
	await sendLine(label, `set -x CMDER_LABEL ${q(label)}; set -x CMDER_STATE ${q(STATE)}; claude`)
	// Leave the claude window focused so an attach shows it first.
	await tm`tmux select-window -t ${await claudePane(label)}`
}

async function doKill(label: string) {
	log(`killing ${T(label)}`)
	if (DRY) return
	await $({ nothrow: true, quiet: true })`tmux kill-session -t ${T(label)}`
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

// Bottom-most pending item runs first (queue drains bottom-to-top). Prompts and
// commands are separate queues (selected by the `cmd` flag), but a command only
// fires once no prompt is active — see the command block in tick().
const pickPending = (s: Session, cmd = false): Prompt | null => {
	const pending = s.prompts.filter((p) => p.isCmd === cmd && p.desiredKind === null)
	return pending.length ? pending.reduce((a, b) => (b.lineIdx > a.lineIdx ? b : a)) : null
}

// Only the current task keeps a marker: when one is (re)marked, strip the
// [EXECUTING]/[DONE] markers the earlier (already-processed) tasks left behind.
export const clearOtherTaskMarkers = (s: Session, keep: Prompt) => {
	for (const p of s.prompts) {
		if (p === keep || p.isCmd) continue
		if (p.desiredKind === 'EXECUTING' || p.desiredKind === 'DONE') p.desiredKind = null
	}
}

async function tick(rt: Rt) {
	const live = await listTmux()
	const mtimeA = safeMtime(CMDER)
	const content = readFileSync(CMDER, 'utf8')
	const { lines, sessions } = parse(content)
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
			rt[label] = { starting: true, startedAt: Date.now(), sentAt: 0, cmdSentAt: 0, prevPromptCount: s.prompts.filter((p) => !p.isCmd).length }
			actions.push(() => doSpawn(label, dir))
			continue
		}
		if (rt[label]?.starting) {
			if (Date.now() - rt[label].startedAt < READY_MS) continue
			rt[label].starting = false
		}
		if (s.desiredSession && /NO DIR/i.test(s.desiredSession)) s.desiredSession = null
		// Attention is a per-prompt marker now; strip any legacy session-level one.
		clearAttention(s)

		const promptCount = s.prompts.filter((p) => !p.isCmd).length
		rt[label] ??= { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: promptCount }

		const st = readState(label)
		const prev = rt[label].prevPromptCount
		// EXECUTING and ATTENTION are both "the currently active prompt".
		const exec = s.prompts.find((p) => !p.isCmd && (p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION'))

		if (exec) {
			if (st && st.event === 'Stop' && st.mtimeMs > rt[label].sentAt) {
				exec.desiredKind = 'DONE'
				const next = pickPending(s)
				if (next) {
					next.desiredKind = 'EXECUTING'
					rt[label].sentAt = Date.now()
					actions.push(() => sendLine(label, next.text))
				}
				// Keep a marker only on the current task (the new EXECUTING one, or the
				// just-finished DONE when the queue is drained); clear the earlier ones.
				clearOtherTaskMarkers(s, next ?? exec)
			} else if (st && st.event === 'Notification' && st.mtimeMs > rt[label].sentAt) {
				// Claude is blocked waiting for input mid-task: flag this prompt.
				exec.desiredKind = 'ATTENTION'
			}
		} else if (prev >= 1 && promptCount === 0) {
			actions.push(() => sendLine(label, '/clear'))
		} else {
			const next = pickPending(s)
			if (next) {
				next.desiredKind = 'EXECUTING'
				rt[label].sentAt = Date.now()
				actions.push(() => sendLine(label, next.text))
				clearOtherTaskMarkers(s, next)
			}
		}
		rt[label].prevPromptCount = promptCount

		// Shell commands run in the shell window (2nd window), one at a time and
		// only once the previous item — prompt or command — has finished. A command
		// stays [EXECUTING] until its done-file (written when it exits) is newer than
		// its dispatch; only then does it become [DONE]. We dispatch the next pending
		// command only when nothing else in this session is running: no command is
		// [EXECUTING] and no prompt is active (this tick's prompt dispatch is already
		// reflected above), so a `!command` never races an in-flight prompt/command.
		const dispatchCmd = (c: Prompt) => {
			c.desiredKind = 'EXECUTING'
			rt[label].cmdSentAt = Date.now()
			actions.push(() => sendCmd(label, c.text))
		}
		const execCmd = s.prompts.find((p) => p.isCmd && p.desiredKind === 'EXECUTING')
		if (execCmd) {
			const done = readCmdDone(label)
			if (done !== null && done > (rt[label].cmdSentAt ?? 0)) {
				execCmd.desiredKind = 'DONE'
				rmCmdDone(label)
			}
		}
		const promptActive = s.prompts.some((p) => !p.isCmd && (p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION'))
		const cmdRunning = s.prompts.some((p) => p.isCmd && p.desiredKind === 'EXECUTING')
		if (!promptActive && !cmdRunning) {
			const nextCmd = pickPending(s, true)
			if (nextCmd) dispatchCmd(nextCmd)
		}
	}

	for (const label of live) {
		if (modelLabels.has(label) || RESERVED.has(label)) continue
		actions.push(() => doKill(label))
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
