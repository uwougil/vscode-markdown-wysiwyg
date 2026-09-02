import * as vscode from 'vscode';

/**
 * Lean custom-editor provider for the Markdown WYSIWYG V1 prototype.
 *
 * Responsibilities (host side of the postMessage protocol):
 *  - feed authoritative document text to the webview ('update')
 *  - apply webview edits to the TextDocument via WorkspaceEdit (undo-friendly)
 *  - forward undo/redo to the host document's own undo stack
 *  - write pasted/dropped images to <docDir>/assets via the filesystem API
 *  - open external links
 *  - persist zoom / content-width / typewriter preferences
 */

interface V1Config {
	zoom: number;
	contentWidth: 'narrow' | 'normal' | 'wide' | 'full';
	typewriter: boolean;
	outline: boolean;
}

const DEFAULT_CONFIG: V1Config = { zoom: 100, contentWidth: 'normal', typewriter: false, outline: true };
const CONFIG_KEY = 'mdwysiwyg.config.v1';

export class MarkdownWysiwygProvider implements vscode.CustomTextEditorProvider {
	private readonly _panels = new Map<string, vscode.WebviewPanel>();
	private _config: V1Config;

	constructor(private readonly _context: vscode.ExtensionContext) {
		this._config = { ...DEFAULT_CONFIG, ...(_context.workspaceState.get<V1Config>(CONFIG_KEY) ?? {}) };
	}

	static register(context: vscode.ExtensionContext): vscode.Disposable {
		const provider = new MarkdownWysiwygProvider(context);
		return vscode.window.registerCustomEditorProvider(
			'mdwysiwyg.markdownEditor',
			provider,
			{ webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
		);
	}

	get config(): V1Config { return this._config; }

	updateConfig(patch: Partial<V1Config>): void {
		this._config = { ...this._config, ...patch };
		void this._context.workspaceState.update(CONFIG_KEY, this._config);
		for (const panel of this._panels.values()) {
			void panel.webview.postMessage({ type: 'config', config: this._config });
		}
	}

	async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
		const key = document.uri.toString();
		this._panels.set(key, panel);
		panel.onDidDispose(() => this._panels.delete(key));

		panel.webview.options = { enableScripts: true };
		panel.webview.html = this._getHtml(panel.webview, document);

		// Feed authoritative text back to the webview; guard against echoing our own edits.
		let applyingFromWebview = false;
		const changeSub = vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.toString() !== document.uri.toString()) { return; }
			if (applyingFromWebview) { return; }
			void panel.webview.postMessage({ type: 'update', content: e.document.getText(), documentVersion: e.document.version });
		});

		panel.webview.onDidReceiveMessage(async (message: Record<string, unknown>) => {
			switch (message.type) {
				case 'ready':
					void panel.webview.postMessage({ type: 'update', content: document.getText(), documentVersion: document.version });
					void panel.webview.postMessage({ type: 'config', config: this._config });
					break;

				case 'edit': {
					const { start, endExclusive, text } = message as { start: number; endExclusive: number; text: string };
					const edit = new vscode.WorkspaceEdit();
					edit.replace(
						document.uri,
						new vscode.Range(document.positionAt(start), document.positionAt(endExclusive)),
						text,
					);
					applyingFromWebview = true;
					try {
						await vscode.workspace.applyEdit(edit);
					} finally {
						applyingFromWebview = false;
					}
					break;
				}

				case 'history': {
					const { command } = message as { command: 'undo' | 'redo' };
					await vscode.commands.executeCommand(command);
					break;
				}

				case 'openLink': {
					const { href } = message as { href: string };
					try { await vscode.env.openExternal(vscode.Uri.parse(href)); } catch { /* ignore */ }
					break;
				}

				case 'saveImage': {
					const { dataUrl, ext } = message as { dataUrl: string; ext: string };
					const rel = await this._saveImage(document, dataUrl, ext);
					await panel.webview.postMessage(rel ? { type: 'imageSaved', path: rel } : { type: 'imageError', message: 'failed to save image' });
					break;
				}

				case 'setConfig': {
					const patch = message.config as Partial<V1Config>;
					this.updateConfig(patch);
					break;
				}
			}
		});

		panel.onDidDispose(() => changeSub.dispose());
	}

	private async _saveImage(document: vscode.TextDocument, dataUrl: string, ext: string): Promise<string | undefined> {
		try {
			const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
			if (!match) { return undefined; }
			// `atob` is a global in both the webview host and Node >= 16; avoids an
			// extra `@types/node` dependency for a single base64 decode.
			const binary = atob(match[2]);
			const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));

			const baseDir = this._baseDirForDocument(document);
			const assetsDir = vscode.Uri.joinPath(baseDir, 'assets');
			await vscode.workspace.fs.createDirectory(assetsDir);

			const name = await this._uniqueName(assetsDir, 'image', ext);
			const fileUri = vscode.Uri.joinPath(assetsDir, name);
			await vscode.workspace.fs.writeFile(fileUri, bytes);
			return `assets/${name}`;
		} catch (e) {
			console.error('image save failed', e);
			return undefined;
		}
	}

	private _baseDirForDocument(document: vscode.TextDocument): vscode.Uri {
		if (document.uri.scheme === 'untitled' || document.uri.scheme !== 'file') {
			const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
			return folder ?? document.uri;
		}
		const dir = vscode.Uri.joinPath(document.uri, '..');
		return dir;
	}

	private async _uniqueName(dir: vscode.Uri, stem: string, ext: string): Promise<string> {
		const safeExt = /^[a-z0-9]+$/i.test(ext) ? ext : 'png';
		for (let i = 0; ; i++) {
			const name = i === 0 ? `${stem}.${safeExt}` : `${stem}-${i}.${safeExt}`;
			const uri = vscode.Uri.joinPath(dir, name);
			try {
				await vscode.workspace.fs.stat(uri);
			} catch {
				return name;
			}
		}
	}

	private _getHtml(webview: vscode.Webview, document: vscode.TextDocument): string {
		const nonce = this._nonce();
		const messageSecret = this._nonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'webview', 'editor.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'webview', 'editor.css'));
		const initialState = encodeURIComponent(JSON.stringify({
			content: document.getText(),
			documentVersion: document.version,
			readonly: false,
		}));

		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} data: https: http:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`font-src ${webview.cspSource} data:`,
			`script-src 'nonce-${nonce}'`,
			`connect-src ${webview.cspSource} data:`,
		].join('; ');

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta name="vscode-markdown-editor-message-secret" content="${messageSecret}">
	<meta name="vscode-markdown-editor-script-nonce" content="${nonce}">
	<meta id="vscode-markdown-editor-initial-state" content="${initialState}">
	<link rel="stylesheet" href="${styleUri}">
	<title>Markdown WYSIWYG V1</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
	}

	private _nonce(): string {
		let text = '';
		const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		for (let i = 0; i < 32; i++) { text += possible.charAt(Math.floor(Math.random() * possible.length)); }
		return text;
	}
}
