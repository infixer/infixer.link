/** Line classes shared by the read view and the editor decorations (content.css). */
import type { Line } from '@infixer-link/content';

export function lineClass(line: Line, active = false): string {
	const cls = ['ln'];
	if (line.kind === 'heading') cls.push(`h${line.heading}`);
	if (line.kind === 'code' || line.kind === 'code-open' || line.kind === 'code-close')
		cls.push(line.kind);
	if (line.kind === 'quote') cls.push('quote');
	if (line.kind === 'hr' && !active) cls.push('hr');
	// The line being edited shows its raw indentation instead of the rendered one.
	if (!active && line.level > 0 && line.kind !== 'code' && line.kind !== 'code-open') {
		cls.push(`lv${Math.min(line.level, 8)}`);
		if (line.kind === 'list' && line.ordered !== undefined) cls.push('num');
		else if (line.kind !== 'quote') cls.push('bul');
	}
	return cls.join(' ');
}

export function pageHref(page: { id: string; title: string }): string {
	return `/p/${page.id}/${encodeURIComponent(page.title.trim().replace(/\s+/g, '_')).slice(0, 120)}`;
}

export function missingHref(name: string): string {
	return `/t/${encodeURIComponent(name)}`;
}
