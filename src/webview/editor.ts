/*---------------------------------------------------------------------------------------------
 *  Markdown WYSIWYG V1 — webview glue
 *
 *  Thin webview host for the `@vscode/markdown-editor` engine. It mirrors the
 *  official `markdown-language-features/markdown-editor-src/editor.ts` wiring
 *  (EditorModel → EditorView → EditorController) and layers the V1 features on
 *  top, without touching the engine itself:
 *
 *    - Editor-independent zoom: sets `--markdown-font-size` on the document
 *      root. Every engine size is `em`-based off that root, so the whole
 *      document (headings, lists, tables, code) scales together, leaving the
 *      outline chrome and VS Code's own zoom (`window.zoomLevel`) untouched.
 *    - Content width: drives the engine's `limitedWidth` observable
 *      (680 / 820 / 1000 px, or `undefined` = fill).
 *    - Typewriter mode: on caret moves, keeps the caret near the vertical
 *      center of the scroll container, without fighting user scroll.
 *    - Continuous blank lines: the engine arms a *transient* pending paragraph
 *      for the first Enter at a paragraph end but returns early on a second
 *      Enter, so `A` + Enter + Enter + `B` never yields `A\n\n\nB`. We intercept
 *      the repeated Enter in the capture phase and materialize real `\n` runs,
 *      so blank lines round-trip through save/reopen as plain Markdown (no
 *      `<br>` or private dialect).
 *    - Image paste/drag: reads pasted/dropped PNG/JPEG/WebP, asks the host to
 *      write it to `<docDir>/assets`, and inserts a relative `![](assets/…)`.
 *    - Outline panel: headings (H1–H6) parsed from `model.document`, with
 *      click-to-jump, current-section highlight, filter, and collapse.
 *--------------------------------------------------------------------------------------------*/

import {
	AsyncClipboardStrategy,
	EditorController,
	EditorModel,
	EditorView,
	OffsetRange,
	Selection,
	StringEdit,
	StringValue,
	findNodeOffsetById,
	vscodeHostKeyboardProfile,
	vscodeLocalKeyboardProfile,
} from '@vscode/markdown-editor';
import { Disposable, autorun, observableValue } from '@vscode/observables';
import 'katex/dist/katex.min.css';
import '@vscode/markdown-editor/editor.css';
import '@vscode/markdown-editor/themes/vscode-default.css';
import './editor.css';

interface VsCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** Host-persisted user preferences, mirrored from the extension. */
interface Config {
	zoom: number;
	contentWidth: 'narrow' | 'normal' | 'wide' | 'full';
	typewriter: boolean;
	outline: boolean;
}

const DEFAULT_CONFIG: Config = { zoom: 100, contentWidth: 'normal', typewriter: false, outline: true };

/** `contentWidth` preset → `limitedWidth` max width in px (`undefined` = fill). */
const WIDTH_PX: Record<Config['contentWidth'], number | undefined> = {
	narrow: 680,
	normal: 820,
	wide: 1000,
	full: undefined,
};

/** Base font size the engine theme uses when `--markdown-font-size` is absent. */
const BASE_FONT_SIZE_PX = 14;

interface InitialState {
	readonly content: string;
	readonly documentVersion: number;
	readonly readonly: boolean;
}

/** A heading entry for the outline panel. */
interface OutlineEntry {
	offset: number;
	level: 1 | 2 | 3 | 4 | 5 | 6;
	label: string;
}

class Editor extends Disposable {
	readonly model = new EditorModel();
	private isUpdatingFromExtension = false;

	private readonly vscode = acquireVsCodeApi();
	private readonly messageSecret: string | undefined;
	/** Outer `#root` flex wrapper (sidebar + editor scroll container). */
	private readonly root: HTMLElement;
	/** The scroll container that hosts the editor view (`main.mdw-main`). */
	private readonly host: HTMLElement;

	private view: EditorView | undefined;
	private controller: EditorController | undefined;

	private config: Config = { ...DEFAULT_CONFIG };
	private readonly limitedWidth = observableValue<number | undefined>('mdw-limitedWidth', WIDTH_PX.normal);

	/** Number of consecutive blank lines currently committed by the blank-line feature. */
	private blankRun = 0;
	/** True when a typewriter scroll is scheduled for the next frame. */
	private typewriterScheduled = false;
	/** Timestamp of the last user-initiated scroll (wheel), to avoid fighting it. */
	private lastUserScroll = 0;

	// Outline panel state.
	private readonly outlineContainer: HTMLElement;
	private readonly outlineList: HTMLElement;
	private readonly outlineFilter: HTMLInputElement;
	private outlineEntries: OutlineEntry[] = [];

	private mermaidCounter = 0;

	constructor(host: HTMLElement, initialState: InitialState) {
		super();

		this.root = host;
		this.messageSecret = document.querySelector<HTMLMetaElement>('meta[name="vscode-markdown-editor-message-secret"]')?.content;

		this.model.sourceText.set(new StringValue(initialState.content), undefined);
		this.model.readonlyMode.set(initialState.readonly, undefined);

		// Build the outline sidebar chrome before the editor so `_applyConfig`
		// can show/hide it immediately. `_buildOutlineChrome` restructures `#root`
		// into a flex row of `<aside class="mdw-outline">` + `<main class="mdw-main">`
		// and hands back the `<main>` as the editor's scroll container.
		const chrome = this._buildOutlineChrome();
		this.outlineContainer = chrome.outline;
		this.outlineList = chrome.list;
		this.outlineFilter = chrome.filter;
		this.host = chrome.main;

		window.addEventListener('message', this._handleMessage);

		this._createView(initialState.content);

		this.vscode.postMessage({ type: 'ready', documentVersion: initialState.documentVersion });
	}

	// ------------------------------------------------------------------ view

	private _createView(content: string): void {
		const model = this.model;

		const view = this._register(new EditorView(model, {
			classNames: ['md-theme-vscode-default'],
			showReadonlyToggle: false,
			limitedWidth: this.limitedWidth,
			onOpenLink: url => this.vscode.postMessage({ type: 'openLink', href: url }),
			renderCustomCodeBlock: (language, code) => {
				if (language !== 'mermaid') { return undefined; }
				return this._renderMermaid(code);
			},
		}));
		this.view = view;

		this.controller = this._register(new EditorController(model, view, {
			clipboardStrategy: new AsyncClipboardStrategy(),
			keyboardProfile: vscodeLocalKeyboardProfile,
			forwardedKeyboardProfile: vscodeHostKeyboardProfile,
			historyStrategy: {
				undo: () => this.vscode.postMessage({ type: 'history', command: 'undo' }),
				redo: () => this.vscode.postMessage({ type: 'history', command: 'redo' }),
			},
		}));

		// Blank-line fix: intercept the repeated Enter *before* the engine's
		// keydown handler (capture phase runs first) so we can materialize real
		// blank lines the engine refuses to create.
		view.element.addEventListener('keydown', this._handleKeyDownCapture, true);
		view.element.addEventListener('pointerdown', this._handlePointerDownCapture, true);
		this._register({
			dispose: () => {
				view.element.removeEventListener('keydown', this._handleKeyDownCapture, true);
				view.element.removeEventListener('pointerdown', this._handlePointerDownCapture, true);
			},
		});

		this.host.appendChild(view.element);

		// Image paste / drag (the engine handles text clipboard, not images).
		document.addEventListener('paste', this._handlePaste);
		document.addEventListener('dragover', this._handleDragOver);
		document.addEventListener('drop', this._handleDrop);
		this._register({
			dispose: () => {
				document.removeEventListener('paste', this._handlePaste);
				document.removeEventListener('dragover', this._handleDragOver);
				document.removeEventListener('drop', this._handleDrop);
			},
		});

		// User scroll should temporarily pause typewriter so we never fight it.
		this.host.addEventListener('wheel', this._handleWheel, { passive: true });
		this._register({ dispose: () => this.host.removeEventListener('wheel', this._handleWheel) });

		// Forward edits to the host (undo-friendly via the host's own undo stack).
		let previousText = this.model.sourceText.get().value;
		this._register(autorun((reader) => {
			const text = reader.readObservable(this.model.sourceText).value;
			if (!this.isUpdatingFromExtension && text !== previousText) {
				this.vscode.postMessage({ type: 'edit', ...computeTextEdit(previousText, text) });
			}
			previousText = text;
		}));

		// Typewriter + outline highlight both react to selection changes.
		this._register(autorun((reader) => {
			reader.readObservable(this.model.selection);
			this._scheduleTypewriterScroll();
			this._updateOutlineHighlight();
		}));

		// Rebuild the outline whenever the document re-parses (heading edits).
		this._register(autorun((reader) => {
			reader.readObservable(this.model.document);
			this._rebuildOutline();
		}));

		// Persist scroll + selection so they survive webview reload / session switch.
		this._restoreViewState();
		this._register(autorun((reader) => {
			const sel = reader.readObservable(this.model.selection);
			this._patchViewState({ selection: sel ? { anchor: sel.anchor, active: sel.active } : undefined });
		}));
		let scrollSaveScheduled = false;
		const saveScroll = (): void => {
			scrollSaveScheduled = false;
			this._patchViewState({ scrollTop: this.host.scrollTop });
		};
		const onScroll = (): void => {
			if (scrollSaveScheduled) { return; }
			scrollSaveScheduled = true;
			requestAnimationFrame(saveScroll);
		};
		this.host.addEventListener('scroll', onScroll, { passive: true });
		this._register({ dispose: () => this.host.removeEventListener('scroll', onScroll) });

		// Restore selection last (content height settles over a few frames).
		requestAnimationFrame(() => {
			const saved = this._getViewState();
			if (saved.selection) {
				const max = this.model.sourceText.get().value.length;
				const anchor = Math.min(saved.selection.anchor, max);
				const active = Math.min(saved.selection.active, max);
				this.model.selection.set(new Selection(anchor, active), undefined);
			}
			if (saved.scrollTop) { this.host.scrollTop = saved.scrollTop; }
		});
	}

	// ------------------------------------------------------------- message

	private readonly _handleMessage = (event: MessageEvent): void => {
		const message = event.data;
		if (!message || typeof message !== 'object') { return; }
		switch (message.type) {
			case 'update': {
				this.isUpdatingFromExtension = true;
				this.model.replaceSourceText(new StringValue(message.content as string));
				this.isUpdatingFromExtension = false;
				break;
			}
			case 'config': {
				this._applyConfig(message.config as Partial<Config>);
				break;
			}
			case 'imageSaved': {
				const path = message.path as string;
				const sel = this.model.selection.get();
				const offset = sel?.active ?? this.model.sourceText.get().value.length;
				this.model.applyEdit(StringEdit.insert(offset, `![](${path})`));
				break;
			}
		}
	};

	// ------------------------------------------------------------ features

	private _applyConfig(patch: Partial<Config>): void {
		this.config = { ...this.config, ...patch };

		// Zoom: scale only the content font. The engine's theme reads
		// `var(--markdown-font-size, 14px)` and every block size is `em`-relative.
		const px = Math.round((BASE_FONT_SIZE_PX * this.config.zoom) / 100 * 100) / 100;
		document.documentElement.style.setProperty('--markdown-font-size', `${px}px`);

		// Content width.
		const width = WIDTH_PX[this.config.contentWidth];
		if (this.limitedWidth.get() !== width) {
			this.limitedWidth.set(width, undefined);
		}

		// Outline visibility.
		this.outlineContainer.classList.toggle('mdw-outline-hidden', !this.config.outline);

		if (this.config.typewriter) {
			this._scheduleTypewriterScroll();
		}
	}

	/** Typewriter: keep the caret near the vertical center of the viewport. */
	private _scheduleTypewriterScroll(): void {
		if (!this.config.typewriter || !this.view || this.typewriterScheduled) { return; }
		this.typewriterScheduled = true;
		requestAnimationFrame(() => {
			this.typewriterScheduled = false;
			this._typewriterScroll();
		});
	}

	private _typewriterScroll(): void {
		if (!this.config.typewriter || !this.view) { return; }
		// Respect the user's own recent scroll (wheel) for a short window.
		if (performance.now() - this.lastUserScroll < 600) { return; }

		const caret = this.view.caretRect.get();
		if (!caret) { return; }

		const scrollEl = this.host;
		const overlayRect = this.view.overlayContainer.getBoundingClientRect();
		const scrollRect = scrollEl.getBoundingClientRect();

		// Caret's position within the scrollable content.
		const caretViewportY = overlayRect.top + caret.y + caret.height / 2;
		const caretContentY = caretViewportY - scrollRect.top + scrollEl.scrollTop;

		const viewportHeight = scrollEl.clientHeight;
		const bandTop = viewportHeight * 0.45;
		const bandBottom = viewportHeight * 0.55;
		const caretRelative = caretContentY - scrollEl.scrollTop;

		// Only recenter when the caret leaves the 45–55% band.
		if (caretRelative >= bandTop && caretRelative <= bandBottom) { return; }

		scrollEl.scrollTop = caretContentY - viewportHeight * 0.5;
	}

	private readonly _handleWheel = (): void => {
		this.lastUserScroll = performance.now();
	};

	// ------------------------------------------------------ blank lines

	private readonly _handlePointerDownCapture = (): void => {
		this.blankRun = 0;
	};

	private readonly _handleKeyDownCapture = (e: KeyboardEvent): void => {
		if (e.isComposing) { return; }

		const isBareEnter = e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
		if (!isBareEnter) {
			// Any other key ends a blank-line run (arrow keys, typing, Escape…).
			this.blankRun = 0;
			return;
		}

		if (this.model.readonlyMode.get()) { return; }

		const selection = this.model.selection.get();
		if (!selection?.isCollapsed) {
			// Multi-line Enter (replace selection) is the engine's job.
			this.blankRun = 0;
			return;
		}

		// Case 1: the engine armed a transient pending paragraph on the *previous*
		// Enter. Materialize it as real blank lines and keep the caret there.
		const pending = this.model.pendingParagraph.get();
		if (
			pending
			&& pending.separateFromPreviousBlock
			&& (pending.anchorBlock.kind === 'paragraph'
				|| pending.anchorBlock.kind === 'heading'
				|| pending.anchorBlock.kind === 'thematicBreak')
		) {
			e.preventDefault();
			e.stopImmediatePropagation();

			const start = pending.replaceRange.start;
			this.model.cancelPendingParagraph();
			this.blankRun = 2;
			const newlines = '\n'.repeat(this.blankRun + 1); // 2 blank lines = 3 newlines
			this.model.applyEdit(
				StringEdit.replace(pending.replaceRange, newlines),
				Selection.collapsed(start + newlines.length),
			);
			return;
		}

		// Case 2: we are already in a blank-line run (no pending). Each further
		// Enter adds one more real blank line.
		if (this.blankRun >= 2) {
			const caret = selection.active;
			e.preventDefault();
			e.stopImmediatePropagation();
			this.blankRun += 1;
			this.model.applyEdit(StringEdit.insert(caret, '\n'), Selection.collapsed(caret + 1));
			return;
		}

		// Otherwise let the engine handle Enter (split, list, code fence, quote…).
		this.blankRun = 0;
	};

	// ------------------------------------------------------------- images

	private readonly _handlePaste = (e: ClipboardEvent): void => {
		const items = e.clipboardData?.items;
		if (!items) { return; }
		const image = firstImageItem(items);
		if (!image) { return; }
		e.preventDefault();
		this._saveImageFile(image.getAsFile());
	};

	private readonly _handleDragOver = (e: DragEvent): void => {
		if (hasImageFile(e.dataTransfer?.files)) {
			e.preventDefault();
			if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
		}
	};

	private readonly _handleDrop = (e: DragEvent): void => {
		const file = firstImageFile(e.dataTransfer?.files);
		if (!file) { return; }
		e.preventDefault();
		this._saveImageFile(file);
	};

	private _saveImageFile(file: File | null): void {
		if (!file) { return; }
		const ext = extensionForMime(file.type);
		if (!ext) { return; }
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = reader.result as string;
			this.vscode.postMessage({ type: 'saveImage', dataUrl, ext });
		};
		reader.readAsDataURL(file);
	}

	// ------------------------------------------------------------- outline

	private _buildOutlineChrome(): { outline: HTMLElement; list: HTMLElement; filter: HTMLInputElement; main: HTMLElement } {
		const outline = document.createElement('aside');
		outline.className = 'mdw-outline';

		const header = document.createElement('div');
		header.className = 'mdw-outline-header';

		const title = document.createElement('span');
		title.className = 'mdw-outline-title';
		title.textContent = '大纲';

		const collapse = document.createElement('button');
		collapse.className = 'mdw-outline-collapse';
		collapse.textContent = '—';
		collapse.title = '折叠大纲';
		collapse.addEventListener('click', () => {
			// Single source of truth is the host config; persist the toggle.
			this.vscode.postMessage({ type: 'setConfig', config: { outline: !this.config.outline } });
		});

		header.append(title, collapse);

		const filter = document.createElement('input');
		filter.className = 'mdw-outline-filter';
		filter.type = 'text';
		filter.placeholder = '筛选标题…';
		filter.addEventListener('input', () => this._renderOutline());

		const list = document.createElement('div');
		list.className = 'mdw-outline-list';

		outline.append(header, filter, list);

		const main = document.createElement('main');
		main.className = 'mdw-main';

		// Restructure `#root` into a flex row: sidebar + scroll container.
		this.root.append(outline, main);
		return { outline, list, filter, main };
	}

	private _rebuildOutline(): void {
		const doc = this.model.document.get();
		const source = this.model.sourceText.get().value;
		const entries: OutlineEntry[] = [];

		for (const block of doc.blocks) {
			if (block.kind !== 'heading') { continue; }
			const offset = findNodeOffsetById(doc, block);
			if (offset === undefined) { continue; }
			entries.push({ offset, level: block.level, label: headingLabel(source, offset) });
		}

		this.outlineEntries = entries;
		this._renderOutline();
	}

	private _renderOutline(): void {
		const filter = this.outlineFilter.value.trim().toLowerCase();
		const frag = document.createDocumentFragment();

		for (const entry of this.outlineEntries) {
			if (filter && !entry.label.toLowerCase().includes(filter)) { continue; }
			const item = document.createElement('button');
			item.className = `mdw-outline-item mdw-outline-level-${entry.level}`;
			item.textContent = entry.label || '(无标题)';
			item.title = entry.label;
			item.dataset.offset = String(entry.offset);
			item.addEventListener('click', () => this._jumpTo(entry.offset));
			frag.appendChild(item);
		}

		this.outlineList.replaceChildren(frag);
		this._updateOutlineHighlight();
	}

	private _jumpTo(offset: number): void {
		if (!this.view) { return; }
		this.model.selection.set(Selection.collapsed(offset), undefined);
		this.view.revealRangeInCenterIfOutsideViewport(OffsetRange.ofStartAndLength(offset, 0));
		this.view.focus();
	}

	private _updateOutlineHighlight(): void {
		const sel = this.model.selection.get();
		const active = sel?.active ?? -1;

		// Last heading whose offset is at or before the caret.
		let current = -1;
		for (const entry of this.outlineEntries) {
			if (entry.offset <= active) { current = entry.offset; } else { break; }
		}

		for (const item of Array.from(this.outlineList.children) as HTMLElement[]) {
			item.classList.toggle('mdw-outline-active', Number(item.dataset.offset) === current);
		}
	}

	// ------------------------------------------------------------ mermaid

	private _renderMermaid(code: string): HTMLElement {
		const div = document.createElement('div');
		div.className = 'md-mermaid';
		div.textContent = code;
		div.setAttribute('aria-busy', 'true');
		const id = `mermaid-${this.mermaidCounter++}`;
		loadMermaid()
			.then(mermaid => mermaid.render(id, code))
			.then(({ svg }) => {
				div.innerHTML = svg;
				div.setAttribute('aria-busy', 'false');
			})
			.catch(() => {
				div.textContent = code;
				div.setAttribute('aria-busy', 'false');
			});
		return div;
	}

	// ------------------------------------------------------------- state

	private _getViewState(): { scrollTop?: number; selection?: { anchor: number; active: number } } {
		return (this.vscode.getState() as { scrollTop?: number; selection?: { anchor: number; active: number } } | undefined) ?? {};
	}

	private _patchViewState(patch: { scrollTop?: number; selection?: { anchor: number; active: number } }): void {
		this.vscode.setState({ ...this._getViewState(), ...patch });
	}

	private _restoreViewState(): void {
		const saved = this._getViewState();
		if (saved.scrollTop) { this.host.scrollTop = saved.scrollTop; }
	}
}

// --------------------------------------------------------------- helpers

function computeTextEdit(previousText: string, text: string): { start: number; endExclusive: number; text: string } {
	let start = 0;
	while (start < previousText.length && start < text.length && previousText.charCodeAt(start) === text.charCodeAt(start)) {
		start++;
	}
	let previousEnd = previousText.length;
	let end = text.length;
	while (previousEnd > start && end > start && previousText.charCodeAt(previousEnd - 1) === text.charCodeAt(end - 1)) {
		previousEnd--;
		end--;
	}
	return { start, endExclusive: previousEnd, text: text.slice(start, end) };
}

/** First `#…` heading label from the source line at `offset`. */
function headingLabel(source: string, offset: number): string {
	const nl = source.indexOf('\n', offset);
	const line = source.slice(offset, nl === -1 ? source.length : nl);
	// `findNodeOffsetById` points at the line start, which may carry up to 3
	// spaces of legal Markdown indentation before the `#` marker.
	return line.replace(/^\s*#{1,6}\s*/, '').trim();
}

function firstImageItem(items: DataTransferItemList): DataTransferItem | undefined {
	for (const item of Array.from(items)) {
		if (item.kind === 'file' && item.type.startsWith('image/')) { return item; }
	}
	return undefined;
}

function firstImageFile(files: FileList | null | undefined): File | undefined {
	if (!files) { return undefined; }
	for (const file of Array.from(files)) {
		if (file.type.startsWith('image/')) { return file; }
	}
	return undefined;
}

function hasImageFile(files: FileList | null | undefined): boolean {
	return firstImageFile(files) !== undefined;
}

function extensionForMime(mime: string): string | undefined {
	switch (mime) {
		case 'image/png': return 'png';
		case 'image/jpeg': return 'jpg';
		case 'image/webp': return 'webp';
		default: return undefined;
	}
}

let mermaidPromise: Promise<(typeof import('mermaid'))['default']> | undefined;

function loadMermaid(): Promise<(typeof import('mermaid'))['default']> {
	if (!mermaidPromise) {
		mermaidPromise = import('mermaid').then(module => {
			module.default.initialize({ startOnLoad: false, theme: 'default' });
			return module.default;
		});
	}
	return mermaidPromise;
}

function readInitialState(): InitialState {
	const element = document.getElementById('vscode-markdown-editor-initial-state');
	if (!(element instanceof HTMLMetaElement)) {
		throw new Error('Markdown editor initial state was not found.');
	}
	element.remove();
	const value: unknown = JSON.parse(decodeURIComponent(element.content));
	if (!value || typeof value !== 'object') {
		throw new Error('Markdown editor initial state is invalid.');
	}
	const candidate = value as Record<string, unknown>;
	return {
		content: candidate.content as string,
		documentVersion: candidate.documentVersion as number,
		readonly: candidate.readonly as boolean,
	};
}

// The host is the scroll container. Our provider injects `<div id="root">`;
// the outline chrome wraps the editor host into a flex row.
const host = document.getElementById('root') as HTMLElement;
host.classList.add('mdw-editor');

new Editor(host, readInitialState());
