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
const CMDER = process.env.CMDER_FILE ? resolve(process.env.CMDER_FILE) : join(HERE, 'cmder')
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

type Kind = 'EXECUTING' | 'DONE'
interface Prompt {
	text: string
	lineIdx: number
	indent: string
	marker: { kind: Kind; lineIdx: number } | null
	desiredKind: Kind | null
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
		if (/^prompt:/i.test(t)) {
			cur.prompts.push({
				text: t.replace(/^prompt:\s*/i, ''),
				lineIdx: i,
				indent: tabs,
				marker: null,
				desiredKind: null,
			})
		} else if (/^\[.*\]$/.test(t)) {
			const kind: Kind | null = /executing/i.test(t)
				? 'EXECUTING'
				: /done/i.test(t)
					? 'DONE'
					: null
			// EXECUTING/DONE attach to the nearest preceding prompt without a
			// marker; anything else (incl. NEEDS ATTENTION) is a session marker.
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
				else ops.push({ pos: p.marker.lineIdx, type: 'replace', text: `${p.indent}\t[${p.desiredKind}]` })
			} else if (p.desiredKind !== null) {
				ops.push({ pos: p.lineIdx, type: 'insert', text: `${p.indent}\t[${p.desiredKind}]` })
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
const safeMtime = (p: string): number => {
	try {
		return statSync(p).mtimeMs
	} catch {
		return -1
	}
}

// ------------------------------------------------------------------ tmux glue

const T = (label: string) => `cmder-${label}`
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`

async function listTmux(): Promise<Set<string>> {
	const r = await $({ nothrow: true, quiet: true })`tmux list-sessions -F '#{session_name}'`
	const out = new Set<string>()
	for (const line of r.stdout.split('\n')) {
		const n = line.trim()
		if (n.startsWith('cmder-')) out.add(n.slice('cmder-'.length))
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

async function sendLine(label: string, text: string) {
	if (DRY) {
		log(`[dry] send ${T(label)}: ${JSON.stringify(text)}`)
		return
	}
	const pane = await claudePane(label)
	await $({ nothrow: true, quiet: true })`tmux send-keys -t ${pane} -l -- ${text}`
	await sleep(120)
	await $({ nothrow: true, quiet: true })`tmux send-keys -t ${pane} Enter`
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
		log('[dry] cmder would be rewritten')
		return
	}
	const tmp = `${CMDER}.tmp`
	writeFileSync(tmp, content)
	renameSync(tmp, CMDER)
}

// -------------------------------------------------------------- reconcile tick

// Bottom-most pending prompt runs first (queue drains bottom-to-top).
const pickNext = (s: Session): Prompt | null => {
	const pending = s.prompts.filter((p) => p.desiredKind === null)
	return pending.length ? pending.reduce((a, b) => (b.lineIdx > a.lineIdx ? b : a)) : null
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
			rt[label] = { starting: true, startedAt: Date.now(), sentAt: 0, prevPromptCount: s.prompts.length }
			actions.push(() => doSpawn(label, dir))
			continue
		}
		if (rt[label]?.starting) {
			if (Date.now() - rt[label].startedAt < READY_MS) continue
			rt[label].starting = false
		}
		if (s.desiredSession && /NO DIR/i.test(s.desiredSession)) s.desiredSession = null
		rt[label] ??= { starting: false, startedAt: 0, sentAt: 0, prevPromptCount: s.prompts.length }

		const st = readState(label)
		const promptCount = s.prompts.length
		const prev = rt[label].prevPromptCount
		const exec = s.prompts.find((p) => p.desiredKind === 'EXECUTING')

		if (exec) {
			if (st && st.event === 'Stop' && st.mtimeMs > rt[label].sentAt) {
				exec.desiredKind = 'DONE'
				clearAttention(s)
				const next = pickNext(s)
				if (next) {
					next.desiredKind = 'EXECUTING'
					rt[label].sentAt = Date.now()
					actions.push(() => sendLine(label, next.text))
				}
			}
		} else if (prev >= 1 && promptCount === 0) {
			clearAttention(s)
			actions.push(() => sendLine(label, '/clear'))
		} else {
			const next = pickNext(s)
			if (next) {
				next.desiredKind = 'EXECUTING'
				rt[label].sentAt = Date.now()
				clearAttention(s)
				actions.push(() => sendLine(label, next.text))
			} else if (st && st.event === 'Notification') {
				s.desiredSession = '[NEEDS ATTENTION]'
			} else {
				clearAttention(s)
			}
		}
		rt[label].prevPromptCount = promptCount
	}

	for (const label of live) {
		if (modelLabels.has(label) || RESERVED.has(label)) continue
		actions.push(() => doKill(label))
		rmState(label)
		delete rt[label]
	}

	// If the user edited cmder while we computed, defer: skip write AND actions
	// so nothing (e.g. a queued prompt) fires against a stale view.
	if (safeMtime(CMDER) !== mtimeA) {
		log('cmder changed mid-tick, deferring')
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
