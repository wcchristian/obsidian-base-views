import {
	BasesView, TFile, QueryController, HoverParent, HoverPopover, Keymap,
	BasesEntry, BasesPropertyId, parsePropertyId,
	Value, BooleanValue, StringValue, NumberValue, DateValue, TagValue, NullValue,
	Menu, Notice,
} from 'obsidian';
import { writeProp } from './frontmatter';

export const VIEW_TYPE_BASE_KANBAN = 'base-kanban-view';

const NULL_KEY = '(no value)';

interface KanbanCard {
	id: string;
	title: string;
	file: TFile;
	entry: BasesEntry;
	columnKey: string;
	subgroupKey: string;
	done: boolean;
}

export class BaseKanbanView extends BasesView implements HoverParent {
	readonly type = VIEW_TYPE_BASE_KANBAN;
	hoverPopover: HoverPopover | null = null;

	private wrap: HTMLElement;
	private bgLayer: HTMLElement | null = null;
	private colorMap: Map<string, string> = new Map();

	// drag state — cards
	private dragCardId: string | null = null;
	private dragCardSourceCol: string | null = null;
	private dragCardSourceSubgroup: string | null = null;
	private dropIndicator: HTMLElement | null = null;

	// drag state — columns
	private dragColKey: string | null = null;
	private dragColSubgroup: string | null = null;
	private colDropIndicator: HTMLElement | null = null;

	constructor(ctrl: QueryController, parent: HTMLElement) {
		super(ctrl);
		this.wrap = parent.createDiv('bk-wrap');
	}

	async onDataUpdated(): Promise<void> {
		this.colorMap = this.parseColorMap();
		this.wrap.empty();
		this.buildBoard();
	}

	// ── config helpers ──────────────────────────────────────────────────────

	private getHiddenColumns(): string[] {
		const v = this.config.get('hiddenColumns');
		return Array.isArray(v) ? v as string[] : [];
	}

	private getHiddenSubgroups(): string[] {
		const v = this.config.get('hiddenSubgroups');
		return Array.isArray(v) ? v as string[] : [];
	}

	private getCollapsedColumns(): string[] {
		const v = this.config.get('collapsedColumns');
		return Array.isArray(v) ? v as string[] : [];
	}

	private toggleCollapsed(key: string) {
		const collapsed = this.getCollapsedColumns();
		if (collapsed.includes(key)) {
			this.config.set('collapsedColumns', collapsed.filter(k => k !== key));
		} else {
			this.config.set('collapsedColumns', [...collapsed, key]);
		}
	}

	private getColumnOrder(): string[] {
		const v = this.config.get('columnOrder');
		return Array.isArray(v) ? v as string[] : [];
	}

	private getManualCardOrder(): Record<string, string[]> {
		const v = this.config.get('manualCardOrder');
		if (typeof v === 'string') {
			try { return JSON.parse(v); } catch { return {}; }
		}
		return {};
	}

	private async setManualCardOrder(order: Record<string, string[]>) {
		this.config.set('manualCardOrder', JSON.stringify(order));
	}

	private async setColumnOrder(order: string[]) {
		this.config.set('columnOrder', order);
	}

	private async hideColumn(key: string) {
		const hidden = this.getHiddenColumns();
		if (!hidden.includes(key)) this.config.set('hiddenColumns', [...hidden, key]);
	}

	private async hideSubgroup(key: string) {
		const hidden = this.getHiddenSubgroups();
		if (!hidden.includes(key)) this.config.set('hiddenSubgroups', [...hidden, key]);
	}

	// ── color helpers ───────────────────────────────────────────────────────

	private parseColorMap(): Map<string, string> {
		const v = this.config.get('columnColors');
		const lines = Array.isArray(v) ? v as string[] : [];
		const map = new Map<string, string>();
		for (const line of lines) {
			const idx = line.indexOf(':');
			if (idx === -1) continue;
			const key = line.slice(0, idx).trim();
			const color = line.slice(idx + 1).trim();
			if (key && color) map.set(key, color);
		}
		return map;
	}

	private getColumnColor(key: string): string | null {
		return this.colorMap.get(key) ?? null;
	}

	private setColumnColor(key: string, color: string) {
		const v = this.config.get('columnColors');
		const lines = Array.isArray(v) ? [...v as string[]] : [];
		const existingIdx = lines.findIndex(l => {
			const i = l.indexOf(':');
			return i !== -1 && l.slice(0, i).trim() === key;
		});
		const newLine = `${key}:${color}`;
		if (existingIdx !== -1) lines[existingIdx] = newLine;
		else lines.push(newLine);
		this.config.set('columnColors', lines);
	}

	private clearColumnColor(key: string) {
		const v = this.config.get('columnColors');
		const lines = Array.isArray(v) ? v as string[] : [];
		this.config.set('columnColors', lines.filter(l => {
			const i = l.indexOf(':');
			return i === -1 || l.slice(0, i).trim() !== key;
		}));
	}

	// ── column order helpers ────────────────────────────────────────────────

	private orderColumns(rawKeys: string[]): string[] {
		const saved = this.getColumnOrder();
		const seen = new Set<string>();
		const result: string[] = [];
		for (const k of saved) {
			if (rawKeys.includes(k)) { result.push(k); seen.add(k); }
		}
		for (const k of rawKeys) {
			if (!seen.has(k)) result.push(k);
		}
		return result;
	}

	private sortCardsInColumn(cards: KanbanCard[], bucketKey: string): KanbanCard[] {
		const order = this.getManualCardOrder();
		const ids = order[bucketKey];
		if (!ids?.length) return cards;
		const map = new Map(cards.map(c => [c.id, c]));
		const sorted: KanbanCard[] = [];
		for (const id of ids) {
			const c = map.get(id);
			if (c) { sorted.push(c); map.delete(id); }
		}
		for (const c of map.values()) sorted.push(c);
		return sorted;
	}

	// Read the base's groupBy property. The groupBy field is not part of
	// BasesViewConfig's public API, but we try two routes:
	// 1. config.get('groupBy') — reads the full underlying view config dict
	// 2. direct cast on the config object — in case it's exposed as an instance field
	// The on-disk shape is `groupBy: {}` (opaque), but in practice it carries
	// a `property` key (BasesPropertyId). We also handle the case where it's
	// stored as a plain string.
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

	private cardTitle(entry: BasesEntry): string {
		const titlePid = this.config.getAsPropertyId('cardTitleProperty');
		if (titlePid) {
			const v = entry.getValue(titlePid);
			if (v && !(v instanceof NullValue)) return v.toString();
		}
		if (entry.file instanceof TFile) return entry.file.basename;
		return 'Untitled';
	}

	private resolveBgUrl(raw: string): string {
		const trimmed = raw.trim();
		if (/^(https?:|data:|app:|file:)/i.test(trimmed)) return trimmed;
		const file = this.app.vault.getAbstractFileByPath(trimmed);
		if (file instanceof TFile) {
			return this.app.vault.adapter.getResourcePath(file.path);
		}
		return trimmed;
	}

	// ── build ───────────────────────────────────────────────────────────────

	private buildBoard() {
		const bgUrl = this.config.get('bgImage') as string | null;
		this.bgLayer = null;
		if (bgUrl && bgUrl.trim()) {
			const resolved = this.resolveBgUrl(bgUrl);
			this.bgLayer = this.wrap.createDiv('bk-bg-layer');
			this.bgLayer.style.backgroundImage = `url("${resolved}")`;
			const fit = (this.config.get('bgFit') as string) || 'cover';
			this.bgLayer.style.backgroundSize = fit === 'stretch' ? '100% 100%' : fit;
			const blur = this.config.get('bgBlur') as number | null;
			if (blur && blur > 0) this.bgLayer.style.filter = `blur(${blur}px)`;
			const opacity = this.config.get('bgOpacity') as number | null;
			this.bgLayer.style.opacity = String(opacity ?? 0.3);
		}

		const groups = this.data.groupedData;
		if (!groups?.length) {
			this.wrap.createDiv({ cls: 'bk-empty', text: 'No data' });
			return;
		}

		const subgroupPid = this.config.getAsPropertyId('subgroupProperty') ?? null;
		const donePid = this.config.getAsPropertyId('doneProperty') ?? null;
		const showEmpty = this.config.get('showEmptyColumns') !== false;
		const colorMode = (this.config.get('columnColorMode') as string) || 'header';
		const hiddenCols = new Set(this.getHiddenColumns());
		const hiddenSubs = new Set(this.getHiddenSubgroups());
		const collapsedCols = new Set(this.getCollapsedColumns());

		const allColKeysRaw: string[] = [];
		const colKeySet = new Set<string>();
		for (const g of groups) {
			const key = g.hasKey() && g.key != null ? g.key.toString() : NULL_KEY;
			if (!colKeySet.has(key)) { colKeySet.add(key); allColKeysRaw.push(key); }
		}
		const allColKeys = this.orderColumns(allColKeysRaw);
		const mergedOrder = this.orderColumns(allColKeysRaw);
		const savedOrder = this.getColumnOrder();
		if (JSON.stringify(mergedOrder) !== JSON.stringify(savedOrder)) {
			this.config.set('columnOrder', mergedOrder);
		}

		const makeCard = (entry: BasesEntry, colKey: string, sgKey: string): KanbanCard | null => {
			if (!(entry.file instanceof TFile)) return null;
			let done = false;
			if (donePid) {
				const dv = entry.getValue(donePid);
				if (dv instanceof BooleanValue) done = dv.isTruthy();
			}
			return { id: entry.file.path, title: this.cardTitle(entry), file: entry.file, entry, columnKey: colKey, subgroupKey: sgKey, done };
		};

		if (!subgroupPid) {
			const cards: KanbanCard[] = [];
			for (const g of groups) {
				const colKey = g.hasKey() && g.key != null ? g.key.toString() : NULL_KEY;
				for (const entry of g.entries) {
					const card = makeCard(entry, colKey, '');
					if (card) cards.push(card);
				}
			}
			this.renderBoard(this.wrap, '', allColKeys, cards, hiddenCols, collapsedCols, showEmpty, colorMode, donePid);
		} else {
			const subgroupOrder: string[] = [];
			const subgroupMap = new Map<string, Map<string, KanbanCard[]>>();

			for (const g of groups) {
				const colKey = g.hasKey() && g.key != null ? g.key.toString() : NULL_KEY;
				for (const entry of g.entries) {
					if (!(entry.file instanceof TFile)) continue;
					const sgVal = entry.getValue(subgroupPid);
					const sgKey = sgVal && !(sgVal instanceof NullValue) ? sgVal.toString() : NULL_KEY;
					if (!subgroupMap.has(sgKey)) { subgroupOrder.push(sgKey); subgroupMap.set(sgKey, new Map()); }
					const colMap = subgroupMap.get(sgKey)!;
					if (!colMap.has(colKey)) colMap.set(colKey, []);
					const card = makeCard(entry, colKey, sgKey);
					if (card) colMap.get(colKey)!.push(card);
				}
			}

			for (const sgKey of subgroupOrder) {
				if (hiddenSubs.has(sgKey)) continue;
				const section = this.wrap.createDiv('bk-section');
				const sHdr = section.createDiv('bk-section-hdr');
				sHdr.createSpan({ cls: 'bk-section-title', text: sgKey });
				const kebab = sHdr.createEl('button', { cls: 'bk-kebab', title: 'Options' });
				kebab.textContent = '⋮';
				kebab.addEventListener('click', (e) => {
					e.stopPropagation();
					const menu = new Menu();
					menu.addItem(i => i.setTitle('Hide sub-group').setIcon('eye-off').onClick(async () => { await this.hideSubgroup(sgKey); }));
					menu.showAtMouseEvent(e);
				});

				const colMap = subgroupMap.get(sgKey)!;
				const cards: KanbanCard[] = [];
				for (const [, colCards] of colMap) cards.push(...colCards);
				this.renderBoard(section, sgKey, allColKeys, cards, hiddenCols, collapsedCols, showEmpty, colorMode, donePid);
			}
		}
	}

	private renderBoard(
		container: HTMLElement,
		subgroupKey: string,
		allColKeys: string[],
		cards: KanbanCard[],
		hiddenCols: Set<string>,
		collapsedCols: Set<string>,
		showEmpty: boolean,
		colorMode: string,
		donePid: BasesPropertyId | null,
	) {
		const board = container.createDiv('bk-board');

		const byCol = new Map<string, KanbanCard[]>();
		for (const c of cards) {
			if (!byCol.has(c.columnKey)) byCol.set(c.columnKey, []);
			byCol.get(c.columnKey)!.push(c);
		}

		const visibleCols = allColKeys.filter(k => {
			if (hiddenCols.has(k)) return false;
			if (!showEmpty && !byCol.get(k)?.length) return false;
			return true;
		});

		const expandedCols = visibleCols.filter(k => !collapsedCols.has(k));
		const collapsedVisible = visibleCols.filter(k => collapsedCols.has(k));

		for (const colKey of expandedCols) {
			const rawCards = byCol.get(colKey) ?? [];
			const bucketKey = `${subgroupKey}||${colKey}`;
			const sorted = this.sortCardsInColumn(rawCards, bucketKey);
			this.renderColumn(board, colKey, sorted, subgroupKey, allColKeys, bucketKey, false, colorMode, donePid);
		}
		for (const colKey of collapsedVisible) {
			const rawCards = byCol.get(colKey) ?? [];
			const bucketKey = `${subgroupKey}||${colKey}`;
			this.renderColumn(board, colKey, rawCards, subgroupKey, allColKeys, bucketKey, true, colorMode, donePid);
		}
	}

	private renderColumn(
		board: HTMLElement,
		colKey: string,
		cards: KanbanCard[],
		subgroupKey: string,
		allColKeys: string[],
		bucketKey: string,
		collapsed: boolean,
		colorMode: string,
		donePid: BasesPropertyId | null,
	) {
		const color = this.getColumnColor(colKey);
		const col = board.createDiv(collapsed ? 'bk-col bk-col-collapsed' : 'bk-col');
		col.dataset.colKey = colKey;
		col.dataset.subgroupKey = subgroupKey;

		// Whole-column tint
		if (color && colorMode === 'column') {
			col.style.background = `color-mix(in srgb, ${color} 20%, var(--background-secondary))`;
		}

		// ── Header ──
		const hdr = col.createDiv('bk-col-hdr');
		if (color && (colorMode === 'header' || colorMode === 'both')) {
			hdr.style.borderTop = `4px solid ${color}`;
			hdr.style.background = `color-mix(in srgb, ${color} 30%, var(--background-secondary))`;
		} else if (color && colorMode === 'column') {
			hdr.style.background = `color-mix(in srgb, ${color} 22%, var(--background-secondary))`;
		}

		hdr.setAttribute('draggable', 'true');

		if (collapsed) {
			hdr.createSpan({ cls: 'bk-col-title', text: `${colKey} · ${cards.length}` });
		} else {
			const titleEl = hdr.createSpan({ cls: 'bk-col-title', text: colKey });
			titleEl.createSpan({ cls: 'bk-col-count', text: ` ${cards.length}` });
		}

		// ── Add card button ──
		if (!collapsed) {
			const addBtn = hdr.createEl('button', { cls: 'bk-add', title: 'Add card', text: '+' });
			addBtn.addEventListener('click', async (e) => {
				e.stopPropagation();
				const groupPid = this.getGroupByPropId();
				await this.createFileForView('Note', (fm: Record<string, unknown>) => {
					if (groupPid) {
						const { name } = parsePropertyId(groupPid);
						fm[name] = colKey === NULL_KEY ? '' : colKey;
					}
				});
			});
		}

		// ── Kebab ──
		const kebab = hdr.createEl('button', { cls: 'bk-kebab', title: 'Options' });
		kebab.textContent = '⋮';
		kebab.addEventListener('click', (e) => {
			e.stopPropagation();
			const menu = new Menu();
			const curOrder = this.getColumnOrder();
			const idx = curOrder.indexOf(colKey);

			menu.addItem(i => i
				.setTitle(collapsed ? 'Expand' : 'Collapse')
				.setIcon(collapsed ? 'maximize-2' : 'minimize-2')
				.onClick(() => { this.toggleCollapsed(colKey); })
			);
			menu.addSeparator();

			if (!collapsed) {
				menu.addItem(i => i.setTitle('Move left').setIcon('arrow-left').onClick(async () => {
					if (idx <= 0) return;
					const o = [...curOrder];
					[o[idx - 1], o[idx]] = [o[idx], o[idx - 1]];
					await this.setColumnOrder(o);
				}));
				menu.addItem(i => i.setTitle('Move right').setIcon('arrow-right').onClick(async () => {
					if (idx === -1 || idx >= curOrder.length - 1) return;
					const o = [...curOrder];
					[o[idx], o[idx + 1]] = [o[idx + 1], o[idx]];
					await this.setColumnOrder(o);
				}));
				menu.addSeparator();
			}

			menu.addItem(i => i.setTitle('Set color…').setIcon('palette').onClick(() => {
				const picker = document.createElement('input');
				picker.type = 'color';
				picker.value = color ?? '#3b82f6';
				picker.style.cssText = 'position:fixed;left:-200px;top:-200px;opacity:0;pointer-events:none;';
				document.body.appendChild(picker);
				const t = setTimeout(() => picker.remove(), 60000);
				picker.addEventListener('change', () => {
					clearTimeout(t);
					this.setColumnColor(colKey, picker.value);
					picker.remove();
				});
				picker.click();
			}));
			if (color) {
				menu.addItem(i => i.setTitle('Clear color').setIcon('x').onClick(() => {
					this.clearColumnColor(colKey);
				}));
			}
			menu.addSeparator();

			menu.addItem(i => i.setTitle('Hide column').setIcon('eye-off').onClick(async () => {
				await this.hideColumn(colKey);
			}));
			menu.showAtMouseEvent(e);
		});

		// Header drag (column reorder)
		hdr.addEventListener('dragstart', (e) => {
			e.stopPropagation();
			this.dragColKey = colKey;
			this.dragColSubgroup = subgroupKey;
			e.dataTransfer?.setData('text/plain', `col:${colKey}`);
			e.dataTransfer!.effectAllowed = 'move';
			setTimeout(() => col.addClass('bk-col-dragging'), 0);
		});
		hdr.addEventListener('dragend', () => {
			col.removeClass('bk-col-dragging');
			this.dragColKey = null;
			this.dragColSubgroup = null;
			this.removeColDropIndicator();
		});

		if (collapsed) {
			// Collapsed: whole column handles both card drops and col-reorder drops
			col.addEventListener('dragover', (e) => {
				if (this.dragCardId) {
					e.preventDefault();
					e.stopPropagation();
					e.dataTransfer!.dropEffect = 'move';
					col.addClass('bk-drop');
					return;
				}
				if (!this.dragColKey || this.dragColKey === colKey) return;
				e.preventDefault();
				e.dataTransfer!.dropEffect = 'move';
				this.positionColDropIndicator(e, board);
			});
			col.addEventListener('dragleave', (e) => {
				if (!col.contains(e.relatedTarget as Node)) {
					col.removeClass('bk-drop');
					this.removeColDropIndicator();
				}
			});
			col.addEventListener('drop', async (e) => {
				if (this.dragCardId) {
					e.preventDefault();
					e.stopPropagation();
					col.removeClass('bk-drop');
					const cardId = this.dragCardId;
					await this.moveCard(cardId, colKey, subgroupKey, this.dragCardSourceSubgroup ?? '');
					this.dragCardId = null;
					this.dragCardSourceCol = null;
					this.dragCardSourceSubgroup = null;
					return;
				}
				if (!this.dragColKey || this.dragColKey === colKey) return;
				e.preventDefault();
				this.removeColDropIndicator();
				await this.applyColReorder(this.dragColKey, colKey);
			});
		} else {
			// Expanded: col-reorder on col, card drops on body
			col.addEventListener('dragover', (e) => {
				if (!this.dragColKey || this.dragColKey === colKey) return;
				if (this.dragCardId) return;
				e.preventDefault();
				e.dataTransfer!.dropEffect = 'move';
				this.positionColDropIndicator(e, board);
			});
			col.addEventListener('dragleave', (e) => {
				if (!board.contains(e.relatedTarget as Node)) this.removeColDropIndicator();
			});
			col.addEventListener('drop', async (e) => {
				if (!this.dragColKey || this.dragColKey === colKey) return;
				if (this.dragCardId) return;
				e.preventDefault();
				this.removeColDropIndicator();
				await this.applyColReorder(this.dragColKey, colKey);
			});

			const body = col.createDiv('bk-col-body');
			for (const card of cards) {
				this.renderCard(body, card, bucketKey, donePid);
			}

			// Apply card border in 'both' mode
			if (color && colorMode === 'both') {
				for (const cardEl of Array.from(body.querySelectorAll('.bk-card')) as HTMLElement[]) {
					cardEl.style.borderLeft = `3px solid ${color}`;
				}
			}

			body.addEventListener('dragover', (e) => {
				if (!this.dragCardId) return;
				e.preventDefault();
				e.stopPropagation();
				e.dataTransfer!.dropEffect = 'move';
				col.addClass('bk-drop');
				this.positionCardDropIndicator(e, body);
			});
			body.addEventListener('dragleave', (e) => {
				if (!col.contains(e.relatedTarget as Node)) {
					col.removeClass('bk-drop');
					this.removeCardDropIndicator();
				}
			});
			body.addEventListener('drop', async (e) => {
				if (!this.dragCardId) return;
				e.preventDefault();
				e.stopPropagation();
				col.removeClass('bk-drop');

				const cardId = this.dragCardId;
				const srcCol = this.dragCardSourceCol;

				if (srcCol === colKey && this.dragCardSourceSubgroup === subgroupKey) {
					await this.reorderCard(cardId, body, bucketKey);
				} else {
					this.removeCardDropIndicator();
					await this.moveCard(cardId, colKey, subgroupKey, this.dragCardSourceSubgroup ?? '');
				}
				this.dragCardId = null;
				this.dragCardSourceCol = null;
				this.dragCardSourceSubgroup = null;
			});
		}
	}

	private renderCard(container: HTMLElement, card: KanbanCard, bucketKey: string, donePid: BasesPropertyId | null) {
		const el = container.createDiv('bk-card' + (card.done ? ' bk-card-done' : ''));
		el.dataset.cardId = card.id;

		const titleRow = el.createDiv('bk-card-title');

		// Done checkbox
		if (donePid) {
			const cb = titleRow.createDiv('bk-check' + (card.done ? ' bk-check-on' : ''));
			cb.addEventListener('click', async (e) => {
				e.preventDefault();
				e.stopPropagation();
				const newVal = !card.done;
				await writeProp(this.app.vault, card.file, donePid, newVal ? 'true' : 'false');
				card.done = newVal;
				el.toggleClass('bk-card-done', newVal);
				cb.toggleClass('bk-check-on', newVal);
			});
		}

		const link = titleRow.createEl('a', { text: card.title, cls: 'bk-card-link', href: '#' });
		link.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(e as MouseEvent));
			leaf?.openFile(card.file);
		});
		link.addEventListener('mouseover', (e) => {
			this.app.workspace.trigger('hover-link', {
				event: e, source: 'bases', hoverParent: this,
				targetEl: el, linktext: card.file.path,
			});
		});

		el.addEventListener('click', (e) => {
			if ((e.target as HTMLElement).closest('.bk-card-link, .bk-check')) return;
			e.preventDefault();
			e.stopPropagation();
			const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(e as MouseEvent));
			leaf?.openFile(card.file);
		});

		el.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.showCardMenu(e, card);
		});

		const propOrder = this.config.getOrder();
		if (propOrder.length) {
			const props = el.createDiv('bk-card-props');
			for (const pid of propOrder) {
				const { name } = parsePropertyId(pid);
				if (name === 'name') continue;
				if (donePid && pid === donePid) continue;
				const val = card.entry.getValue(pid);
				if (!val || val instanceof NullValue) continue;
				const row = props.createDiv('bk-prop-row');
				row.createSpan({ cls: 'bk-prop-label', text: this.config.getDisplayName(pid) + ': ' });
				this.renderPropVal(row, val, card, pid);
			}
		}

		el.setAttribute('draggable', 'true');
		el.addEventListener('dragstart', (e) => {
			e.stopPropagation();
			e.dataTransfer?.setData('text/plain', card.id);
			e.dataTransfer!.effectAllowed = 'move';
			this.dragCardId = card.id;
			this.dragCardSourceCol = card.columnKey;
			this.dragCardSourceSubgroup = card.subgroupKey;
			setTimeout(() => el.addClass('bk-dragging'), 0);
		});
		el.addEventListener('dragend', () => {
			el.removeClass('bk-dragging');
			this.dragCardId = null;
			this.dragCardSourceCol = null;
			this.dragCardSourceSubgroup = null;
			this.removeCardDropIndicator();
		});
	}

	private renderPropVal(parent: HTMLElement, val: Value, card: KanbanCard, pid: BasesPropertyId) {
		if (val instanceof BooleanValue) {
			const checked = val.isTruthy();
			const tog = parent.createEl('div', { cls: 'bk-toggle' + (checked ? ' bk-toggle-on' : '') });
			tog.createEl('div', { cls: 'bk-toggle-knob' });
			tog.addEventListener('click', async (e) => {
				e.stopPropagation();
				const newVal = !checked;
				await writeProp(this.app.vault, card.file, pid, newVal ? 'true' : 'false');
				tog.toggleClass('bk-toggle-on', newVal);
			});
		} else if (
			val instanceof StringValue || val instanceof NumberValue ||
			val instanceof TagValue || val instanceof DateValue
		) {
			const span = parent.createSpan({ cls: 'bk-prop-val', text: val.toString() });
			span.addEventListener('click', async (e) => {
				e.stopPropagation();
				const input = parent.createEl('input', { cls: 'bk-prop-input', type: 'text' });
				input.value = val.toString();
				span.style.display = 'none';
				input.focus();
				input.select();
				const commit = async () => {
					await writeProp(this.app.vault, card.file, pid, input.value);
					input.remove();
					span.style.display = '';
				};
				input.addEventListener('blur', commit);
				input.addEventListener('keydown', (ke) => {
					if (ke.key === 'Enter') { ke.preventDefault(); commit(); }
					if (ke.key === 'Escape') { input.remove(); span.style.display = ''; }
				});
			});
		} else {
			parent.createSpan({ cls: 'bk-prop-val', text: val.toString() });
		}
	}

	private showCardMenu(e: MouseEvent, card: KanbanCard) {
		const menu = new Menu();
		menu.addItem(i => i.setTitle('Open in new tab').setIcon('file-plus').onClick(() => {
			this.app.workspace.getLeaf('tab').openFile(card.file);
		}));
		menu.addItem(i => i.setTitle('Open to the right').setIcon('separator-vertical').onClick(() => {
			this.app.workspace.getLeaf('split').openFile(card.file);
		}));
		menu.addItem(i => i.setTitle('Reveal in file explorer').setIcon('folder-open').onClick(() => {
			this.app.workspace.trigger('file-menu', card.file, e);
		}));
		menu.addSeparator();
		menu.addItem(i => i.setTitle('Delete').setIcon('trash').setWarning(true).onClick(async () => {
			await this.app.fileManager.trashFile(card.file);
			new Notice(`Trashed "${card.title}"`);
		}));
		menu.showAtMouseEvent(e);
	}

	// ── DnD helpers ─────────────────────────────────────────────────────────

	private positionCardDropIndicator(e: DragEvent, body: HTMLElement) {
		if (!this.dropIndicator) {
			this.dropIndicator = document.createElement('div');
			this.dropIndicator.className = 'bk-drop-line';
		}
		const cards = Array.from(body.querySelectorAll('.bk-card')) as HTMLElement[];
		let before: HTMLElement | null = null;
		for (const c of cards) {
			const rect = c.getBoundingClientRect();
			if (e.clientY < rect.top + rect.height / 2) { before = c; break; }
		}
		if (before) body.insertBefore(this.dropIndicator, before);
		else body.appendChild(this.dropIndicator);
	}

	private removeCardDropIndicator() {
		this.dropIndicator?.parentNode?.removeChild(this.dropIndicator);
	}

	private positionColDropIndicator(e: DragEvent, board: HTMLElement) {
		if (!this.colDropIndicator) {
			this.colDropIndicator = document.createElement('div');
			this.colDropIndicator.className = 'bk-col-drop-line';
		}
		const cols = Array.from(board.querySelectorAll('.bk-col')) as HTMLElement[];
		let before: HTMLElement | null = null;
		for (const c of cols) {
			const rect = c.getBoundingClientRect();
			if (e.clientX < rect.left + rect.width / 2) { before = c; break; }
		}
		if (before) board.insertBefore(this.colDropIndicator, before);
		else board.appendChild(this.colDropIndicator);
	}

	private removeColDropIndicator() {
		this.colDropIndicator?.parentNode?.removeChild(this.colDropIndicator);
	}

	private async applyColReorder(fromKey: string, toKey: string) {
		const order = this.getColumnOrder();
		const fromIdx = order.indexOf(fromKey);
		const toIdx = order.indexOf(toKey);
		if (fromIdx === -1 || toIdx === -1) return;
		const newOrder = [...order];
		newOrder.splice(fromIdx, 1);
		newOrder.splice(toIdx, 0, fromKey);
		await this.setColumnOrder(newOrder);
	}

	private async reorderCard(cardId: string, body: HTMLElement, bucketKey: string) {
		const cards = Array.from(body.querySelectorAll('.bk-card')) as HTMLElement[];
		const indicatorIdx = this.dropIndicator
			? Array.from(body.children).indexOf(this.dropIndicator)
			: cards.length;
		this.removeCardDropIndicator();

		const ids = cards.map(c => c.dataset.cardId ?? '').filter(Boolean);
		const fromIdx = ids.indexOf(cardId);
		if (fromIdx === -1) return;

		const before = cards.slice(0, indicatorIdx).filter(c => c !== this.dropIndicator);
		let toIdx = before.length;
		if (toIdx > fromIdx) toIdx--;
		if (fromIdx === toIdx) return;

		ids.splice(fromIdx, 1);
		ids.splice(toIdx, 0, cardId);

		const order = this.getManualCardOrder();
		order[bucketKey] = ids;
		await this.setManualCardOrder(order);
	}

	private async moveCard(
		cardId: string,
		newColKey: string,
		newSubgroupKey: string,
		srcSubgroupKey: string,
	) {
		const groupByPid = this.getGroupByPropId();
		if (!groupByPid) {
			new Notice('Set a Group By on this base to enable drag-and-drop between columns.');
			return;
		}
		const file = this.app.vault.getFileByPath(cardId);
		if (!file) return;
		try {
			await writeProp(this.app.vault, file, groupByPid, newColKey === NULL_KEY ? '' : newColKey);
			if (newSubgroupKey !== srcSubgroupKey) {
				const subgroupPid = this.config.getAsPropertyId('subgroupProperty');
				if (subgroupPid) {
					await writeProp(this.app.vault, file, subgroupPid, newSubgroupKey === NULL_KEY ? '' : newSubgroupKey);
				}
			}
		} catch (err) {
			console.error(err);
			new Notice('Failed to update frontmatter');
		}
	}
}
