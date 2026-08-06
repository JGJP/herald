#!/usr/bin/env tsx
// `pnpm herald` — edit herald-control in real Neovim while the supervisor keeps
// writing to the same file. nvim owns the terminal (real vim, your own config);
// this process is a sidecar that connects over nvim's RPC socket and folds the
// controller's out-of-band writes (marker updates, drained lines) into the buffer
// without disturbing what you're typing.
//
// How the sync stays non-destructive:
//   - It only acts while you're in NORMAL mode (never mid-insert/visual/command),
//     so keystrokes are never lost — pending changes apply the moment you hit Esc.
//   - If the buffer has no unsaved edits, it's a clean `:checktime` reload (nvim
//     keeps your cursor).
//   - If you *do* have unsaved edits, it 3-way merges the controller's change into
//     your buffer (your lines win on conflict) and restores the cursor to the line
//     you were on.
// On `:w`, nvim writes the file itself, so the display and file are in sync.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attach } from 'neovim'
import { diff3Merge } from 'node-diff3'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = process.env.HERALD_FILE ? resolve(process.env.HERALD_FILE) : join(HERE, 'herald-control')
const SOCK = join(tmpdir(), `herald-nvim-${process.pid}.sock`)
const POLL_MS = 300

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Split file content into buffer lines the way nvim does: a trailing newline is
// the end-of-file marker, not an extra empty line.
export const toLines = (content: string): string[] => (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n')
export const eq = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

// Resolve a diff3 conflict span (which groups adjacent changes from both sides).
// When ours and theirs touched *different* lines of the same span (the common case:
// you edit a prompt while the controller flips the marker below it) both edits are
// kept. On a genuine same-line clash — or an uneven insert/delete on both sides —
// OURS wins so the line you're typing is never dropped (the controller re-derives
// markers each tick, so a marker lost this way is simply re-applied next tick).
function resolveConflict(a: string[], o: string[], b: string[]): string[] {
	if (eq(a, o)) return b // ours untouched here → take theirs
	if (eq(b, o)) return a // theirs untouched here → take ours
	if (a.length === o.length && b.length === o.length) {
		return o.map((base, i) => (a[i] !== base ? a[i] : b[i])) // per-line: whoever changed it
	}
	return a
}

// 3-way line merge of the buffer (ours) and disk (theirs) against their last-agreed
// base, resolving conflicts with resolveConflict above.
export function merge3(ours: string[], base: string[], theirs: string[]): string[] {
	const out: string[] = []
	for (const r of diff3Merge(ours, base, theirs, { excludeFalseConflicts: true })) {
		if ('ok' in r) out.push(...r.ok)
		else out.push(...resolveConflict(r.conflict.a, r.conflict.o, r.conflict.b))
	}
	return out
}

// Index of `value` in `lines` nearest to `near` (used to keep the cursor on the
// same logical line after a merge shifts line numbers).
export function nearestIndex(lines: string[], value: string, near: number): number {
	let best = -1
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === value && (best === -1 || Math.abs(i - near) < Math.abs(best - near))) best = i
	}
	return best === -1 ? Math.min(near, lines.length - 1) : best
}

async function main() {
	if (!existsSync(FILE)) {
		console.error(`control file not found: ${FILE}`)
		process.exit(1)
	}
	try {
		unlinkSync(SOCK)
	} catch {}

	const nvimChild = spawn('nvim', ['--listen', SOCK, FILE], { stdio: 'inherit' })
	nvimChild.on('error', (e) => {
		console.error(`failed to launch nvim: ${e.message}`)
		process.exit(1)
	})
	const cleanup = () => {
		try {
			unlinkSync(SOCK)
		} catch {}
	}
	nvimChild.on('exit', () => {
		cleanup()
		process.exit(0)
	})

	// Wait for nvim's RPC socket, then attach as a client (nvim keeps its own UI).
	for (let i = 0; i < 100 && !existsSync(SOCK); i++) await sleep(50)
	if (!existsSync(SOCK)) process.exit(1)
	const nvim = attach({ socket: SOCK })
	await nvim.command('set autoread')

	// The buffer holding our file (guard against the user opening others).
	let buf = await nvim.buffer
	for (const b of await nvim.buffers) {
		if ((await b.name) === FILE) {
			buf = b
			break
		}
	}

	let base = toLines(readFileSync(FILE, 'utf8')) // last content we and disk agreed on
	let busy = false

	async function sync() {
		if (busy) return
		let disk: string[]
		try {
			disk = toLines(readFileSync(FILE, 'utf8'))
		} catch {
			return
		}
		if (eq(disk, base)) return // no external write since we last synced

		const m = await nvim.mode
		// Only touch the buffer while idle in normal mode — never mid-keystroke.
		if (m.blocking || !m.mode.startsWith('n')) return

		busy = true
		try {
			const modified = (await nvim.eval('&modified')) === 1
			if (!modified) {
				await nvim.command('checktime') // clean reload; nvim keeps the cursor
			} else {
				const ours = await buf.lines
				const merged = merge3(ours, base, disk)
				if (!eq(merged, ours)) {
					const onOurBuffer = (await nvim.buffer).id === buf.id
					const [row, col] = onOurBuffer ? await nvim.window.cursor : [1, 0]
					const anchor = ours[row - 1] ?? ''
					await buf.setLines(merged, { start: 0, end: -1, strictIndexing: false })
					if (onOurBuffer) {
						const newRow = Math.max(1, Math.min(nearestIndex(merged, anchor, row - 1) + 1, merged.length))
						// vimscript cursor() is 1-based on both axes; the getter's col is 0-based.
						await nvim.call('cursor', [newRow, col + 1])
					}
				}
			}
			base = disk
		} catch {
			// nvim may have exited or be momentarily busy; retry next tick.
		} finally {
			busy = false
		}
	}

	const timer = setInterval(() => void sync(), POLL_MS)
	nvimChild.on('exit', () => clearInterval(timer))
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

if (isMain) void main()
