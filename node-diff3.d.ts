// Minimal ambient types for node-diff3 (it ships no declarations). We only use
// diff3Merge, which returns a list of "ok" (clean) or "conflict" regions.
declare module 'node-diff3' {
	interface OkRegion {
		ok: string[]
	}
	interface ConflictRegion {
		conflict: { a: string[]; aIndex: number; o: string[]; oIndex: number; b: string[]; bIndex: number }
	}
	export function diff3Merge(
		a: string[],
		o: string[],
		b: string[],
		options?: { excludeFalseConflicts?: boolean; stringSeparator?: string | RegExp },
	): (OkRegion | ConflictRegion)[]
}
