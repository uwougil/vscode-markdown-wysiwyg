// Markdown WYSIWYG V1 — correctness + benchmark harness.
//
// Runs against the real `@vscode/markdown-editor` engine (Node, no DOM):
//   1. source round-trip      — sourceText identity across the whole corpus
//   2. blank-line fix 专项    — drive `insertSmartEnter` + replicate the webview
//                               capture-phase fix; assert exact `\n` runs
//   3. outline extraction     — heading offsets/labels via `findNodeOffsetById`
//   4. computeTextEdit        — the webview↔host diff helper
//   5. performance            — parse time / block / heading counts per corpus
//
// Usage: node test/run.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
	EditorModel,
	StringValue,
	StringEdit,
	Selection,
	insertSmartEnter,
	DEFAULT_WORD_NAVIGATION_CONFIG,
	findNodeOffsetById,
} from '@vscode/markdown-editor';
import { buildCorpora } from './corpus/generate.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.join(__dirname, 'corpus');

// ------------------------------------------------------------------ reporting
let passed = 0;
let failed = 0;
const failures = [];
function assert(name, cond, detail = '') {
	if (cond) { passed++; }
	else { failed++; failures.push(`✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title) { console.log(`\n── ${title}`); }

// ------------------------------------------------------------------ helpers
/** Set source + collapsed caret, in that order (activeBlock derives from both). */
function load(model, source, caret) {
	model.sourceText.set(new StringValue(source), undefined);
	model.selection.set(Selection.collapsed(caret), undefined);
}

/** Build a `CursorCommandContext` for a collapsed caret (mirrors engine's own). */
function ctxFor(model, caret) {
	return {
		text: model.sourceText.get().value,
		selection: Selection.collapsed(caret),
		document: model.document.get(),
		activeBlock: model.activeBlock.get(),
		markerVisibleBlocks: new Set(),
		wordNavigationConfig: DEFAULT_WORD_NAVIGATION_CONFIG,
		cursorPosition: { kind: 'source', offset: caret },
	};
}

/**
 * The webview's blank-line fix, case 1 (repeated Enter while a transient pending
 * paragraph is armed): cancel the pending and materialize real `\n` runs.
 * Returns the new caret offset.
 */
function applyBlankLineFix(model, pending, blankRun = 2) {
	const start = pending.replaceRange.start;
	model.cancelPendingParagraph();
	const newlines = '\n'.repeat(blankRun + 1); // N blank lines == N+1 newlines
	model.applyEdit(StringEdit.replace(pending.replaceRange, newlines), Selection.collapsed(start + newlines.length));
	return start + newlines.length;
}

/** The webview's blank-line fix, case 2 (further Enter inside a blank run). */
function applyBlankLineExtra(model, caret) {
	model.applyEdit(StringEdit.insert(caret, '\n'), Selection.collapsed(caret + 1));
}

/** Same heading label extraction the webview uses for the outline. */
function headingLabel(source, offset) {
	const nl = source.indexOf('\n', offset);
	const line = source.slice(offset, nl === -1 ? source.length : nl);
	return line.replace(/^\s*#{1,6}\s*/, '').trim();
}

// =========================================================== 1. round-trip
section('1. 源码往返保真');
function roundtrip(corpora) {
	for (const [name, content] of Object.entries(corpora)) {
		const model = new EditorModel();
		model.sourceText.set(new StringValue(content), undefined);
		const back = model.sourceText.get().value;
		assert(`round-trip ${name}`, back === content,
			`in=${content.length} out=${back.length}`);
	}
}

// =========================================================== 2. blank lines
section('2. 连续空行专项');
function blankLines() {
	// --- paragraph at EOF: A + Enter(×2) + Enter(×3) ---
	{
		const model = new EditorModel();
		load(model, 'A', 1);
		const res = insertSmartEnter(ctxFor(model, 1));
		assert('Enter#1 arms pending (paragraph EOF)', res.kind === 'pending', `got ${res.kind}`);
		assert('Enter#1 leaves source untouched', model.sourceText.get().value === 'A');
		const caret = applyBlankLineFix(model, res); // Enter#2
		assert('Enter#2 → "A\\n\\n\\n"', model.sourceText.get().value === 'A\n\n\n',
			JSON.stringify(model.sourceText.get().value));
		assert('Enter#2 caret at end', caret === 4);
		applyBlankLineExtra(model, caret); // Enter#3
		assert('Enter#3 → "A\\n\\n\\n\\n"', model.sourceText.get().value === 'A\n\n\n\n',
			JSON.stringify(model.sourceText.get().value));
	}

	// --- paragraph with a trailing newline in the gap ---
	{
		const model = new EditorModel();
		load(model, 'A\n', 1);
		const res = insertSmartEnter(ctxFor(model, 1));
		assert('Enter (trailing \\n) arms pending', res.kind === 'pending');
		if (res.kind === 'pending') {
			applyBlankLineFix(model, res);
			assert('fix consumes trailing gap → "A\\n\\n\\n"', model.sourceText.get().value === 'A\n\n\n',
				JSON.stringify(model.sourceText.get().value));
		}
	}

	// --- heading ---
	{
		const model = new EditorModel();
		load(model, '# H', 3);
		const res = insertSmartEnter(ctxFor(model, 3));
		assert('heading Enter arms pending', res.kind === 'pending');
		if (res.kind === 'pending') {
			applyBlankLineFix(model, res);
			assert('heading fix → "# H\\n\\n\\n"', model.sourceText.get().value === '# H\n\n\n',
				JSON.stringify(model.sourceText.get().value));
		}
	}

	// --- thematic break ---
	{
		const model = new EditorModel();
		load(model, '---', 3);
		const res = insertSmartEnter(ctxFor(model, 3));
		assert('thematicBreak Enter arms pending', res.kind === 'pending');
		if (res.kind === 'pending') {
			applyBlankLineFix(model, res);
			assert('thematicBreak fix → "---\\n\\n\\n"', model.sourceText.get().value === '---\n\n\n',
				JSON.stringify(model.sourceText.get().value));
		}
	}

	// --- mid-paragraph Enter is a split, NOT the blank-line fix ---
	{
		const model = new EditorModel();
		load(model, 'AB', 1);
		const res = insertSmartEnter(ctxFor(model, 1));
		assert('mid-paragraph Enter is an edit (split)', res.kind === 'edit');
		if (res.kind === 'edit') {
			model.applyEdit(res.edit, res.selection);
			assert('split → "A\\n\\nB"', model.sourceText.get().value === 'A\n\nB',
				JSON.stringify(model.sourceText.get().value));
		}
	}

	// --- normal path: pending materializes when text is typed ---
	// NOTE: `materializePendingParagraph` is a no-op unless a pending paragraph
	// is armed first. In the live editor the `EditorController` arms it, but this
	// headless harness drives `EditorModel` directly, so we arm it explicitly.
	{
		const model = new EditorModel();
		load(model, 'A', 1);
		const res = insertSmartEnter(ctxFor(model, 1));
		assert('pending then type arms', res.kind === 'pending');
		if (res.kind === 'pending') {
			model.armPendingParagraph({
				anchorBlock: res.anchorBlock,
				replaceRange: res.replaceRange,
				separateFromPreviousBlock: res.separateFromPreviousBlock,
				atEof: res.atEof,
			});
			model.materializePendingParagraph('B');
			assert('materialize → "A\\n\\nB"', model.sourceText.get().value === 'A\n\nB',
				JSON.stringify(model.sourceText.get().value));
		}
	}

	// --- blank run terminates on any non-Enter key (webview resets blankRun) ---
	{
		const model = new EditorModel();
		load(model, 'A', 1);
		const res = insertSmartEnter(ctxFor(model, 1));
		if (res.kind === 'pending') {
			const caret = applyBlankLineFix(model, res); // now "A\n\n\n", blankRun=2
			// typing a normal char must NOT insert extra newlines
			model.applyEdit(StringEdit.insert(caret, 'X'), Selection.collapsed(caret + 1));
			assert('typing after blank run is normal text', model.sourceText.get().value === 'A\n\n\nX',
				JSON.stringify(model.sourceText.get().value));
		}
	}
}

// =========================================================== 3. outline
section('3. 大纲提取');
function outline() {
	const src = '# A\n\n## B\n\n  ### C  \n\n#### D\n\n正文段落\n\n##### E\n';
	const model = new EditorModel();
	model.sourceText.set(new StringValue(src), undefined);
	const doc = model.document.get();
	const entries = [];
	for (const b of doc.blocks) {
		if (b.kind !== 'heading') { continue; }
		const off = findNodeOffsetById(doc, b);
		entries.push({ level: b.level, label: headingLabel(src, off) });
	}
	assert('outline levels 1..5', JSON.stringify(entries.map(e => e.level)) === JSON.stringify([1, 2, 3, 4, 5]),
		JSON.stringify(entries.map(e => e.level)));
	assert('outline labels (incl. indented heading)', JSON.stringify(entries.map(e => e.label)) === JSON.stringify(['A', 'B', 'C', 'D', 'E']),
		JSON.stringify(entries.map(e => e.label)));
}

// =========================================================== 4. computeTextEdit
section('4. computeTextEdit');
function computeTextEdit(previousText, text) {
	let start = 0;
	while (start < previousText.length && start < text.length && previousText.charCodeAt(start) === text.charCodeAt(start)) { start++; }
	let previousEnd = previousText.length;
	let end = text.length;
	while (previousEnd > start && end > start && previousText.charCodeAt(previousEnd - 1) === text.charCodeAt(end - 1)) { previousEnd--; end--; }
	return { start, endExclusive: previousEnd, text: text.slice(start, end) };
}
function computeTextEditTests() {
	assert('insert', JSON.stringify(computeTextEdit('ab', 'aXb')) === JSON.stringify({ start: 1, endExclusive: 1, text: 'X' }));
	assert('delete', JSON.stringify(computeTextEdit('aXb', 'ab')) === JSON.stringify({ start: 1, endExclusive: 2, text: '' }));
	// 'hello' → 'help': common prefix 'hel' (3), no common suffix ('o'≠'p'),
	// so the minimal edit replaces the 2-char span 'lo' with 'p'.
	assert('replace', JSON.stringify(computeTextEdit('hello', 'help')) === JSON.stringify({ start: 3, endExclusive: 5, text: 'p' }));
	assert('append', JSON.stringify(computeTextEdit('a', 'ab')) === JSON.stringify({ start: 1, endExclusive: 1, text: 'b' }));
	assert('identical', JSON.stringify(computeTextEdit('abc', 'abc')) === JSON.stringify({ start: 3, endExclusive: 3, text: '' }));
}

// =========================================================== 5. benchmark
section('5. 性能基准');
function benchmark(corpora) {
	const rows = [];
	for (const [name, content] of Object.entries(corpora)) {
		const model = new EditorModel();
		const t0 = performance.now();
		model.sourceText.set(new StringValue(content), undefined);
		const doc = model.document.get(); // force full parse
		const t1 = performance.now();
		let headings = 0;
		for (const b of doc.blocks) { if (b.kind === 'heading') { headings++; } }
		rows.push({
			corpus: name,
			bytes: content.length,
			lines: content.split('\n').length,
			blocks: doc.blocks.length,
			headings,
			parseMs: Number((t1 - t0).toFixed(2)),
		});
	}
	console.table(rows);
	return rows;
}

// ------------------------------------------------------------------ run
const corpora = { ...buildCorpora() };
for (const name of ['small', 'medium']) {
	const p = path.join(corpusDir, `${name}.md`);
	if (existsSync(p)) { corpora[name] = readFileSync(p, 'utf8'); }
}

roundtrip(corpora);
blankLines();
outline();
computeTextEditTests();
const bench = benchmark(corpora);

console.log(`\n──────────────────────────────`);
console.log(`通过 ${passed} / ${passed + failed}`);
if (failures.length) {
	console.log('\n失败项：');
	for (const f of failures) { console.log('  ' + f); }
	process.exitCode = 1;
} else {
	console.log('全部通过 ✅');
}
