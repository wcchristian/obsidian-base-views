import {
	BasesView, TFile, QueryController, HoverParent, HoverPopover, Keymap,
	BasesEntry, BasesPropertyId, parsePropertyId,
	Value, BooleanValue, StringValue, NumberValue, DateValue, TagValue, NullValue,
	Menu, Notice,
} from 'obsidian';
import BaseViewsPlugin from './main';
import { writeProp } from './frontmatter';
import { AUTO_PALETTE } from './util';
import { QuickAddModal } from './quick-add-modal';

export const VIEW_TYPE_BASE_LIST = 'base-list-view';

const NULL_KEY = '(no value)';

interface ListItem {
	id: string;
	title: string;
	file: TFile;
	entry: BasesEntry;
	done: boolean;
}

export class BaseListView extends BasesView implements HoverParent {
	readonly type = VIEW_TYPE_BASE_LIST;
	hoverPopover: HoverPopover | null = null;

	private wrap: HTMLElement;
	private bgLayer: HTMLElement | null = null;
	private plugin: BaseViewsPlugin;

	private doneProp: BasesPropertyId | null = null;
	private sortOrderProp: BasesPropertyId | null = null;
	private colorMap: Map<string, string> = new Map();
	private autoColorMap: Map<string, string> = new Map();

	private dragId: string | null = null;
	private dragGroupKey: string | null = null;
	private dropIndicator: HTMLElement | null = null;

	constructor(ctrl: QueryController, parent: HTMLElement, plugin: BaseViewsPlugin) {
		super(ctrl);
		this.plugin = plugin;
		this.wrap = parent.createDiv('bv-list-wrap');
	}

	async onDataUpdated(): Promise<void> {
		this.doneProp = this.config.getAsPropertyId('doneProperty') ?? null;
		this.sortOrderProp = this.config.getAsPropertyId('sortOrderProperty') ?? null;
		this.colorMap = this.parseColorMap();

		// Build auto-color map when colorProperty set but no colorValues configured
		this.autoColorMap = new Map();
		if (this.colorMap.size === 0) {
			const raw = (this.config.get('colorProperty') as string | undefined)?.trim() ?? '';
			const propName = raw.startsWith('note.') ? raw.slice(5) : raw;
			if (propName) {
				const pid = `note.${propName}` as BasesPropertyId;
				const groups = this.data.groupedData ?? [];
				const uniqueVals = [...new Set(
					groups.flatMap(g => [...g.entries])
						.map(e => e.getValue(pid))
						.filter((v): v is NonNullable<typeof v> => !!v && !(v instanceof NullValue))
						.map(v => v.toString().trim())
						.filter(Boolean),
				)].sort();
				uniqueVals.forEach((v, i) => this.autoColorMap.set(v, AUTO_PALETTE[i % AUTO_PALETTE.length]));
			}
		}

		this.wrap.empty();
		this.bgLayer = null;
		this.buildBackground();
		this.buildList();
	}

	// ── background ───────────────────────────────────────────────────────────

	private buildBackground() {
		const bgUrl = this.config.get('bgImage') as string | null;
		if (!bgUrl?.trim()) return;
		const resolved = this.resolveBgUrl(bgUrl);
		this.bgLayer = this.wrap.createDiv('bv-list-bg-layer');
		this.bgLayer.style.backgroundImage = `url("${resolved}")`;
		const fit = (this.config.get('bgFit') as string) || 'cover';
		this.bgLayer.style.backgroundSize = fit === 'stretch' ? '100% 100%' : fit;
		const blur = this.config.get('bgBlur') as number | null;
		if (blur && blur > 0) this.bgLayer.style.filter = `blur(${blur}px)`;
		const opacity = this.config.get('bgOpacity') as number | null;
		this.bgLayer.style.opacity = String(opacity ?? 0.3);
	}

	private resolveBgUrl(raw: string): string {
		const trimmed = raw.trim();
		if (/^(https?:|data:|app:|file:)/i.test(trimmed)) return trimmed;
		const file = this.app.vault.getAbstractFileByPath(trimmed);
		if (file instanceof TFile) return this.app.vault.adapter.getResourcePath(file.path);
		return trimmed;
	}

	// ── color helpers ────────────────────────────────────────────────────────

	private parseColorMap(): Map<string, string> {
		const v = this.config.get('colorValues');
		const lines = Array.isArray(v) ? v as string[] : [];
		const map = new Map<string, string>();
		for (const line of lines) {
			const i = line.lastIndexOf(':');
			if (i <= 0) continue;
			map.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
		}
		return map;
	}

	private getItemColor(item: ListItem): string | null {
		const raw = (this.config.get('colorProperty') as string | undefined)?.trim();
		if (!raw) return null;
		const propName = raw.startsWith('note.') ? raw.slice(5) : raw;
		const pid = `note.${propName}` as BasesPropertyId;
		const val = item.entry.getValue(pid);
		if (!val || val instanceof NullValue) return null;
		const valStr = val.toString().trim();
		return this.colorMap.get(valStr) ?? this.autoColorMap.get(valStr) ?? null;
	}

	// ── groupBy helper (same as kanban) ──────────────────────────────────────

	private getGroupByPropId(): BasesPropertyId | null {
		const extract = (v: unknown): BasesPropertyId | null => {
			if (typeof v === 'string' && v) return v as BasesPropertyId;
			if (v && typeof v === 'object') {
				const p = (v as Record<string, unknown>).property;
				if (typeof p === 'string' && p) return p as BasesPropertyId;
			}
			return null;
		};
		return extract(this.config.get('groupBy'))
			?? extract((this.config as unknown as Record<string, unknown>).groupBy);
	}

	// ── build ────────────────────────────────────────────────────────────────

	private buildList() {
		const groups = this.data.groupedData;
		const isGrouped = groups && groups.length > 0 && groups.some(g => g.hasKey() && g.key != null);

		if (!groups?.length) {
			this.wrap.createDiv({ cls: 'bv-list-empty', text: 'No data' });
			return;
		}

		if (!isGrouped) {
			const listEl = this.wrap.createDiv('bv-list-ungrouped');
			const items = this.collectItems(groups.flatMap(g => [...g.entries]));
			items.forEach(item => this.makeRow(listEl, item, NULL_KEY));
			this.makeAddButton(this.wrap, NULL_KEY);
			this.attachListDropTarget(listEl, NULL_KEY);
			return;
		}

		for (const group of groups) {
			const groupKey = group.hasKey() && group.key != null ? group.key.toString() : NULL_KEY;
			const section = this.wrap.createDiv('bv-list-group');

			const header = section.createDiv('bv-list-group-header');
			const label = header.createDiv('bv-list-group-label');
			label.textContent = groupKey === NULL_KEY ? '—' : groupKey;
			label.title = groupKey === NULL_KEY ? '—' : groupKey;
			const addBtn = header.createEl('button', {
				cls: 'bv-list-add',
				attr: { 'aria-label': `Add note in "${groupKey}"`, title: `Add note in "${groupKey}"`, type: 'button' },
			});
			addBtn.innerHTML = plusSvg();
			addBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); this.createListItem(groupKey); };

			const listEl = section.createDiv('bv-list-items');
			const items = this.collectItems([...group.entries]);
			items.forEach(item => this.makeRow(listEl, item, groupKey));
			this.attachListDropTarget(listEl, groupKey);
		}
	}

	private collectItems(entries: BasesEntry[]): ListItem[] {
		const items: ListItem[] = entries
			.filter(e => e.file instanceof TFile)
			.map(e => {
				const file = e.file as TFile;
				let done = false;
				if (this.doneProp) {
					const dv = e.getValue(this.doneProp);
					if (dv instanceof BooleanValue) done = dv.isTruthy();
				}
				return { id: file.path, title: file.basename, file, entry: e, done };
			});

		if (this.sortOrderProp) {
			const sp = this.sortOrderProp;
			return [...items].sort((a, b) => {
				const av = a.entry.getValue(sp);
				const bv = b.entry.getValue(sp);
				const an = av && !(av instanceof NullValue) ? Number(av.toString()) : Infinity;
				const bn = bv && !(bv instanceof NullValue) ? Number(bv.toString()) : Infinity;
				return an - bn;
			});
		}
		return items;
	}

	// ── row rendering ────────────────────────────────────────────────────────

	private makeRow(container: HTMLElement, item: ListItem, groupKey: string) {
		const row = container.createDiv('bv-list-row' + (item.done ? ' bv-list-row-done' : ''));
		row.dataset.itemId = item.id;

		const color = this.getItemColor(item);
		if (color) {
			row.style.borderLeft = `3px solid ${color}`;
			row.style.background = `color-mix(in srgb, ${color} 12%, var(--background-primary))`;
		}

		const titleRow = row.createDiv('bv-list-row-title');

		if (this.doneProp) {
			const cb = titleRow.createDiv('bv-list-check' + (item.done ? ' bv-list-check-on' : ''));
			cb.onclick = async e => {
				e.preventDefault();
				e.stopPropagation();
				const newVal = !item.done;
				await writeProp(this.app.vault, item.file, this.doneProp!, newVal ? 'true' : 'false');
				item.done = newVal;
				row.toggleClass('bv-list-row-done', newVal);
				cb.toggleClass('bv-list-check-on', newVal);
			};
		}

		const link = titleRow.createEl('a', { text: item.title, cls: 'bv-list-row-link', href: '#' });
		link.title = item.title;
		link.onclick = e => {
			e.preventDefault();
			e.stopPropagation();
			const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(e as MouseEvent));
			leaf?.openFile(item.file);
		};
		link.onmouseover = e => {
			this.app.workspace.trigger('hover-link', { event: e, source: 'bases', hoverParent: this, targetEl: row, linktext: item.file.path });
		};

		row.onclick = e => {
			if ((e.target as HTMLElement).closest('.bv-list-check')) return;
			e.preventDefault();
			e.stopPropagation();
			const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(e as MouseEvent));
			leaf?.openFile(item.file);
		};

		if (color) {
			row.addEventListener('mouseenter', () => {
				row.style.background = `color-mix(in srgb, ${color} 22%, var(--background-primary))`;
			});
			row.addEventListener('mouseleave', () => {
				row.style.background = `color-mix(in srgb, ${color} 12%, var(--background-primary))`;
			});
		}

		row.addEventListener('contextmenu', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showContextMenu(e, item);
		});

		const props = row.createDiv('bv-list-row-props');
		this.config.getOrder().forEach(pid => {
			const { name } = parsePropertyId(pid);
			if (name === 'name') return;
			if (this.doneProp && pid === this.doneProp) return;
			const val = item.entry.getValue(pid);
			if (!val || val instanceof NullValue) return;
			const propRow = props.createDiv('bv-list-prop-row');
			propRow.createSpan({ cls: 'bv-list-prop-label', text: this.config.getDisplayName(pid) + ': ' });
			this.renderPropVal(propRow, val, item, pid);
		});

		row.setAttribute('draggable', 'true');
		row.addEventListener('dragstart', e => {
			e.dataTransfer?.setData('text/plain', item.id);
			e.dataTransfer!.effectAllowed = 'move';
			this.dragId = item.id;
			this.dragGroupKey = groupKey;
			setTimeout(() => row.addClass('bv-list-row-dragging'), 0);
		});
		row.addEventListener('dragend', () => {
			row.removeClass('bv-list-row-dragging');
			this.dragId = null;
			this.dragGroupKey = null;
			this.removeDropIndicator();
		});
	}

	private renderPropVal(parent: HTMLElement, val: Value, item: ListItem, pid: BasesPropertyId) {
		if (val instanceof BooleanValue) {
			const checked = val.isTruthy();
			const tog = parent.createEl('div', { cls: 'bc-toggle' + (checked ? ' bc-toggle-on' : '') });
			tog.createEl('div', { cls: 'bc-toggle-knob' });
			tog.onclick = async e => {
				e.stopPropagation();
				const newVal = !checked;
				await writeProp(this.app.vault, item.file, pid, newVal ? 'true' : 'false');
				tog.toggleClass('bc-toggle-on', newVal);
			};
		} else if (val instanceof StringValue || val instanceof NumberValue || val instanceof TagValue || val instanceof DateValue) {
			const span = parent.createSpan({ cls: 'bc-prop-val', text: val.toString() });
			span.onclick = async e => {
				e.stopPropagation();
				const input = parent.createEl('input', { cls: 'bc-prop-input', value: val.toString(), type: 'text' });
				span.style.display = 'none';
				input.focus();
				input.select();
				const commit = async () => {
					await writeProp(this.app.vault, item.file, pid, input.value);
					input.remove();
					span.style.display = '';
				};
				input.onblur = commit;
				input.onkeydown = ev => {
					if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
					if (ev.key === 'Escape') { input.remove(); span.style.display = ''; }
				};
			};
		} else {
			parent.createSpan({ cls: 'bc-prop-val', text: val.toString() });
		}
	}

	// ── drag-and-drop ────────────────────────────────────────────────────────

	private positionDropIndicator(e: DragEvent, listEl: HTMLElement) {
		if (!this.dropIndicator) {
			this.dropIndicator = document.createElement('div');
			this.dropIndicator.className = 'bv-list-drop-indicator';
		}
		const rows = Array.from(listEl.querySelectorAll('.bv-list-row')) as HTMLElement[];
		let before: HTMLElement | null = null;
		for (const r of rows) {
			const rect = r.getBoundingClientRect();
			if (e.clientY < rect.top + rect.height / 2) { before = r; break; }
		}
		if (before) listEl.insertBefore(this.dropIndicator, before);
		else listEl.appendChild(this.dropIndicator);
	}

	private removeDropIndicator() {
		if (this.dropIndicator?.parentNode) {
			this.dropIndicator.parentNode.removeChild(this.dropIndicator);
		}
	}

	private attachListDropTarget(listEl: HTMLElement, groupKey: string) {
		listEl.addEventListener('dragover', e => {
			e.preventDefault();
			e.dataTransfer!.dropEffect = 'move';
			listEl.addClass('bv-list-drop');
			this.positionDropIndicator(e, listEl);
		});
		listEl.addEventListener('dragleave', e => {
			if (!listEl.contains(e.relatedTarget as Node)) {
				listEl.removeClass('bv-list-drop');
				this.removeDropIndicator();
			}
		});
		listEl.addEventListener('drop', async e => {
			e.preventDefault();
			listEl.removeClass('bv-list-drop');
			const id = e.dataTransfer?.getData('text/plain');
			if (!id) { this.removeDropIndicator(); return; }

			if (this.dragGroupKey === groupKey) {
				await this.reorderItems(id, listEl);
			} else {
				this.removeDropIndicator();
				await this.moveItemToGroup(id, groupKey);
			}
			this.dragId = null;
			this.dragGroupKey = null;
		});
	}

	private async reorderItems(dragId: string, listEl: HTMLElement) {
		if (!this.sortOrderProp) {
			this.removeDropIndicator();
			new Notice('Set a "Sort order property" on this view to enable drag-and-drop reordering.');
			return;
		}

		const allChildren = Array.from(listEl.children) as HTMLElement[];
		const indicatorIdx = this.dropIndicator
			? allChildren.indexOf(this.dropIndicator)
			: allChildren.length;
		this.removeDropIndicator();

		const rows = Array.from(listEl.querySelectorAll('.bv-list-row')) as HTMLElement[];
		const ids = rows.map(r => r.dataset.itemId ?? '').filter(Boolean);
		const fromIdx = ids.indexOf(dragId);
		if (fromIdx === -1) return;

		const rowsBefore = allChildren.slice(0, indicatorIdx).filter(r => r.classList.contains('bv-list-row'));
		let toIdx = rowsBefore.length;
		if (toIdx > fromIdx) toIdx--;

		ids.splice(fromIdx, 1);
		ids.splice(toIdx, 0, dragId);

		const sp = this.sortOrderProp;
		for (let i = 0; i < ids.length; i++) {
			const file = this.app.vault.getFileByPath(ids[i]);
			if (file) await writeProp(this.app.vault, file, sp, String(i * 10));
		}
	}

	private async moveItemToGroup(itemId: string, newGroupKey: string) {
		const groupByPid = this.getGroupByPropId();
		if (!groupByPid) {
			new Notice('Set a Group By on this base to enable drag-and-drop between groups.');
			return;
		}
		const file = this.app.vault.getFileByPath(itemId);
		if (!file) return;
		try {
			await writeProp(this.app.vault, file, groupByPid, newGroupKey === NULL_KEY ? '' : newGroupKey);
		} catch (err) {
			console.error(err);
			new Notice('Failed to update frontmatter');
		}
	}

	// ── context menu ─────────────────────────────────────────────────────────

	private showContextMenu(e: MouseEvent, item: ListItem) {
		const menu = new Menu();
		menu.addItem(i => i.setTitle('Open in new tab').setIcon('file-plus').onClick(() => {
			this.app.workspace.getLeaf('tab').openFile(item.file);
		}));
		menu.addItem(i => i.setTitle('Open to the right').setIcon('separator-vertical').onClick(() => {
			this.app.workspace.getLeaf('split').openFile(item.file);
		}));
		menu.addSeparator();
		menu.addItem(i => i.setTitle('Duplicate').setIcon('copy').onClick(async () => {
			await this.duplicateItem(item);
		}));
		menu.addSeparator();
		menu.addItem(i => i.setTitle('Delete').setIcon('trash').setWarning(true).onClick(async () => {
			await this.app.fileManager.trashFile(item.file);
			new Notice(`Trashed "${item.title}"`);
		}));
		menu.showAtMouseEvent(e);
	}

	private async duplicateItem(item: ListItem) {
		const dir = item.file.parent?.path ?? '';
		let base = `${item.file.basename} (copy)`;
		let path = dir ? `${dir}/${base}.md` : `${base}.md`;
		let i = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			base = `${item.file.basename} (copy ${i++})`;
			path = dir ? `${dir}/${base}.md` : `${base}.md`;
		}
		try {
			const newFile = await this.app.vault.copy(item.file, path);
			this.app.workspace.getLeaf(false)?.openFile(newFile);
		} catch (err) {
			console.error(err);
			new Notice('Failed to duplicate');
		}
	}

	// ── quick add ────────────────────────────────────────────────────────────

	private makeAddButton(parent: HTMLElement, groupKey: string) {
		const btn = parent.createEl('button', {
			cls: 'bv-list-add bv-list-add-footer',
			attr: { 'aria-label': 'Add note', title: 'Add note', type: 'button' },
		});
		btn.innerHTML = plusSvg() + ' <span>Add note</span>';
		btn.onclick = e => { e.preventDefault(); e.stopPropagation(); this.createListItem(groupKey); };
	}

	private createListItem(_groupKey: string) {
		new QuickAddModal(this.app, this.plugin.settings, this.plugin).open();
	}
}

function plusSvg(): string {
	return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
}
