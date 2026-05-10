import { App, Modal, Notice, Vault, normalizePath } from 'obsidian';
import { BaseViewsSettings, QuickAddProfile, QuickAddProp } from './settings';
import BaseViewsPlugin from './main';

const DK = (d: Date): string => d.toISOString().slice(0, 10);
const DKT = (d: Date): string => d.toISOString().slice(0, 16);

async function ensureFolder(vault: Vault, folderPath: string): Promise<void> {
	const parts = folderPath.split('/').filter(Boolean);
	let built = '';
	for (const part of parts) {
		built = built ? `${built}/${part}` : part;
		if (!vault.getAbstractFileByPath(built)) {
			await vault.createFolder(built);
		}
	}
}

export class QuickAddModal extends Modal {
	constructor(
		app: App,
		private settings: BaseViewsSettings,
		private plugin: BaseViewsPlugin,
		private initialTitle?: string,
	) {
		super(app);
	}

	onOpen(): void {
		const profiles = this.settings.quickAddProfiles;
		this.contentEl.empty();

		if (profiles.length === 0) {
			this.renderNoProfiles();
		} else if (profiles.length === 1) {
			this.renderForm(profiles[0]);
		} else {
			this.renderProfileSelector(profiles);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderNoProfiles(): void {
		this.setTitle('Quick Add');
		this.contentEl.createEl('p', {
			text: 'No Quick Add profiles configured. Add one in Settings → Base Views → Quick Add.',
			cls: 'setting-item-description',
		});
		const btnRow = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const closeBtn = btnRow.createEl('button', { text: 'Close' });
		closeBtn.onclick = () => this.close();
	}

	private renderProfileSelector(profiles: QuickAddProfile[]): void {
		this.setTitle('Quick Add — choose profile');

		const select = this.contentEl.createEl('select', { cls: 'bv-qa-profile-select' });
		profiles.forEach(p => {
			const opt = select.createEl('option', { text: p.name });
			opt.value = p.id;
		});

		const btnRow = this.contentEl.createDiv({ cls: 'modal-button-container' });

		const next = btnRow.createEl('button', { text: 'Next', cls: 'mod-cta' });
		next.onclick = () => {
			const chosen = profiles.find(p => p.id === select.value) ?? profiles[0];
			this.contentEl.empty();
			this.renderForm(chosen);
		};

		const cancel = btnRow.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => this.close();
	}

	private resolveValue(prop: QuickAddProp): string {
		const type = prop.type ?? 'text';
		if (prop.value === 'today') {
			if (type === 'datetime') return DKT(new Date());
			return DK(new Date());
		}
		return prop.value;
	}

	private renderForm(profile: QuickAddProfile): void {
		this.setTitle(`Quick add — ${profile.name}`);
		const { contentEl } = this;

		const titleField = contentEl.createDiv({ cls: 'bv-qa-field' });
		titleField.createEl('label', { text: 'Note title' });
		const titleInput = titleField.createEl('input', { cls: 'bv-qa-input' });
		titleInput.type = 'text';
		titleInput.value = this.initialTitle ?? `Note ${DK(new Date())}`;
		titleInput.style.width = '100%';

		const propInputEls: { prop: QuickAddProp; input: HTMLInputElement | HTMLSelectElement }[] = [];
		profile.props.forEach(prop => {
			if (!prop.name) return;
			const type = prop.type ?? 'text';
			const fieldDiv = contentEl.createDiv({ cls: 'bv-qa-field' });
			fieldDiv.createEl('label', { text: prop.name });

			if (type === 'checkbox') {
				const inp = fieldDiv.createEl('input', { cls: 'bv-qa-input' });
				inp.type = 'checkbox';
				const resolved = this.resolveValue(prop);
				inp.checked = resolved === 'true' || resolved === '1';
				propInputEls.push({ prop, input: inp });
			} else if (type === 'date') {
				const inp = fieldDiv.createEl('input', { cls: 'bv-qa-input' });
				inp.type = 'date';
				const resolved = this.resolveValue(prop);
				inp.value = resolved;
				inp.style.width = '100%';
				propInputEls.push({ prop, input: inp });
			} else if (type === 'datetime') {
				const inp = fieldDiv.createEl('input', { cls: 'bv-qa-input' });
				inp.type = 'datetime-local';
				const resolved = this.resolveValue(prop);
				inp.value = resolved;
				inp.style.width = '100%';
				propInputEls.push({ prop, input: inp });
			} else {
				// text, number, list
				const inp = fieldDiv.createEl('input', { cls: 'bv-qa-input' });
				inp.type = type === 'number' ? 'number' : 'text';
				inp.value = this.resolveValue(prop);
				inp.style.width = '100%';
				if (type === 'list') inp.placeholder = 'Comma-separated values';
				propInputEls.push({ prop, input: inp });
			}
		});

		const submit = async () => {
			const titleVal = titleInput.value.trim();
			if (!titleVal) {
				new Notice('Note title cannot be empty.');
				return;
			}
			const resolvedProps: { name: string; value: string; type: string }[] = [];
			for (const { prop, input } of propInputEls) {
				const type = prop.type ?? 'text';
				let rawVal: string;
				if (type === 'checkbox') {
					rawVal = (input as HTMLInputElement).checked ? 'true' : 'false';
				} else {
					rawVal = (input as HTMLInputElement).value.trim();
				}
				if (type !== 'checkbox' && rawVal === '') continue;
				resolvedProps.push({ name: prop.name, value: rawVal, type });
			}
			await this.submitForm(profile, titleVal, resolvedProps);
		};

		const onEnter = (e: KeyboardEvent) => {
			if (e.key === 'Enter') { e.preventDefault(); submit(); }
		};
		titleInput.addEventListener('keydown', onEnter);
		propInputEls.forEach(({ input }) => input.addEventListener('keydown', onEnter));

		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		const ok = btnRow.createEl('button', { text: 'Create note', cls: 'mod-cta' });
		ok.onclick = submit;
		const cancel = btnRow.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => this.close();

		// Focus and select the title after the modal is fully rendered
		setTimeout(() => { titleInput.focus(); titleInput.select(); }, 0);
	}

	private formatValue(value: string, type: string): string {
		switch (type) {
			case 'number': {
				const n = parseFloat(value);
				return isNaN(n) ? value : String(n);
			}
			case 'checkbox':
				return value === 'true' ? 'true' : 'false';
			case 'date':
				return value; // already YYYY-MM-DD
			case 'datetime':
				return value; // already YYYY-MM-DDTHH:MM
			case 'list': {
				const items = value.split(',').map(s => s.trim()).filter(Boolean);
				if (items.length === 0) return '[]';
				return `[${items.map(i => `"${i}"`).join(', ')}]`;
			}
			default: {
				// text — quote if it looks like it needs it (contains colon, starts with special yaml chars)
				const needsQuotes = /[:#\[\]{},|>&*!%@`]/.test(value) || value.startsWith('"') || value === '';
				return needsQuotes ? `"${value.replace(/"/g, '\\"')}"` : value;
			}
		}
	}

	private async submitForm(
		profile: QuickAddProfile,
		title: string,
		resolvedProps: { name: string; value: string; type: string }[],
	): Promise<void> {
		try {
			const safeTitle = title.replace(/[\\/:*?"<>|]/g, '-');
			const folder = profile.folder.trim();

			let filePath = folder
				? normalizePath(`${folder}/${safeTitle}.md`)
				: normalizePath(`${safeTitle}.md`);

			// Collision avoidance
			let counter = 2;
			while (this.app.vault.getAbstractFileByPath(filePath)) {
				filePath = folder
					? normalizePath(`${folder}/${safeTitle} ${counter}.md`)
					: normalizePath(`${safeTitle} ${counter}.md`);
				counter++;
			}

			if (folder) {
				await ensureFolder(this.app.vault, folder);
			}

			let bodyContent = '';

			// Load template if configured
			if (profile.templateFile) {
				const tplFile = this.app.vault.getAbstractFileByPath(profile.templateFile);
				if (tplFile && 'extension' in tplFile) {
					try {
						bodyContent = await this.app.vault.read(tplFile as any);
					} catch {
						// ignore template read failure
					}
				}
			}

			const fmLines = resolvedProps.map(({ name, value, type }) => {
				const key = name.includes(' ') || name.includes('-') ? `"${name}"` : name;
				return `${key}: ${this.formatValue(value, type)}`;
			});

			let content: string;
			if (fmLines.length > 0) {
				// Check if template already has frontmatter
				const tplFmMatch = bodyContent.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/);
				if (tplFmMatch) {
					const existingFm = tplFmMatch[1];
					const body = tplFmMatch[2] ?? '';
					content = `---\n${existingFm}\n${fmLines.join('\n')}\n---\n${body}`;
				} else {
					content = `---\n${fmLines.join('\n')}\n---\n${bodyContent}`;
				}
			} else {
				content = bodyContent;
			}

			const newFile = await this.app.vault.create(filePath, content);
			this.close();
			this.app.workspace.getLeaf(false)?.openFile(newFile);
		} catch (err) {
			console.error('QuickAdd failed:', err);
			new Notice('Failed to create note. Check the console for details.');
		}
	}
}
