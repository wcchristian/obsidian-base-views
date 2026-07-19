import { App, TFile, Vault, normalizePath } from 'obsidian';

export async function ensureFolder(vault: Vault, folderPath: string): Promise<void> {
	const parts = folderPath.split('/').filter(Boolean);
	let built = '';
	for (const part of parts) {
		built = built ? `${built}/${part}` : part;
		if (!vault.getAbstractFileByPath(built)) {
			await vault.createFolder(built);
		}
	}
}

function formatYamlValue(value: unknown): string {
	if (value === null || value === undefined || value === '') return '';
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		return `[${value.map(v => `"${String(v).replace(/"/g, '\\"')}"`).join(', ')}]`;
	}
	const s = String(value);
	const needsQuotes = /[:#\[\]{},|>&*!%@`]/.test(s) || s.startsWith('"');
	return needsQuotes ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/**
 * Create a markdown note in `folder` (vault root when empty) with the given
 * frontmatter. Empty-string values become empty stub entries (`key:`).
 * Handles filename sanitizing, collision avoidance, and folder creation.
 */
export async function createNoteInFolder(
	app: App,
	folder: string,
	title: string,
	frontmatter: Record<string, unknown>,
): Promise<TFile> {
	const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Untitled';
	const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, '');

	let filePath = cleanFolder
		? normalizePath(`${cleanFolder}/${safeTitle}.md`)
		: normalizePath(`${safeTitle}.md`);

	let counter = 2;
	while (app.vault.getAbstractFileByPath(filePath)) {
		filePath = cleanFolder
			? normalizePath(`${cleanFolder}/${safeTitle} ${counter}.md`)
			: normalizePath(`${safeTitle} ${counter}.md`);
		counter++;
	}

	if (cleanFolder) {
		await ensureFolder(app.vault, cleanFolder);
	}

	const fmLines = Object.entries(frontmatter).map(([name, value]) => {
		const key = name.includes(' ') || name.includes('-') ? `"${name}"` : name;
		return `${key}: ${formatYamlValue(value)}`.trimEnd();
	});

	const content = fmLines.length ? `---\n${fmLines.join('\n')}\n---\n` : '';
	return app.vault.create(filePath, content);
}
