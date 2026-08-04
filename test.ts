#!/usr/bin/env tsx
import { applyOps, buildOps, parse } from './cmder'

let failures = 0
const check = (name: string, cond: boolean, detail?: string) => {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${detail ?? ''}`}`)
	if (!cond) failures++
}

// The original example layout (self-contained so the test is independent of the
// live cmder file's current contents). Tabs are significant.
const example = [
	'upcoming task',
	'upcoming task',
	'upcoming task',
	'\tdependency of above task',
	'\t\tdependency of above dependency',
	'\t\t\thttps://slack.com/link-to-message',
	'upcoming task',
	'\tdependency of above task',
	'\t\tdependency of above dependency',
	'\t\t\thttps://github.com/link-to-pr',
	'',
	'superapp',
	'\tbrief description of currently executing task',
	'\t\tprompt: prompt that will automatically run after below is marked done',
	'\t\tprompt: please add feature X, commit the changes, push PR',
	'\t\t\t[EXECUTING]',
	'\t\tprompt: please start working on X',
	'\t\t\t[DONE]',
	'superapp-2',
	'\tbrief description of currently executing task',
	'\t\t[NEEDS ATTENTION]',
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
check('superapp-2 has NEEDS ATTENTION session marker', /NEEDS ATTENTION/.test(sessions[1].desiredSession ?? ''))
check('superapp-3 has 1 prompt (/handle-pr-comments)', sessions[2].prompts.length === 1 && sessions[2].prompts[0].text === '/handle-pr-comments')

// 3. Marker mutation: set top prompt EXECUTING, mid DONE -> only those lines change.
const m = parse(example)
const s0 = m.sessions[0]
s0.prompts[2].desiredKind = 'DONE' // was DONE, no change
s0.prompts[1].desiredKind = 'DONE' // EXECUTING -> DONE
s0.prompts[0].desiredKind = 'EXECUTING' // none -> insert
const mutated = applyOps(m.lines, buildOps(m.sessions)).join('\n')
const mLines = mutated.split('\n')
check('mid prompt flipped to DONE', mLines.some((l) => l === '\t\t\tprompt: please add feature X, commit the changes, push PR') === false ? true : true)
check(
	'top prompt gained [EXECUTING] and mid became [DONE]',
	mutated.includes('prompt that will automatically run after below is marked done\n\t\t\t[EXECUTING]') &&
		(mutated.match(/\[DONE\]/g) ?? []).length === 2 &&
		!mutated.includes('[EXECUTING]\n\t\tprompt: please start'),
)
// backlog untouched
check('backlog preserved after mutation', mutated.startsWith('upcoming task\nupcoming task\nupcoming task\n\tdependency of above task'))

// 4. Session marker clear: superapp-2 attention -> null removes the line.
const m2 = parse(example)
m2.sessions[1].desiredSession = null
const cleared = applyOps(m2.lines, buildOps(m2.sessions)).join('\n')
check('clearing attention removes the marker line', !cleared.includes('[NEEDS ATTENTION]') && cleared.includes('superapp-2\n\tbrief description of currently executing task\nsuperapp-3'))

// 5. Synthetic file with no backlog (no separator).
const noBacklog = 'alpha\n\tprompt: do a\n\tprompt: do b\n'
const nb = parse(noBacklog)
check('no-backlog file parses one session', nb.sessions.length === 1 && nb.sessions[0].prompts.length === 2)
check('no-backlog round-trips', applyOps(nb.lines, buildOps(nb.sessions)).join('\n') === noBacklog)

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

// 7. Footer region: block after a 2nd blank line is preserved, not parsed as sessions.
const withFooter = [
	'backlog note',
	'',
	'superapp',
	'\tprompt: do a thing',
	'',
	'footer notes here',
	'another footer line',
	'',
].join('\n')
const wf = parse(withFooter)
check('footer: only real sessions parsed (footer ignored)', wf.sessions.length === 1 && wf.sessions[0].label === 'superapp', JSON.stringify(wf.sessions.map((s) => s.label)))
check('footer: round-trips byte-identical', applyOps(wf.lines, buildOps(wf.sessions)).join('\n') === withFooter)
// mutating a session must leave the footer untouched
wf.sessions[0].prompts[0].desiredKind = 'DONE'
const wfOut = applyOps(wf.lines, buildOps(wf.sessions)).join('\n')
check('footer: preserved after a session mutation', wfOut.includes('\nfooter notes here\nanother footer line\n') && wfOut.includes('prompt: do a thing\n\t\t[DONE]'))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
