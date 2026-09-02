import * as vscode from 'vscode';
import { MarkdownWysiwygProvider } from './markdownEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
	const provider = MarkdownWysiwygProvider.register(context);
	context.subscriptions.push(provider);
	context.subscriptions.push(...registerCommands(context, provider as unknown as MarkdownWysiwygProvider));
}

function registerCommands(context: vscode.ExtensionContext, provider: MarkdownWysiwygProvider): vscode.Disposable[] {
	const clamp = (n: number) => Math.max(60, Math.min(200, n));
	const zoom = (delta: number) => provider.updateConfig({ zoom: clamp(provider.config.zoom + delta) });
	const widthPresets: { label: string; value: 'narrow' | 'normal' | 'wide' | 'full'; detail: string }[] = [
		{ label: 'Narrow (680px)', value: 'narrow', detail: '680px max width' },
		{ label: 'Normal (820px)', value: 'normal', detail: '820px max width' },
		{ label: 'Wide (1000px)', value: 'wide', detail: '1000px max width' },
		{ label: 'Full', value: 'full', detail: 'no max width' },
	];

	return [
		vscode.commands.registerCommand('mdwysiwyg.zoomIn', () => zoom(10)),
		vscode.commands.registerCommand('mdwysiwyg.zoomOut', () => zoom(-10)),
		vscode.commands.registerCommand('mdwysiwyg.zoomReset', () => provider.updateConfig({ zoom: 100 })),
		vscode.commands.registerCommand('mdwysiwyg.toggleTypewriter', () => provider.updateConfig({ typewriter: !provider.config.typewriter })),
		vscode.commands.registerCommand('mdwysiwyg.toggleOutline', () => provider.updateConfig({ outline: !provider.config.outline })),
		vscode.commands.registerCommand('mdwysiwyg.setWidth', async () => {
			const pick = await vscode.window.showQuickPick(widthPresets, { placeHolder: 'Select content width' });
			if (pick) { provider.updateConfig({ contentWidth: pick.value }); }
		}),
	];
}

export function deactivate(): void { /* no-op */ }
