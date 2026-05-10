import { AbstractInputSuggest, App, TFile, TFolder } from 'obsidian';

export const AUTO_PALETTE = [
	'var(--color-blue)',
	'var(--color-purple)',
	'var(--color-green)',
	'var(--color-orange)',
	'var(--color-red)',
	'var(--color-yellow)',
	'var(--color-cyan)',
	'var(--color-pink)',
];

export function attachOverflowTitle(el: HTMLElement, text: string): void {
	if (text) el.title = text;
}

export class FolderSuggest extends AbstractInputSuggest<string> {
	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
	}
	getSuggestions(query: string): string[] {
		const lower = query.toLowerCase();
		const folders: string[] = [];
		const walk = (folder: TFolder) => {
			if (folder.path !== '/' && folder.path !== '') {
				folders.push(folder.path);
			}
			folder.children.forEach(child => { if (child instanceof TFolder) walk(child); });
		};
		walk(this.app.vault.getRoot());
		return folders.filter(f => f.toLowerCase().includes(lower)).slice(0, 30);
	}
	renderSuggestion(value: string, el: HTMLElement): void {
		el.textContent = value;
	}
	selectSuggestion(value: string): void {
		(this.inputEl as HTMLInputElement).value = value;
		this.inputEl.dispatchEvent(new Event('input'));
		this.close();
	}
}

export class FileSuggest extends AbstractInputSuggest<string> {
	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
	}
	getSuggestions(query: string): string[] {
		const lower = query.toLowerCase();
		return this.app.vault.getMarkdownFiles()
			.map(f => f.path)
			.filter(p => p.toLowerCase().includes(lower))
			.slice(0, 30);
	}
	renderSuggestion(value: string, el: HTMLElement): void {
		el.textContent = value;
	}
	selectSuggestion(value: string): void {
		(this.inputEl as HTMLInputElement).value = value;
		this.inputEl.dispatchEvent(new Event('input'));
		this.close();
	}
}

