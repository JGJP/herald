#!/usr/bin/env tsx
import { applyOps, buildOps, frontierWindow, hasPendingInput, mergeSessions, parse, planQueue } from './herald'
import { merge3, nearestIndex, toLines } from './tui'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${detail ?? ''}`}`)
	if (!cond) failures++
}

// A self-contained sessions-only layout (independent of the live herald file's
// current contents). The whole file is sessions now. Tabs are significant.
const example = [
	'superapp',
	'\tbrief description of currently executing task',
	'\t\tprompt: prompt that will automatically run after below is marked done',
	'\t\tprompt: please add feature X, commit the changes, push PR',
	'\t\t\t[EXECUTING]',
	'\t\tprompt: please start working on X',
	'\t\t\t[DONE]',
	'superapp-2',
	'\tbrief description of currently executing task',
	'\t\tprompt: investigate the flaky test',
	'\t\t\t[NEEDS ATTENTION]',
	'superapp-3',
	'\thttps://github.com/link-to-pr',
	'\t\tprompt: /handle-pr-comments',
	'superapp-4',
	'superapp-reviews',
	'core-iac',
	'tmux',
	'fish',
	'',
].join('\n')

// 1. Round-trip: parsing then applying no-op ops must be byte-identical.
const { lines, sessions } = parse(example)
const roundTrip = applyOps(lines, buildOps(sessions)).join('\n')
check('round-trip byte-identical on example', roundTrip === example)

// 2. Structure of the example.
const labels = sessions.map((s) => s.label)
check(
	'parsed session labels',
	JSON.stringify(labels) ===
		JSON.stringify([
			'superapp',
			'superapp-2',
			'superapp-3',
			'superapp-4',
			'superapp-reviews',
			'core-iac',
			'tmux',
			'fish',
		]),
	JSON.stringify(labels),
)
const sa = sessions[0]
check('superapp has 3 prompts', sa.prompts.length === 3, `${sa.prompts.length}`)
check(
	'superapp markers bottom=DONE mid=EXECUTING top=none',
	sa.prompts[0].marker === null &&
		sa.prompts[1].marker?.kind === 'EXECUTING' &&
		sa.prompts[2].marker?.kind === 'DONE',
)
check(
	'superapp-2 attention is a per-prompt marker (not session-level)',
	sessions[1].prompts.length === 1 &&
		sessions[1].prompts[0].marker?.kind === 'ATTENTION' &&
		sessions[1].desiredSession === null,
)
check('superapp-3 has 1 prompt (/handle-pr-comments)', sessions[2].prompts.length === 1 && sessions[2].prompts[0].text === '/handle-pr-comments')

// 3. Marker mutation: set top prompt EXECUTING, mid DONE -> only those lines change.
const m = parse(example)
const s0 = m.sessions[0]
s0.prompts[2].desiredKind = 'DONE' // was DONE, no change
s0.prompts[1].desiredKind = 'DONE' // EXECUTING -> DONE
s0.prompts[0].desiredKind = 'EXECUTING' // none -> insert
const mutated = applyOps(m.lines, buildOps(m.sessions)).join('\n')
check(
	'top prompt gained [EXECUTING] and mid became [DONE]',
	mutated.includes('prompt that will automatically run after below is marked done\n\t\t\t[EXECUTING]') &&
		(mutated.match(/\[DONE\]/g) ?? []).length === 2 &&
		!mutated.includes('[EXECUTING]\n\t\tprompt: please start'),
)

// 4. Attention is a per-prompt marker: promoting it to [DONE] rewrites the
// prompt's own marker in place (no stray session-level line).
const m2 = parse(example)
m2.sessions[1].prompts[0].desiredKind = 'DONE'
const settled = applyOps(m2.lines, buildOps(m2.sessions)).join('\n')
check(
	'attention -> done rewrites the prompt marker in place',
	settled.includes('prompt: investigate the flaky test\n\t\t\t[DONE]') && !settled.includes('[NEEDS ATTENTION]'),
)

// 4b. Clearing the marker (desiredKind -> null) removes just that line.
const m2b = parse(example)
m2b.sessions[1].prompts[0].desiredKind = null
const cleared = applyOps(m2b.lines, buildOps(m2b.sessions)).join('\n')
check('clearing attention removes the marker line', !cleared.includes('[NEEDS ATTENTION]') && cleared.includes('prompt: investigate the flaky test\nsuperapp-3'))

// 4c. A `!` appended to a marker ("reveal this item's window now") parses as an
// ordinary marker plus a one-shot showNow request; unfired it round-trips verbatim,
// and once fired buildOps strips the `!` (leaving the plain marker).
const bangAttn = 'alpha\n\t: fix it\n\t\t[NEEDS ATTENTION]!\n'
const ba = parse(bangAttn)
check('marker `!` parses as its kind + a showNow request', ba.sessions[0].prompts[0].marker?.kind === 'ATTENTION' && ba.sessions[0].prompts[0].showNow === true)
check('an unfired marker `!` round-trips verbatim', applyOps(ba.lines, buildOps(ba.sessions)).join('\n') === bangAttn)
ba.sessions[0].prompts[0].showNowFired = true
check('a fired marker `!` is stripped to the plain marker', applyOps(ba.lines, buildOps(ba.sessions)).join('\n') === 'alpha\n\t: fix it\n\t\t[NEEDS ATTENTION]\n')
// A `!` on a `$command`'s [EXECUTING] marker targets the shell window; on a prompt, claude.
const baCmd = parse('alpha\n\t$ deploy\n\t\t[EXECUTING]!\n')
check('marker `!` on a command keeps the shell as its window', baCmd.sessions[0].prompts[0].isCmd === true && baCmd.sessions[0].prompts[0].showNow === true)

// 4d. A space-separated trailing `!` on the item's own line ("reveal this item's
// window now") sets a one-shot showNow without touching the item's text; unfired it
// round-trips verbatim, and once fired buildOps strips the ` !` from that line.
const inlineP = 'alpha\n\t: look at this !\n'
const ip = parse(inlineP)
check('inline `!` on a prompt sets showNow + strips it from the text', ip.sessions[0].prompts[0].showNow === true && ip.sessions[0].prompts[0].text === 'look at this' && ip.sessions[0].prompts[0].isCmd === false)
check('an unfired inline `!` round-trips verbatim', applyOps(ip.lines, buildOps(ip.sessions)).join('\n') === inlineP)
ip.sessions[0].prompts[0].showNowFired = true
check('a fired inline `!` is stripped from the item line', applyOps(ip.lines, buildOps(ip.sessions)).join('\n') === 'alpha\n\t: look at this\n')
// Firing coexists with a marker inserted the same tick (strip + insert on one line).
ip.sessions[0].prompts[0].desiredKind = 'EXECUTING'
check('a fired inline `!` strips and still gets its marker', applyOps(ip.lines, buildOps(ip.sessions)).join('\n') === 'alpha\n\t: look at this\n\t\t[EXECUTING]\n')
// On a `$command` the reveal targets the shell window, and the command text is clean.
const inlineC = parse('alpha\n\t$ gpo !\n')
check('inline `!` on a command sets showNow, targets shell, keeps clean text', inlineC.sessions[0].prompts[0].isCmd === true && inlineC.sessions[0].prompts[0].showNow === true && inlineC.sessions[0].prompts[0].text === 'gpo')
// Ordinary end punctuation (no separating space) stays text, not a reveal.
const punct = parse('alpha\n\t: ship it!\n')
check('a bare trailing `!` (no space) is text, not a reveal', punct.sessions[0].prompts[0].showNow === undefined && punct.sessions[0].prompts[0].text === 'ship it!')

// 5. Minimal file with a single session.
const single = 'alpha\n\tprompt: do a\n\tprompt: do b\n'
const nb = parse(single)
check('single-session file parses', nb.sessions.length === 1 && nb.sessions[0].prompts.length === 2)
check('single-session round-trips', applyOps(nb.lines, buildOps(nb.sessions)).join('\n') === single)

// 5b. `:` is shorthand for `prompt:` (and round-trips verbatim).
const shorthand = 'alpha\n\t: do a\n\tprompt: do b\n\t:do c\n'
const sh = parse(shorthand)
check(
	'`:` shorthand parses as prompts',
	sh.sessions[0].prompts.length === 3 &&
		sh.sessions[0].prompts.map((p) => p.text).join(',') === 'do a,do b,do c',
	JSON.stringify(sh.sessions[0].prompts.map((p) => p.text)),
)
check('`:` shorthand round-trips', applyOps(sh.lines, buildOps(sh.sessions)).join('\n') === shorthand)

// 5c. `$` command lines parse as one-shot commands (isCmd) separate from prompts.
const cmds = 'alpha\n\tprompt: do a\n\t$git status\n\t$pnpm test\n'
const cm = parse(cmds)
check(
	'`$` lines parse as commands, not prompts',
	cm.sessions[0].prompts.filter((p) => !p.isCmd).length === 1 &&
		cm.sessions[0].prompts.filter((p) => p.isCmd).map((p) => p.text).join(',') === 'git status,pnpm test',
	JSON.stringify(cm.sessions[0].prompts.map((p) => [p.isCmd, p.text])),
)
check('`$` command lines round-trip', applyOps(cm.lines, buildOps(cm.sessions)).join('\n') === cmds)
// A ran command carries a [DONE] marker attached to its own line.
const ran = parse('alpha\n\t$git status\n\t\t[DONE]\n')
check(
	'`$` command [DONE] marker attaches to the command',
	ran.sessions[0].prompts.length === 1 &&
		ran.sessions[0].prompts[0].isCmd &&
		ran.sessions[0].prompts[0].marker?.kind === 'DONE',
)
// An in-flight command carries an [EXECUTING] marker while it runs (gated on its
// done-file before advancing to [DONE]); it round-trips verbatim.
const running = 'alpha\n\t$sleep 5\n\t\t[EXECUTING]\n'
const rn = parse(running)
check(
	'`$` command [EXECUTING] marker attaches to the command',
	rn.sessions[0].prompts[0].isCmd && rn.sessions[0].prompts[0].marker?.kind === 'EXECUTING',
)
check('`$` executing command round-trips', applyOps(rn.lines, buildOps(rn.sessions)).join('\n') === running)

// 5d. planQueue: prompts and commands drain as ONE queue, bottom-to-top, one at a
// time. `drain` simulates ticks, completing whatever is active each tick (a prompt
// via a Stop event, a command via its done-file), round-tripping through the file
// (parse -> plan -> applyOps) exactly like the live loop, and records dispatch order.
const drain = (initial: string, maxTicks = 50) => {
	let content = initial
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: initial.match(/^\t(?:prompt:|:)/gm)?.length ?? 0 }
	let clock = 1000
	const order: string[] = []
	const markerCounts: number[] = []
	for (let i = 0; i < maxTicks; i++) {
		clock += 100
		const { lines, sessions } = parse(content)
		const s = sessions[0]
		const active = s.prompts.find((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION')
		const io = {
			now: clock,
			state: active && !active.isCmd ? { event: 'Stop', mtimeMs: clock } : null,
			cmdDoneMtime: active?.isCmd ? clock : null,
		}
		const disp = planQueue(s, rt, io)
		for (const d of disp) order.push(d.type === 'clear' || d.type === 'show' ? d.type : `${d.type}:${d.text}`)
		content = applyOps(lines, buildOps(sessions)).join('\n')
		markerCounts.push((content.match(/\[(EXECUTING|DONE|NEEDS ATTENTION)\]/g) ?? []).length)
		if (!active && disp.length === 0) break
	}
	return { order, content, markerCounts }
}

// The reported failing case: interleaved commands and prompts must run in file
// order (bottom-to-top), NOT with all commands shoved after all prompts.
const interleaved = drain('bot-cmder\n\t$ label hi2\n\t: say hello\n\t$ label hi\n\t: /c\n')
check(
	'interleaved queue drains in bottom-to-top file order',
	JSON.stringify(interleaved.order) === JSON.stringify(['prompt:/c', 'cmd:label hi', 'prompt:say hello', 'cmd:label hi2']),
	JSON.stringify(interleaved.order),
)
check('interleaved: never more than one marker at a time', interleaved.markerCounts.every((n) => n <= 1), JSON.stringify(interleaved.markerCounts))

// Pure prompts drain bottom-to-top with no re-runs, ending on a single [DONE].
const proms = drain('alpha\n\t: newest\n\t: mid\n\t: old\n')
check('pure prompts drain oldest-first, no re-run', JSON.stringify(proms.order) === JSON.stringify(['prompt:old', 'prompt:mid', 'prompt:newest']), JSON.stringify(proms.order))
check('drained queue keeps exactly one [DONE] on the frontier (newest)', proms.content.includes(': newest\n\t\t[DONE]') && (proms.content.match(/\[DONE\]/g) ?? []).length === 1, JSON.stringify(proms.content))

// Pure commands drain bottom-to-top, one at a time.
const cmds2 = drain('alpha\n\t$a\n\t$b\n\t$c\n')
check('pure commands drain bottom-to-top', JSON.stringify(cmds2.order) === JSON.stringify(['cmd:c', 'cmd:b', 'cmd:a']), JSON.stringify(cmds2.order))

// A command waits for the prompt below it before firing (the core requirement).
const gated = drain('alpha\n\t$git push\n\t: make the change\n')
check('command waits for the prompt below it', JSON.stringify(gated.order) === JSON.stringify(['prompt:make the change', 'cmd:git push']), JSON.stringify(gated.order))

// Attention: a mid-task Notification flags the prompt, a later Stop completes it.
const attn = (() => {
	let content = 'alpha\n\t: fix the bug\n'
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: 1 }
	const step = (io: Parameters<typeof planQueue>[2]) => {
		const { lines, sessions } = parse(content)
		const d = planQueue(sessions[0], rt, io)
		content = applyOps(lines, buildOps(sessions)).join('\n')
		return d
	}
	step({ now: 100, state: null, cmdDoneMtime: null }) // dispatch the prompt
	step({ now: 200, state: { event: 'Notification', mtimeMs: 200 }, cmdDoneMtime: null }) // blocks
	const flagged = content.includes('[NEEDS ATTENTION]')
	step({ now: 300, state: { event: 'Stop', mtimeMs: 300 }, cmdDoneMtime: null }) // answered -> done
	return { flagged, content }
})()
check('notification flags [NEEDS ATTENTION], later stop resolves it', attn.flagged && attn.content.includes('[DONE]') && !attn.content.includes('[NEEDS ATTENTION]'), JSON.stringify(attn))

// Answering a [NEEDS ATTENTION] prompt (a UserPromptSubmit event) flips it back to
// [EXECUTING]; a later Stop then completes it as usual.
const answered = (() => {
	let content = 'alpha\n\t: fix the bug\n'
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: 1 }
	const step = (io: Parameters<typeof planQueue>[2]) => {
		const { lines, sessions } = parse(content)
		planQueue(sessions[0], rt, io)
		content = applyOps(lines, buildOps(sessions)).join('\n')
	}
	step({ now: 100, state: null, cmdDoneMtime: null }) // dispatch
	step({ now: 200, state: { event: 'Notification', mtimeMs: 200 }, cmdDoneMtime: null }) // blocks
	const flagged = content.includes('[NEEDS ATTENTION]')
	step({ now: 300, state: { event: 'UserPromptSubmit', mtimeMs: 300 }, cmdDoneMtime: null }) // answered
	const executing = content.includes('[EXECUTING]') && !content.includes('[NEEDS ATTENTION]')
	step({ now: 400, state: { event: 'Stop', mtimeMs: 400 }, cmdDoneMtime: null }) // finishes
	return { flagged, executing, content }
})()
check('answering [NEEDS ATTENTION] flips it back to [EXECUTING], then Stop -> [DONE]', answered.flagged && answered.executing && answered.content.includes('[DONE]'), JSON.stringify(answered))

// Deleting all prompts emits a /clear (and only then).
const clearTest = (() => {
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: 2 }
	const { sessions } = parse('alpha\n\t$keep me\n')
	return planQueue(sessions[0], rt, { now: 100, state: null, cmdDoneMtime: null })
})()
check('removing all prompts triggers /clear', JSON.stringify(clearTest) === JSON.stringify([{ type: 'clear' }]), JSON.stringify(clearTest))

// 5d-bis. `#` barrier: a human-action line halts the drain until it's removed.
const barrierParse = parse('alpha\n\t: newest\n\t# do a manual step\n\t: old\n')
check(
	'`#` line parses as a barrier (not a prompt/command)',
	barrierParse.sessions[0].prompts.length === 3 &&
		barrierParse.sessions[0].prompts[1].isBarrier === true &&
		barrierParse.sessions[0].prompts[1].text === 'do a manual step',
	JSON.stringify(barrierParse.sessions[0].prompts.map((p) => [p.isBarrier, p.text])),
)
check('`#` barrier round-trips verbatim', applyOps(barrierParse.lines, buildOps(barrierParse.sessions)).join('\n') === 'alpha\n\t: newest\n\t# do a manual step\n\t: old\n')

// The queue drains up to the barrier, then stops: `old` runs, `newest` does not.
const blocked = drain('alpha\n\t: newest\n\t# do a manual step\n\t: old\n')
check('drain stops at the `#` barrier (only items below it run)', JSON.stringify(blocked.order) === JSON.stringify(['prompt:old']), JSON.stringify(blocked.order))
check('barrier leaves the frontier [DONE] below it, never marks the `#` line', blocked.content.includes(': old\n\t\t[DONE]') && blocked.content.includes('# do a manual step') && (blocked.content.match(/\[(EXECUTING|DONE|NEEDS ATTENTION)\]/g) ?? []).length === 1, JSON.stringify(blocked.content))

// Removing the barrier lets the queue continue past it on the next drain.
const unblocked = drain(blocked.content.replace('\t# do a manual step\n', ''))
check('removing the `#` barrier releases the rest of the queue', JSON.stringify(unblocked.order) === JSON.stringify(['prompt:newest']), JSON.stringify(unblocked.order))

// A barrier at the very bottom blocks the whole queue (nothing runs).
const bottomBarrier = drain('alpha\n\t: a\n\t# manual first\n')
check('a bottom `#` barrier blocks the entire queue', JSON.stringify(bottomBarrier.order) === JSON.stringify([]), JSON.stringify(bottomBarrier.order))

// The spawn gate treats a barrier-blocked session as having nothing to input.
check('barrier-only next item is not pending input (no spawn)', !hasPendingInput(parse('alpha\n\t: a\n\t# manual first\n').sessions[0]))
check('a runnable item below a barrier is pending input (spawn)', hasPendingInput(parse('alpha\n\t# manual\n\t: run me\n').sessions[0]))

// A pending /clear (all prompts deleted) is suppressed while a `#` barrier remains,
// then fires once the barrier is removed (the prompt count stays frozen meanwhile).
const clearBarrier = (() => {
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: 2 }
	const held = planQueue(parse('alpha\n\t# manual step\n').sessions[0], rt, { now: 100, state: null, cmdDoneMtime: null })
	const released = planQueue(parse('alpha\n').sessions[0], rt, { now: 200, state: null, cmdDoneMtime: null })
	return { held, released }
})()
check('a `#` barrier suppresses the /clear', JSON.stringify(clearBarrier.held) === JSON.stringify([]), JSON.stringify(clearBarrier.held))
check('the /clear fires once the `#` barrier is removed', JSON.stringify(clearBarrier.released) === JSON.stringify([{ type: 'clear' }]), JSON.stringify(clearBarrier.released))

// 5f. A bare `show` line is a queue item (isShow) that switches the tmux client
// when the drain reaches it. Parsing records it as a non-prompt queue item; it
// round-trips while pending; and once fired buildOps deletes the line (consumed).
const showParse = parse('alpha\n\t: do a\n\tshow\n')
const showItem = showParse.sessions[0].prompts.find((p) => p.isShow)
check('bare `show` parses as an isShow queue item (not a prompt/command)', !!showItem && showParse.sessions[0].prompts.length === 2 && showParse.sessions[0].prompts.filter((p) => !p.isShow).length === 1)
check('an unfired `show` round-trips verbatim', applyOps(showParse.lines, buildOps(showParse.sessions)).join('\n') === 'alpha\n\t: do a\n\tshow\n')
showItem!.fired = true
check('a fired `show` is deleted from the file', applyOps(showParse.lines, buildOps(showParse.sessions)).join('\n') === 'alpha\n\t: do a\n')

// A bare `!` line is shorthand for `show`: same isShow queue item, round-trips
// verbatim while pending, and is deleted once fired.
const bangShow = parse('alpha\n\t: do a\n\t!\n')
const bangShowItem = bangShow.sessions[0].prompts.find((p) => p.isShow)
check('bare `!` parses as a show queue item', !!bangShowItem && bangShow.sessions[0].prompts.length === 2)
check('an unfired `!` show round-trips verbatim', applyOps(bangShow.lines, buildOps(bangShow.sessions)).join('\n') === 'alpha\n\t: do a\n\t!\n')
bangShowItem!.fired = true
check('a fired `!` show is deleted from the file', applyOps(bangShow.lines, buildOps(bangShow.sessions)).join('\n') === 'alpha\n\t: do a\n')

// `show` drains in queue order: it fires only after the item below it is done, and
// before the item above it runs. The `show` line is consumed (deleted) when it fires.
const showQueue = drain('alpha\n\t: after\n\tshow\n\t: before\n')
check('show runs in queue order (below done → show → above)', JSON.stringify(showQueue.order) === JSON.stringify(['prompt:before', 'show', 'prompt:after']), JSON.stringify(showQueue.order))
check('a fired show leaves the file without the show line', !showQueue.content.includes('show') && showQueue.content.includes(': after\n\t\t[DONE]'), JSON.stringify(showQueue.content))
check('show never adds a second marker', showQueue.markerCounts.every((n) => n <= 1), JSON.stringify(showQueue.markerCounts))

// A `show` reveals the window the last task before it used: the shell window when the
// preceding item was a `$command`, the claude window when it was a prompt.
const showWindowOf = (initial: string): string | undefined => {
	let content = initial
	const rt = { starting: false, startedAt: 0, sentAt: 0, cmdSentAt: 0, prevPromptCount: initial.match(/^\t(?:prompt:|:)/gm)?.length ?? 0 }
	let clock = 1000
	for (let i = 0; i < 50; i++) {
		clock += 100
		const { lines, sessions } = parse(content)
		const s = sessions[0]
		const active = s.prompts.find((p) => p.desiredKind === 'EXECUTING' || p.desiredKind === 'ATTENTION')
		const io = { now: clock, state: active && !active.isCmd ? { event: 'Stop', mtimeMs: clock } : null, cmdDoneMtime: active?.isCmd ? clock : null }
		const show = planQueue(s, rt, io).find((d) => d.type === 'show')
		if (show) return show.window
		content = applyOps(lines, buildOps(sessions)).join('\n')
		if (!active && s.prompts.every((p) => p.desiredKind !== 'EXECUTING')) break
	}
	return undefined
}
check('show after a $command reveals the shell window', showWindowOf('alpha\n\tshow\n\t$ deploy\n') === 'shell', showWindowOf('alpha\n\tshow\n\t$ deploy\n'))
check('show after a prompt reveals the claude window', showWindowOf('alpha\n\tshow\n\t: do a thing\n') === 'claude', showWindowOf('alpha\n\tshow\n\t: do a thing\n'))
check('show with nothing before it defaults to the claude window', showWindowOf('alpha\n\tshow\n') === 'claude', String(showWindowOf('alpha\n\tshow\n')))

// A header `!` reveals the frontier item's window: whatever is [EXECUTING] (a command
// -> shell, a prompt -> claude), else the most recently [DONE] one, else nothing.
const fw = (s: string) => frontierWindow(parse(s).sessions[0])
check('frontier window is the executing command\'s shell', fw('alpha!\n\t$ deploy\n\t\t[EXECUTING]\n') === 'shell', String(fw('alpha!\n\t$ deploy\n\t\t[EXECUTING]\n')))
check('frontier window is the executing prompt\'s claude', fw('alpha!\n\t: work\n\t\t[EXECUTING]\n') === 'claude', String(fw('alpha!\n\t: work\n\t\t[EXECUTING]\n')))
check('executing wins over a done item below it', fw('alpha!\n\t: work\n\t\t[EXECUTING]\n\t$ built\n\t\t[DONE]\n') === 'claude', String(fw('alpha!\n\t: work\n\t\t[EXECUTING]\n\t$ built\n\t\t[DONE]\n')))
check('with nothing executing, the last [DONE] wins', fw('alpha!\n\t$ built\n\t\t[DONE]\n') === 'shell', String(fw('alpha!\n\t$ built\n\t\t[DONE]\n')))
check('frontier window is undefined when nothing has run', fw('alpha!\n\t: pending\n') === undefined, String(fw('alpha!\n\t: pending\n')))

// A `show` sitting above a `#` barrier waits: the barrier halts the drain before it.
const showBehindBarrier = drain('alpha\n\tshow\n\t# manual\n\t: first\n')
check('show behind a `#` barrier does not fire', !showBehindBarrier.order.includes('show') && JSON.stringify(showBehindBarrier.order) === JSON.stringify(['prompt:first']), JSON.stringify(showBehindBarrier.order))

// 5e. Spawn gate: only spawn a session once there's something to input. A bare
// header (or a fully drained one) has nothing pending, so it stays unspawned.
check('bare header has no pending input', !hasPendingInput(parse('alpha\n').sessions[0]))
check('header with a fresh prompt has pending input', hasPendingInput(parse('alpha\n\t: do a\n').sessions[0]))
check('header with a fresh command has pending input', hasPendingInput(parse('alpha\n\t$git status\n').sessions[0]))
check('all-done session has no pending input', !hasPendingInput(parse('alpha\n\t: do a\n\t\t[DONE]\n').sessions[0]))
check('an executing session still counts as pending (resume after restart)', hasPendingInput(parse('alpha\n\t: do a\n\t\t[EXECUTING]\n').sessions[0]))
check('a fully drained queue (frontier at top, nulls below) has no pending input', !hasPendingInput(parse('alpha\n\t: newest\n\t\t[DONE]\n\t: old\n').sessions[0]))

// 6. Path-form headers: label = basename, bare names still map by name.
const pathFile = '~/_dev/_startale/superapp\n\tprompt: hi\n/abs/path/foo\nbarename\n'
const pf = parse(pathFile)
check(
	'path header -> basename label',
	pf.sessions[0].label === 'superapp' && pf.sessions[0].dir.endsWith('/_dev/_startale/superapp'),
	`${pf.sessions[0].label} / ${pf.sessions[0].dir}`,
)
check('absolute path header', pf.sessions[1].label === 'foo' && pf.sessions[1].dir === '/abs/path/foo')
check('bare name still maps to ~/_dev/<name>', pf.sessions[2].label === 'barename' && pf.sessions[2].dir.endsWith('/_dev/barename'))

// 6b. An aliased header resolves to the mapped path (label = the alias); a bare
// name that isn't an alias still falls back to ~/_dev/<name>.
const aliased = parse('app\n\tprompt: hi\nbarename\n', { app: '/opt/repos/superapp', other: '~/x' })
check('alias header -> mapped path, label = alias', aliased.sessions[0].label === 'app' && aliased.sessions[0].dir === '/opt/repos/superapp', `${aliased.sessions[0].label} / ${aliased.sessions[0].dir}`)
check('alias `~` expands to home', parse('other\n', { other: '~/x' }).sessions[0].dir.endsWith('/x') && !parse('other\n', { other: '~/x' }).sessions[0].dir.startsWith('~'))
check('non-aliased bare name still maps to ~/_dev/<name>', aliased.sessions[1].dir.endsWith('/_dev/barename'))

// 6c. A `!` suffix on a header means "show it immediately": the label/dir resolve
// from the name without the `!`, and firing the request strips the `!` from the line.
const bang = parse('superapp!\n\t: do a\n')
check('`!` header sets showNow and resolves the name without it', bang.sessions[0].showNow === true && bang.sessions[0].label === 'superapp' && bang.sessions[0].dir.endsWith('/_dev/superapp'))
check('a plain header has showNow false', parse('superapp\n').sessions[0].showNow === false)
check('an unfired `!` header round-trips verbatim', applyOps(bang.lines, buildOps(bang.sessions)).join('\n') === 'superapp!\n\t: do a\n')
bang.sessions[0].showNowFired = true
check('firing a `!` header strips the `!` from the line', applyOps(bang.lines, buildOps(bang.sessions)).join('\n') === 'superapp\n\t: do a\n')
// `!` composes with aliases and paths (resolve the name without the `!`).
check('`!` composes with an alias header', parse('app!\n', { app: '/opt/x' }).sessions[0].showNow === true && parse('app!\n', { app: '/opt/x' }).sessions[0].dir === '/opt/x')
check('`!` composes with a path header', parse('/abs/foo!\n').sessions[0].showNow === true && parse('/abs/foo!\n').sessions[0].dir === '/abs/foo' && parse('/abs/foo!\n').sessions[0].label === 'foo')

// 7. Blank lines between sessions are skipped but preserved on round-trip.
const withBlanks = 'superapp\n\tprompt: do a thing\n\nsuperapp-2\n\tprompt: do another\n'
const wb = parse(withBlanks)
check('blank-separated sessions both parsed', wb.sessions.length === 2 && wb.sessions.map((s) => s.label).join(',') === 'superapp,superapp-2')
check('blank lines round-trip byte-identical', applyOps(wb.lines, buildOps(wb.sessions)).join('\n') === withBlanks)

// 8. `pnpm herald` TUI sync helpers. toLines mirrors nvim's buffer representation
// (a trailing newline is the eol marker, not an extra empty line).
check('toLines drops the trailing-newline eol', JSON.stringify(toLines('a\nb\n')) === JSON.stringify(['a', 'b']))
check('toLines keeps a missing final newline as a real last line', JSON.stringify(toLines('a\nb')) === JSON.stringify(['a', 'b']))

// The core sync guarantee: the controller flips a marker (theirs) while the user is
// editing a prompt on another line (ours). The merge keeps BOTH — the user's edit
// is never lost — and the untouched controller line is picked up.
const base8 = ['superapp', '\t: fix the bug', '\t\t[EXECUTING]', '\t: start X', '\t\t[DONE]']
const ours8 = ['superapp', '\t: fix the login bug now', '\t\t[EXECUTING]', '\t: start X', '\t\t[DONE]'] // user edited a prompt
const theirs8 = ['superapp', '\t: fix the bug', '\t\t[DONE]', '\t: start X', '\t\t[DONE]'] // controller: EXECUTING -> DONE
const merged8 = merge3(ours8, base8, theirs8)
check('merge keeps the user edit and the controller marker change', JSON.stringify(merged8) === JSON.stringify(['superapp', '\t: fix the login bug now', '\t\t[DONE]', '\t: start X', '\t\t[DONE]']), JSON.stringify(merged8))

// On a genuine same-line conflict (both changed the same line), OURS wins so the
// line you're typing is never dropped.
check('same-line conflict keeps ours', JSON.stringify(merge3(['x', 'MINE'], ['x', 'o'], ['x', 'THEIRS'])) === JSON.stringify(['x', 'MINE']), JSON.stringify(merge3(['x', 'MINE'], ['x', 'o'], ['x', 'THEIRS'])))

// nearestIndex keeps the cursor on the same logical line after lines shift.
check('nearestIndex finds the anchor line nearest the old row', nearestIndex(['a', 'x', 'b', 'x', 'c'], 'x', 3) === 3 && nearestIndex(['a', 'x', 'b', 'x', 'c'], 'x', 1) === 1)
check('nearestIndex falls back to a clamped row when absent', nearestIndex(['a', 'b'], 'zzz', 9) === 1)

// 9. Multi-file merge: every `.herald` file's sessions combine into one control. A
// label claimed by an earlier file wins; a later file's duplicate is annotated and
// dropped from the driven set, but its own file still rewrites it in place.
const fileA = parse('alpha\n\t: work on alpha\nshared\n\t: from A\n')
const fileB = parse('shared\n\t: from B\nbeta\n\t: work on beta\n')
const merged = mergeSessions([fileA.sessions, fileB.sessions])
check('merge unions distinct sessions across files', [...merged.labels].sort().join(',') === 'alpha,beta,shared')
check('merge drives one session per label (dup dropped)', merged.sessions.map((s) => s.label).join(',') === 'alpha,shared,beta')
check("merge annotates the later file's duplicate", fileB.sessions[0].label === 'shared' && fileB.sessions[0].desiredSession === '[DUPLICATE]')
check("merge leaves the winning file's session unannotated", fileA.sessions.find((s) => s.label === 'shared')!.desiredSession === null)
// The dropped duplicate's own file writes the [DUPLICATE] marker back under its header.
check('duplicate marker is written back into its file', applyOps(fileB.lines, buildOps(fileB.sessions)).join('\n') === 'shared\n\t: from B\n\t[DUPLICATE]\nbeta\n\t: work on beta\n')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
