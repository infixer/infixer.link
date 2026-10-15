import { describe, expect, it } from 'vitest';
import { parse, parseInline, type Inline } from './parse.ts';

/** Compact view of inline nodes for readable fixtures. */
function shape(nodes: Inline[]): unknown[] {
	return nodes.map((n) => {
		switch (n.type) {
			case 'text':
				return n.text;
			case 'code':
				return { code: n.text };
			case 'link':
				return { link: n.name };
			case 'tag':
				return { tag: n.name };
			case 'url':
				return { url: n.url, label: n.label };
			case 'asset':
				return { asset: n.id };
			case 'math':
				return { math: n.text };
			default:
				return { [n.type]: shape(n.children), ...(n.weight && n.weight > 1 ? { weight: n.weight } : {}) };
		}
	});
}

const inline = (text: string) => shape(parseInline(text));

describe('inline: links and tags', () => {
	it('parses Cosense internal links including Japanese and unresolved names', () => {
		expect(inline('[アンチ・オイディプス] の続き')).toEqual([{ link: 'アンチ・オイディプス' }, ' の続き']);
	});

	it('parses tags only at word starts', () => {
		expect(inline('#読書 と C#言語 と (#括弧)')).toEqual([{ tag: '読書' }, ' と C#言語 と (', { tag: '括弧)' }]);
	});

	it('parses all external link forms', () => {
		expect(inline('[資料](https://a.example/x)')).toEqual([{ url: 'https://a.example/x', label: '資料' }]);
		expect(inline('[https://b.example 参考]')).toEqual([{ url: 'https://b.example', label: '参考' }]);
		expect(inline('[参考 https://c.example]')).toEqual([{ url: 'https://c.example', label: '参考' }]);
		expect(inline('見て https://d.example/a?b=1。')).toEqual([
			'見て ',
			{ url: 'https://d.example/a?b=1', label: 'https://d.example/a?b=1' },
			'。'
		]);
	});

	it('keeps balanced parentheses in bare URLs but drops a closing one', () => {
		expect(inline('(https://w.example/A_(b))')).toEqual([
			'(',
			{ url: 'https://w.example/A_(b)', label: 'https://w.example/A_(b)' },
			')'
		]);
	});

	it('rejects unsafe schemes and keeps them as text or internal names', () => {
		expect(inline('[x](javascript:alert(1))')).toEqual([{ link: 'x' }, '(javascript:alert(1))']);
		expect(inline('[javascript:alert(1)]')).toEqual([{ link: 'javascript:alert(1)' }]);
	});

	it('parses assets and math', () => {
		expect(inline('[asset:550E8400-E29B-41D4-A716-446655440000] [$ x^2]')).toEqual([
			{ asset: '550e8400-e29b-41d4-a716-446655440000' },
			' ',
			{ math: 'x^2' }
		]);
	});
});

describe('inline: formatting', () => {
	it('parses Markdown emphasis', () => {
		expect(inline('**太字** と *斜体* と ~~取消~~')).toEqual([
			{ strong: ['太字'] },
			' と ',
			{ em: ['斜体'] },
			' と ',
			{ strike: ['取消'] }
		]);
	});

	it('parses Cosense decorations with weight', () => {
		expect(inline('[* 太字] [** 見出し] [/ 斜体] [- 取消] [_ 下線]')).toEqual([
			{ strong: ['太字'] },
			' ',
			{ strong: ['見出し'], weight: 2 },
			' ',
			{ em: ['斜体'] },
			' ',
			{ strike: ['取消'] },
			' ',
			{ underline: ['下線'] }
		]);
	});

	it('nests links inside emphasis', () => {
		expect(inline('**[読書] が好き**')).toEqual([{ strong: [{ link: '読書' }, ' が好き'] }]);
	});

	it('leaves unmatched or spaced markers and snake_case alone', () => {
		expect(inline('2 * 3 * 4')).toEqual(['2 * 3 * 4']);
		expect(inline('**閉じない')).toEqual(['**閉じない']);
		expect(inline('snake_case_name')).toEqual(['snake_case_name']);
	});

	it('never finds links, tags or formatting inside inline code', () => {
		expect(inline('`[偽リンク] #偽タグ **x**`')).toEqual([{ code: '[偽リンク] #偽タグ **x**' }]);
	});

	it('supports backslash escapes', () => {
		expect(inline('\\[リンクではない\\] \\#タグではない')).toEqual(['[リンクではない] #タグではない']);
	});

	it('keeps offsets consistent with the source', () => {
		const text = 'a **b [c]** d';
		const [, strong] = parseInline(text);
		expect(strong.type).toBe('strong');
		if (strong.type !== 'strong') return;
		expect(text.slice(strong.from, strong.to)).toBe('**b [c]**');
		expect(text.slice(strong.innerFrom, strong.innerTo)).toBe('b [c]');
		const link = strong.children[1];
		expect(link.type === 'link' && text.slice(link.innerFrom, link.innerTo)).toBe('c');
	});
});

describe('blocks', () => {
	const kinds = (source: string) => parse(source).lines.map((l) => [l.kind, l.level]);

	it('parses Markdown headings, lists, quotes, rules and blanks', () => {
		expect(kinds('# 見出し\n- a\n - b\n1. c\n> 引用\n---\n\nテキスト')).toEqual([
			['heading', 0],
			['list', 1],
			['list', 2],
			['list', 1],
			['quote', 0],
			['hr', 0],
			['blank', 0],
			['text', 0]
		]);
		expect(parse('### 小見出し').lines[0].heading).toBe(3);
		expect(parse('3. 三番').lines[0].ordered).toBe(3);
	});

	it('treats Cosense leading spaces as indentation levels', () => {
		expect(kinds('親\n 子\n  孫')).toEqual([
			['text', 0],
			['text', 1],
			['text', 2]
		]);
	});

	it('does not treat an indented # as a heading', () => {
		expect(parse(' # 見出しではない').lines[0].kind).toBe('text');
	});

	it('parses fenced code blocks without scanning their content', () => {
		const p = parse('```js\nconst a = "[偽リンク]"\n#偽タグ\n```\n[本物]');
		expect(p.lines.map((l) => l.kind)).toEqual(['code-open', 'code', 'code', 'code-close', 'text']);
		expect(p.lines[0].lang).toBe('js');
		expect(p.links).toEqual(['本物']);
	});

	it('parses Cosense code: blocks by indentation', () => {
		const p = parse('code:sample.js\n const x = "[偽]"\n  nested\n[後]');
		expect(p.lines.map((l) => l.kind)).toEqual(['code-open', 'code', 'code', 'text']);
		expect(p.lines[0].lang).toBe('sample.js');
		expect(p.links).toEqual(['後']);
	});

	it('an unclosed fence keeps the rest as code (nothing is lost)', () => {
		const p = parse('```\n[a]');
		expect(p.lines.map((l) => [l.kind, l.text])).toEqual([
			['code-open', '```'],
			['code', '[a]']
		]);
	});

	it('turns URL-only lines into cards, including indented and list items', () => {
		const p = parse('https://a.example/x\n - https://b.example\n文中 https://c.example\n[ラベル](https://d.example)');
		expect(p.lines.map((l) => [l.kind, l.url])).toEqual([
			['card', 'https://a.example/x'],
			['list', 'https://b.example'],
			['text', undefined],
			['text', undefined]
		]);
		expect(p.cards).toEqual(['https://a.example/x', 'https://b.example']);
	});

	it('extracts unique links, tags and assets in first-seen order', () => {
		const p = parse('[B] #A [B]\n- [C]\n[asset:550e8400-e29b-41d4-a716-446655440000]');
		expect(p.links).toEqual(['B', 'A', 'C']);
		expect(p.assets).toEqual(['550e8400-e29b-41d4-a716-446655440000']);
	});

	it('handles the design example end to end', () => {
		const p = parse(
			[
				'# 今日読んだもの',
				'',
				'- [アンチ・オイディプス] の続きを読んだ',
				'- **欲望する機械** の章が面白い',
				'- #読書',
				'',
				'[参考資料](https://example.org)',
				'',
				'```',
				'code block',
				'```'
			].join('\n')
		);
		expect(p.links).toEqual(['アンチ・オイディプス', '読書']);
		expect(p.lines.filter((l) => l.kind === 'list')).toHaveLength(3);
	});

	it('is linear on pathological input', () => {
		const evil = '['.repeat(20000) + '*'.repeat(20000) + '`'.repeat(5000);
		const start = performance.now();
		parse(evil);
		expect(performance.now() - start).toBeLessThan(500);
	});
});
