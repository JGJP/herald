#!/usr/bin/env tsx
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fire } from '@jgjp/fire'

const here = dirname(fileURLToPath(import.meta.url))
const hookPath = resolve(here, 'herald-hook')
const fishHookPath = resolve(here, 'herald-fish.fish')
const fishConfDir = resolve(homedir(), '.config', 'fish', 'conf.d')
const fishLinkPath = resolve(fishConfDir, 'herald.fish')
const settingsPath = resolve(homedir(), '.claude', 'settings.json')

// A single hook entry in Claude Code's settings.json shape.
type HookEntry = { hooks: { type: string; command: string }[] }

// Returns true if any command in the event's entries already invokes our hook.
const alreadyInstalled = (entries: HookEntry[] | undefined): boolean =>
	(entries ?? []).some((e) => e.hooks?.some((h) => h.command.includes('herald-hook')))

void fire(async () => {
	// 1. Make the hook executable and ensure the state dir exists.
	chmodSync(hookPath, 0o755)
	const stateDir = resolve(here, 'state')
	if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
	console.log(`hook is executable: ${hookPath}`)
	console.log(`state dir ready: ${stateDir}`)

	// 1b. Symlink the fish_postexec hook into fish's conf.d so command completion is
	//     reported by fish itself (see herald-fish.fish). Repo file stays the source.
	if (existsSync(fishConfDir)) {
		const entry = lstatSync(fishLinkPath, { throwIfNoEntry: false })
		if (entry?.isSymbolicLink() && readlinkSync(fishLinkPath) === fishHookPath) {
			console.log(`fish hook already linked: ${fishLinkPath}`)
		} else {
			if (entry) unlinkSync(fishLinkPath)
			symlinkSync(fishHookPath, fishLinkPath)
			console.log(`linked fish hook: ${fishLinkPath} -> ${fishHookPath}`)
		}
	} else {
		console.log(`fish conf.d not found (${fishConfDir}); skipping fish hook`)
	}

	// 2. Merge Stop + Notification + UserPromptSubmit hooks into global settings.json
	//    without clobbering existing hooks. UserPromptSubmit lets the controller flip
	//    a [NEEDS ATTENTION] prompt back to [EXECUTING] once the user answers it.
	if (!existsSync(settingsPath)) {
		throw new Error(`settings.json not found at ${settingsPath}`)
	}
	const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
		hooks?: Record<string, HookEntry[]>
	}
	settings.hooks ??= {}

	let changed = false
	for (const event of ['Stop', 'Notification', 'UserPromptSubmit'] as const) {
		settings.hooks[event] ??= []
		if (alreadyInstalled(settings.hooks[event])) {
			console.log(`${event}: herald-hook already installed, skipping`)
			continue
		}
		settings.hooks[event].push({
			hooks: [{ type: 'command', command: `${hookPath} ${event}` }],
		})
		console.log(`${event}: added herald-hook`)
		changed = true
	}

	if (changed) {
		// Back up once before the first modification.
		const backup = `${settingsPath}.herald-bak`
		if (!existsSync(backup)) writeFileSync(backup, readFileSync(settingsPath))
		writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
		console.log(`updated ${settingsPath} (backup at ${backup})`)
	} else {
		console.log('settings.json already up to date')
	}
})
