import {
	BasesView, TFile, QueryController, HoverParent, HoverPopover, Keymap,
	BasesEntry, BasesPropertyId, parsePropertyId,
	Value, BooleanValue, StringValue, NumberValue, DateValue, TagValue, NullValue, ListValue,
	Menu, Notice,
} from 'obsidian';
import Sortable from 'sortablejs';
import { writeProp } from './frontmatter';
import { createNoteInFolder } from './create-note';
import { AUTO_PALETTE } from './util';
import BaseViewsPlugin from './main';

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
	private autoColorMap: Map<string, string> = new Map();

	// SortableJS drag-and-drop state
	private sortables: Sortable[] = [];
	// Per-instance group name so two open kanban panes can't cross-drag
	private readonly cardGroup = 'bk-cards-' + Math.random().toString(36).slice(2);
	private isDragging = false;
	private pendingRefresh = false;

	// pending inline-add ghost card (survives re-renders)
	private pendingGhost: { colKey: string; subgroupKey: string; text: string } | null = null;

	constructor(ctrl: QueryController, parent: HTMLElement, private plugin: BaseViewsPlugin) {
		super(ctrl);
		this.wrap = parent.createDiv('bk-wrap');
	}

	async onDataUpdated(): Promise<void> {
		// Never rebuild the DOM mid-drag: Sortable is tracking live nodes.
		if (this.isDragging) {
			this.pendingRefresh = true;
			return;
		}
		this.destroySortables();
		this.colorMap = this.parseColorMap();
		this.wrap.empty();
		this.buildBoard();
	}

	private destroySortables() {
		for (const s of this.sortables) {
			try { s.destroy(); } catch { /* node already detached */ }
		}
		this.sortables = [];
	}

	onunload() {
		this.destroySortables();
		super.onunload();
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
		return this.colorMap.get(key) ?? this.autoColorMap.get(key) ?? null;
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

	private getSortOrderProp(): BasesPropertyId | null {
		return this.config.getAsPropertyId('sortOrderProperty') ?? null;
	}

	private sortCardsInColumn(cards: KanbanCard[], bucketKey: string): KanbanCard[] {
		const sortProp = this.getSortOrderProp();
		if (sortProp) {
			return [...cards].sort((a, b) => {
				const av = a.entry.getValue(sortProp);
				const bv = b.entry.getValue(sortProp);
				const an = av && !(av instanceof NullValue) ? Number(av.toString()) : Infinity;
				const bn = bv && !(bv instanceof NullValue) ? Number(bv.toString()) : Infinity;
				return an - bn;
			});
		}
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

	/** Resolve a cover-image value (URL, vault path, or [[wikilink]]) to a displayable URL. */
	private resolveImageUrl(raw: string, sourcePath: string): string | null {
		let trimmed = raw.trim();
		if (!trimmed) return null;
		const wiki = trimmed.match(/^!?\[\[([^\]|]+)(\|[^\]]*)?\]\]$/);
		if (wiki) trimmed = wiki[1].trim();
		if (/^(https?:|data:|app:|file:)/i.test(trimmed)) return trimmed;
		const file = this.app.metadataCache.getFirstLinkpathDest(trimmed, sourcePath)
			?? this.app.vault.getAbstractFileByPath(trimmed);
		if (file instanceof TFile) return this.app.vault.getResourcePath(file);
		return null;
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

		// Auto-color columns when no colors manually configured
		this.autoColorMap = new Map();
		if (this.colorMap.size === 0) {
			[...allColKeysRaw].sort().forEach((k, i) => {
				this.autoColorMap.set(k, AUTO_PALETTE[i % AUTO_PALETTE.length]);
			});
		}

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

		// Column reordering (drag by header)
		this.sortables.push(new Sortable(board, {
			animation: 150,
			draggable: '.bk-col',
			handle: '.bk-col-hdr',
			filter: '.bk-add, .bk-kebab',
			preventOnFilter: false,
			ghostClass: 'bk-col-ghost',
			onStart: () => { this.isDragging = true; },
			onEnd: (evt) => void this.handleColumnDrop(evt),
		}));

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

		if (collapsed) {
			hdr.createSpan({ cls: 'bk-col-title', text: `${colKey} · ${cards.length}` });
		} else {
			const titleEl = hdr.createSpan({ cls: 'bk-col-title', text: colKey });
			titleEl.createSpan({ cls: 'bk-col-count', text: ` ${cards.length}` });
		}

		// ── Add card button ──
		if (!collapsed) {
			const addBtn = hdr.createEl('button', { cls: 'bk-add', title: 'Add card', text: '+' });
			addBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				const body = col.querySelector('.bk-col-body') as HTMLElement | null;
				if (body) this.showGhostCard(body, colKey, subgroupKey);
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

		if (collapsed) {
			// Collapsed: invisible body registered in the card group so cards can be dropped here
			const body = col.createDiv('bk-col-body bk-col-body-collapsed');
			this.sortables.push(new Sortable(body, {
				group: this.cardGroup,
				sort: false,
				animation: 150,
				draggable: '.bk-card',
				onStart: () => { this.isDragging = true; },
				onEnd: (evt) => void this.handleCardDrop(evt),
			}));
		} else {
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

			// Restore an in-progress ghost card after a re-render
			if (this.pendingGhost && this.pendingGhost.colKey === colKey && this.pendingGhost.subgroupKey === subgroupKey) {
				this.showGhostCard(body, colKey, subgroupKey, this.pendingGhost.text);
			}

			// Card sorting & cross-column moves
			this.sortables.push(new Sortable(body, {
				group: this.cardGroup,
				animation: 150,
				draggable: '.bk-card:not(.bk-ghost-card)',
				filter: 'input, .bk-toggle, .bk-check, .bk-prop-input',
				preventOnFilter: false,
				ghostClass: 'bk-card-ghost',
				onStart: () => { this.isDragging = true; },
				onEnd: (evt) => void this.handleCardDrop(evt),
			}));
		}
	}

	private renderCard(container: HTMLElement, card: KanbanCard, bucketKey: string, donePid: BasesPropertyId | null) {
		const el = container.createDiv('bk-card' + (card.done ? ' bk-card-done' : ''));
		el.dataset.cardId = card.id;

		// Cover image banner
		const coverPid = this.config.getAsPropertyId('coverImageProperty');
		if (coverPid) {
			let coverVal: Value | null = card.entry.getValue(coverPid);
			if (coverVal instanceof ListValue) coverVal = coverVal.length() ? coverVal.get(0) : null;
			if (coverVal && !(coverVal instanceof NullValue)) {
				const url = this.resolveImageUrl(coverVal.toString(), card.file.path);
				if (url) {
					const cover = el.createDiv('bk-card-cover');
					const img = cover.createEl('img');
					img.src = url;
					img.addEventListener('error', () => cover.remove());
				}
			}
		}

		const titleRow = el.createDiv('bk-card-title');

		// Done checkbox
		if (donePid) {
			const cb = titleRow.createDiv('bk-check' + (card.done ? ' bk-check-on' : ''));
			cb.addEventListener('click', async (e) => {
				e.preventDefault();
				e.stopPropagation();
				const newVal = !card.done;
				await writeProp(this.app, card.file, donePid, newVal);
				card.done = newVal;
				el.toggleClass('bk-card-done', newVal);
				cb.toggleClass('bk-check-on', newVal);
			});
		}

		const link = titleRow.createEl('a', { text: card.title, cls: 'bk-card-link internal-link', href: '#' });
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

		// Middle-click opens in a new tab, like a normal Obsidian link
		el.addEventListener('mousedown', (e) => {
			if (e.button === 1) e.preventDefault();
		});
		el.addEventListener('auxclick', (e) => {
			if (e.button !== 1) return;
			e.preventDefault();
			e.stopPropagation();
			this.app.workspace.getLeaf('tab').openFile(card.file);
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
				if (coverPid && pid === coverPid) continue;
				const val = card.entry.getValue(pid);
				if (!val || val instanceof NullValue) continue;
				const row = props.createDiv('bk-prop-row');
				row.createSpan({ cls: 'bk-prop-label', text: this.config.getDisplayName(pid) + ': ' });
				this.renderPropVal(row, val, card, pid);
			}
		}

	}

	private renderPropVal(parent: HTMLElement, val: Value, card: KanbanCard, pid: BasesPropertyId) {
		if (val instanceof BooleanValue) {
			const checked = val.isTruthy();
			const tog = parent.createEl('div', { cls: 'bk-toggle' + (checked ? ' bk-toggle-on' : '') });
			tog.createEl('div', { cls: 'bk-toggle-knob' });
			tog.addEventListener('click', async (e) => {
				e.stopPropagation();
				const newVal = !checked;
				await writeProp(this.app, card.file, pid, newVal);
				tog.toggleClass('bk-toggle-on', newVal);
			});
		} else if (val instanceof ListValue) {
			const items: string[] = [];
			for (let i = 0; i < val.length(); i++) {
				const item = val.get(i);
				if (item && !(item instanceof NullValue)) items.push(item.toString());
			}
			const row = parent.createDiv('bk-pill-row');
			for (const item of items) {
				row.createSpan({ cls: 'bk-pill' + (item.startsWith('#') ? ' bk-pill-tag' : ''), text: item });
			}
			row.addEventListener('click', (e) => {
				e.stopPropagation();
				this.editPropInline(parent, row, items.join(', '), 'text', async (newVal) => {
					const list = newVal.split(',').map(s => s.trim()).filter(Boolean);
					await writeProp(this.app, card.file, pid, list);
				});
			});
		} else if (val instanceof TagValue) {
			const span = parent.createSpan({ cls: 'bk-pill bk-pill-tag', text: val.toString() });
			span.addEventListener('click', (e) => {
				e.stopPropagation();
				this.editPropInline(parent, span, val.toString(), 'text', async (newVal) => {
					await writeProp(this.app, card.file, pid, newVal);
				});
			});
		} else if (val instanceof StringValue || val instanceof NumberValue || val instanceof DateValue) {
			const raw = val.toString();
			const isDate = val instanceof DateValue;
			const hasTime = isDate && raw.includes('T');
			const span = parent.createSpan({ cls: 'bk-prop-val', text: raw });
			span.addEventListener('click', (e) => {
				e.stopPropagation();
				this.editPropInline(
					parent, span,
					isDate ? raw.slice(0, hasTime ? 16 : 10) : raw,
					isDate ? (hasTime ? 'datetime-local' : 'date') : 'text',
					async (newVal) => { await writeProp(this.app, card.file, pid, newVal); },
				);
			});
		} else {
			parent.createSpan({ cls: 'bk-prop-val', text: val.toString() });
		}
	}

	/** Swap a display element for a temporary input; Enter/blur commits once, Escape cancels. */
	private editPropInline(
		parent: HTMLElement,
		display: HTMLElement,
		initial: string,
		inputType: string,
		onCommit: (value: string) => Promise<void>,
	) {
		const input = parent.createEl('input', { cls: 'bk-prop-input', type: inputType });
		input.value = initial;
		display.style.display = 'none';
		input.focus();
		if (inputType === 'text') input.select();
		let settled = false;
		const finish = () => {
			input.remove();
			display.style.display = '';
		};
		const commit = async () => {
			if (settled) return;
			settled = true;
			await onCommit(input.value);
			finish();
		};
		const cancel = () => {
			if (settled) return;
			settled = true;
			finish();
		};
		input.addEventListener('blur', () => void commit());
		input.addEventListener('keydown', (ke) => {
			if (ke.key === 'Enter') { ke.preventDefault(); void commit(); }
			if (ke.key === 'Escape') { ke.preventDefault(); cancel(); }
		});
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

	// ── DnD handlers (SortableJS) ───────────────────────────────────────────

	private async handleCardDrop(evt: Sortable.SortableEvent) {
		this.isDragging = false;
		try {
			const cardId = (evt.item as HTMLElement).dataset.cardId;
			const fromColEl = evt.from.closest('.bk-col') as HTMLElement | null;
			const toColEl = evt.to.closest('.bk-col') as HTMLElement | null;
			if (!cardId || !fromColEl || !toColEl) return;

			const fromColKey = fromColEl.dataset.colKey ?? '';
			const fromSub = fromColEl.dataset.subgroupKey ?? '';
			const toColKey = toColEl.dataset.colKey ?? '';
			const toSub = toColEl.dataset.subgroupKey ?? '';
			const fromBucket = `${fromSub}||${fromColKey}`;
			const toBucket = `${toSub}||${toColKey}`;

			const idsIn = (el: HTMLElement) =>
				(Array.from(el.querySelectorAll(':scope > .bk-card:not(.bk-ghost-card)')) as HTMLElement[])
					.map(c => c.dataset.cardId ?? '')
					.filter(Boolean);

			// Persist manual order BEFORE any frontmatter write triggers a Bases
			// refresh, so the re-render agrees with the DOM Sortable produced.
			const order = this.getManualCardOrder();
			order[toBucket] = idsIn(evt.to);
			if (fromBucket !== toBucket) order[fromBucket] = idsIn(evt.from);
			const newOrderInTarget = order[toBucket];
			await this.setManualCardOrder(order);

			if (fromBucket !== toBucket) {
				await this.moveCard(cardId, toColKey, toSub, fromSub);
			}

			const sortProp = this.getSortOrderProp();
			if (sortProp) {
				for (let i = 0; i < newOrderInTarget.length; i++) {
					const file = this.app.vault.getFileByPath(newOrderInTarget[i]);
					if (file) await writeProp(this.app, file, sortProp, i * 10);
				}
			}
		} finally {
			if (this.pendingRefresh) {
				this.pendingRefresh = false;
				await this.onDataUpdated();
			}
		}
	}

	private async handleColumnDrop(evt: Sortable.SortableEvent) {
		this.isDragging = false;
		try {
			const item = evt.item as HTMLElement;
			const key = item.dataset.colKey;
			if (!key) return;

			// Derive the new position from the dragged column's DOM neighbors and
			// splice it into the saved order, preserving hidden columns' slots.
			const domCols = Array.from(evt.to.querySelectorAll(':scope > .bk-col')) as HTMLElement[];
			const idx = domCols.indexOf(item);
			const prevKey = idx > 0 ? domCols[idx - 1].dataset.colKey : undefined;
			const nextKey = idx < domCols.length - 1 ? domCols[idx + 1].dataset.colKey : undefined;

			const order = this.getColumnOrder().filter(k => k !== key);
			let insertAt = order.length;
			if (prevKey !== undefined && order.indexOf(prevKey) !== -1) insertAt = order.indexOf(prevKey) + 1;
			else if (nextKey !== undefined && order.indexOf(nextKey) !== -1) insertAt = order.indexOf(nextKey);
			order.splice(insertAt, 0, key);
			await this.setColumnOrder(order);
		} finally {
			if (this.pendingRefresh) {
				this.pendingRefresh = false;
				await this.onDataUpdated();
			}
		}
	}

	// ── inline card creation ────────────────────────────────────────────────

	private showGhostCard(body: HTMLElement, colKey: string, subgroupKey: string, initialText = '') {
		// Only one ghost at a time across the whole board
		this.wrap.querySelectorAll('.bk-ghost-card').forEach(el => el.remove());
		this.pendingGhost = { colKey, subgroupKey, text: initialText };

		const ghost = body.createDiv('bk-card bk-ghost-card');
		const input = ghost.createEl('input', { cls: 'bk-ghost-input', type: 'text', placeholder: 'Note title…' });
		input.value = initialText;
		// Mirror text so a mid-typing re-render can restore the ghost
		input.addEventListener('input', () => { if (this.pendingGhost) this.pendingGhost.text = input.value; });

		let settled = false;
		const cancel = () => {
			if (settled) return;
			settled = true;
			this.pendingGhost = null;
			ghost.remove();
		};
		const commit = async () => {
			if (settled) return;
			const title = input.value.trim();
			if (!title) { cancel(); return; }
			settled = true;
			this.pendingGhost = null;
			ghost.remove();
			await this.commitGhost(colKey, subgroupKey, title);
		};

		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); void commit(); }
			if (e.key === 'Escape') { e.preventDefault(); cancel(); }
		});
		input.addEventListener('blur', () => void commit());

		ghost.scrollIntoView({ block: 'nearest' });
		input.focus();
	}

	private async commitGhost(colKey: string, subgroupKey: string, title: string) {
		const folder = ((this.config.get('newNoteFolder') as string) ?? '').trim();

		const fm: Record<string, unknown> = {};
		const groupByPid = this.getGroupByPropId();
		if (groupByPid && colKey !== NULL_KEY) {
			fm[parsePropertyId(groupByPid).name] = colKey;
		} else if (!groupByPid) {
			new Notice('No Group By set on this base — creating the note without a column value.');
		}
		const subgroupPid = this.config.getAsPropertyId('subgroupProperty');
		if (subgroupPid && subgroupKey && subgroupKey !== NULL_KEY) {
			fm[parsePropertyId(subgroupPid).name] = subgroupKey;
		}
		// Stub out the properties visible in this view so they show up in the new note
		for (const pid of this.config.getOrder()) {
			const { type, name } = parsePropertyId(pid);
			if (type !== 'note') continue;
			if (name === 'name' || name in fm) continue;
			fm[name] = '';
		}

		try {
			await createNoteInFolder(this.app, folder, title, fm);
		} catch (err) {
			console.error(err);
			new Notice('Failed to create note. Check the console for details.');
		}
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
			await writeProp(this.app, file, groupByPid, newColKey === NULL_KEY ? '' : newColKey);
			if (newSubgroupKey !== srcSubgroupKey) {
				const subgroupPid = this.config.getAsPropertyId('subgroupProperty');
				if (subgroupPid) {
					await writeProp(this.app, file, subgroupPid, newSubgroupKey === NULL_KEY ? '' : newSubgroupKey);
				}
			}
		} catch (err) {
			console.error(err);
			new Notice('Failed to update frontmatter');
		}
	}
}
