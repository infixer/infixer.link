/**
 * Line-based three-way comparison for conflict resolution (design §4.3, §17 Phase 6).
 *
 * `merge3(base, ours, theirs)` splits the text into chunks: unchanged lines, lines changed
 * on one side only (or identically on both), and conflicts where both sides changed the
 * same lines differently. Only a result without conflicts may be offered as a merge;
 * the caller still never writes it without the owner's choice (ADR 0015).
 */

export type Chunk =
	| { kind: 'stable'; lines: string[] }
	/** Changed on one side (or identically on both); `lines` is the result, `base` the original. */
	| { kind: 'ours' | 'theirs' | 'both'; lines: string[]; base: string[] }
	| { kind: 'conflict'; base: string[]; ours: string[]; theirs: string[] };

export interface MergeResult {
	chunks: Chunk[];
	conflicts: number;
	/** The merged text when there are no conflicts. */
	merged: string | null;
}

/** Above this many differing lines the middle is treated as one changed block. */
const MAX_EDIT_DISTANCE = 4000;

const sameLines = (a: string[], b: string[]) =>
	a.length === b.length && a.every((line, i) => line === b[i]);

/**
 * For each line of `a`, the index of the matching line in `b` (or -1), from a Myers
 * shortest-edit-script diff. Matches are strictly increasing.
 */
export function matchLines(a: string[], b: string[]): Int32Array {
	const match = new Int32Array(a.length).fill(-1);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		match[start] = start;
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
		match[endA] = endB;
	}
	const n = endA - start;
	const m = endB - start;
	if (n === 0 || m === 0) return match;

	const max = Math.min(n + m, MAX_EDIT_DISTANCE);
	const offset = max;
	const v = new Int32Array(2 * max + 2);
	const trace: Int32Array[] = [];
	let found = false;
	for (let d = 0; d <= max && !found; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x =
				k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
					? v[offset + k + 1]!
					: v[offset + k - 1]! + 1;
			let y = x - k;
			while (x < n && y < m && a[start + x] === b[start + y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = true;
				break;
			}
		}
	}
	if (!found) return match; // too different: no matches in the middle

	// Walk the trace backwards to recover the matched (diagonal) lines.
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
		const vd = trace[d]!;
		const k = x - y;
		const prevK =
			d === 0
				? 0
				: k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)
					? k + 1
					: k - 1;
		const prevX = d === 0 ? 0 : vd[offset + prevK]!;
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
			match[start + x] = start + y;
		}
		x = prevX;
		y = prevY;
	}
	return match;
}

export function merge3(base: string, ours: string, theirs: string): MergeResult {
	const o = base.split('\n');
	const a = ours.split('\n');
	const b = theirs.split('\n');
	const ma = matchLines(o, a);
	const mb = matchLines(o, b);

	const chunks: Chunk[] = [];
	const pushStable = (line: string) => {
		const last = chunks.at(-1);
		if (last?.kind === 'stable') last.lines.push(line);
		else chunks.push({ kind: 'stable', lines: [line] });
	};

	let io = 0;
	let ia = 0;
	let ib = 0;
	for (;;) {
		// Next base line kept by both sides.
		let j = io;
		while (j < o.length && (ma[j]! < 0 || mb[j]! < 0)) j++;
		if (j < o.length && j === io && ma[j] === ia && mb[j] === ib) {
			pushStable(o[j]!);
			io++;
			ia++;
			ib++;
			continue;
		}
		const ea = j < o.length ? ma[j]! : a.length;
		const eb = j < o.length ? mb[j]! : b.length;
		const oPart = o.slice(io, j);
		const aPart = a.slice(ia, ea);
		const bPart = b.slice(ib, eb);
		if (oPart.length || aPart.length || bPart.length) {
			const aSame = sameLines(aPart, oPart);
			const bSame = sameLines(bPart, oPart);
			if (aSame && bSame) oPart.forEach(pushStable);
			else if (aSame) chunks.push({ kind: 'theirs', lines: bPart, base: oPart });
			else if (bSame) chunks.push({ kind: 'ours', lines: aPart, base: oPart });
			else if (sameLines(aPart, bPart)) chunks.push({ kind: 'both', lines: aPart, base: oPart });
			else chunks.push({ kind: 'conflict', base: oPart, ours: aPart, theirs: bPart });
		}
		if (j >= o.length) break;
		io = j;
		ia = ea;
		ib = eb;
	}

	const conflicts = chunks.filter((c) => c.kind === 'conflict').length;
	return {
		chunks,
		conflicts,
		merged: conflicts === 0 ? resolve(chunks, []) : null
	};
}

export type Choice = 'ours' | 'theirs' | 'both';

/** Builds the text from the chunks, using `choices[i]` for the i-th conflict. */
export function resolve(chunks: Chunk[], choices: Choice[]): string {
	const out: string[] = [];
	let n = 0;
	for (const c of chunks) {
		if (c.kind !== 'conflict') {
			out.push(...c.lines);
			continue;
		}
		const choice = choices[n++] ?? 'ours';
		if (choice !== 'theirs') out.push(...c.ours);
		if (choice !== 'ours') out.push(...c.theirs);
	}
	return out.join('\n');
}

/** Single-value three-way merge (e.g. the title): null when both sides changed it differently. */
export function mergeValue<T>(base: T, ours: T, theirs: T): T | null {
	if (ours === theirs) return ours;
	if (ours === base) return theirs;
	if (theirs === base) return ours;
	return null;
}
