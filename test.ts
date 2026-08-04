#!/usr/bin/env tsx
import { applyOps, buildOps, parse } from './cmder'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${detail ?? ''}`}`)
	if (!cond) failures++
}

// A self-contained sessions-only layout (independent of the live cmder file's
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

// 7. Blank lines between sessions are skipped but preserved on round-trip.
const withBlanks = 'superapp\n\tprompt: do a thing\n\nsuperapp-2\n\tprompt: do another\n'
const wb = parse(withBlanks)
check('blank-separated sessions both parsed', wb.sessions.length === 2 && wb.sessions.map((s) => s.label).join(',') === 'superapp,superapp-2')
check('blank lines round-trip byte-identical', applyOps(wb.lines, buildOps(wb.sessions)).join('\n') === withBlanks)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
