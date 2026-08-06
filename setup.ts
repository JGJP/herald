#!/usr/bin/env tsx
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fire } from '@jgjp/fire'

const here = dirname(fileURLToPath(import.meta.url))
const hookPath = resolve(here, 'herald-hook')
const fishHookPath = resolve(here, 'herald-fish.fish')
const fishConfDir = resolve(homedir(), '.config', 'fish', 'conf.d')
const fishLinkPath = resolve(fishConfDir, 'herald.fish')
const bashHookPath = resolve(here, 'herald-bash.sh')
const bashrcPath = resolve(homedir(), '.bashrc')
const zshHookPath = resolve(here, 'herald-zsh.sh')
const zshrcPath = resolve(homedir(), '.zshrc')
const settingsPath = resolve(homedir(), '.claude', 'settings.json')

// Symlink the fish_postexec hook into fish's conf.d (fish auto-loads it). Repo
// file stays the source of truth.
function installFishHook() {
	if (!existsSync(fishConfDir)) {
		console.log(`fish: conf.d not found (${fishConfDir}); skipping`)
		return
	}
	const entry = lstatSync(fishLinkPath, { throwIfNoEntry: false })
	if (entry?.isSymbolicLink() && readlinkSync(fishLinkPath) === fishHookPath) {
		console.log(`fish: hook already linked (${fishLinkPath})`)
		return
	}
	if (entry) unlinkSync(fishLinkPath)
	symlinkSync(fishHookPath, fishLinkPath)
	console.log(`fish: linked hook ${fishLinkPath} -> ${fishHookPath}`)
}

// Idempotently source a shell hook from its rc file. Skips a shell whose rc file
// doesn't exist (not set up on this machine) and backs the rc up once before editing.
function installRcHook(shell: string, rcPath: string, shellHookPath: string) {
	if (!existsSync(rcPath)) {
		console.log(`${shell}: ${rcPath} not found; skipping`)
		return
	}
	const existing = readFileSync(rcPath, 'utf8')
	if (existing.includes(shellHookPath)) {
		console.log(`${shell}: hook already sourced in ${rcPath}`)
		return
	}
	const backup = `${rcPath}.herald-bak`
	if (!existsSync(backup)) writeFileSync(backup, existing)
	const sep = existing.length && !existing.endsWith('\n') ? '\n' : ''
	appendFileSync(rcPath, `${sep}\n# herald command-completion hook\nsource "${shellHookPath}"\n`)
	console.log(`${shell}: sourced hook in ${rcPath}`)
}

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

	// 1b. Install a command-completion hook for each shell so the session's shell
	//     window reports when a `$command` has exited (see herald-<shell>.*). Each
	//     hook self-guards on HERALD_SHELL, so only the shell actually running the
	//     window activates it — no need to know that shell in advance. Shells whose
	//     config isn't present are skipped.
	installFishHook()
	installRcHook('bash', bashrcPath, bashHookPath)
	installRcHook('zsh', zshrcPath, zshHookPath)

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
