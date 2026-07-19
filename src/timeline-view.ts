import {
	BasesView, TFile, QueryController, HoverParent, HoverPopover, Keymap,
	BasesEntry, BasesPropertyId,
	BooleanValue, NullValue,
	Menu, App, Modal,
} from 'obsidian';
import BaseViewsPlugin from './main';
import { writeProp } from './frontmatter';
import { AUTO_PALETTE } from './util';
import { QuickAddModal } from './quick-add-modal';

export const VIEW_TYPE_BASE_TIMELINE = 'base-timeline-view';

const DK = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const MS_PER_DAY = 86400000;
const LABEL_WIDTH = 200;
const ROW_HEIGHT = 36;
const GROUP_ROW_HEIGHT = 30;
const BAR_HEIGHT = 22;
const MONTH_STRIP_H = 20;
const COL_STRIP_H = 28;
const HEADER_HEIGHT = MONTH_STRIP_H + COL_STRIP_H;
const COL_WIDTHS = { day: 30, week: 80, month: 60 } as const;
const NAV_SHIFTS_DAYS = { day: 14, week: 28, month: 91 } as const;
const DRAG_THRESHOLD = 5;

type ZoomLevel = 'day' | 'week' | 'month';

interface TimelineItem {
	id: string;
	title: string;
	subtitle: string;
	start: Date;
	end: Date;
	isSingleDay: boolean;
	done: boolean;
	color: string | null;
	groupKey: string;
	sortOrder: number;
	file: TFile;
	entry: BasesEntry;
}

class DatePromptModal extends Modal {
	private resolvePromise: ((d: Date | null) => void) | null = null;

	constructor(app: App, private initial: Date, private modalTitle: string) {
		super(app);
	}

	open(): Promise<Date | null> {
		super.open();
		return new Promise(res => { this.resolvePromise = res; });
	}

	onClose() { this.resolvePromise?.(null); }

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: this.modalTitle });
		const input = contentEl.createEl('input', { type: 'date' });
		input.value = DK(this.initial);
		input.style.width = '100%';
		input.focus();
		const submit = () => {
			if (!input.value) return;
			const d = new Date(input.value + 'T00:00:00');
			if (isNaN(d.getTime())) return;
			this.resolvePromise?.(d);
			this.resolvePromise = null;
			this.close();
		};
		input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		btnRow.style.marginTop = '12px';
		const ok = btnRow.createEl('button', { text: 'OK', cls: 'mod-cta' });
		ok.onclick = submit;
		const cancel = btnRow.createEl('button', { text: 'Cancel' });
		cancel.onclick = () => this.close();
	}
}

export class BaseTimelineView extends BasesView implements HoverParent {
	readonly type = VIEW_TYPE_BASE_TIMELINE;
	hoverPopover: HoverPopover | null = null;

	private wrap: HTMLElement;
	private plugin: BaseViewsPlugin;
	private scrollEl: HTMLElement | null = null;
	private barsLayerEl: HTMLElement | null = null;
	private titleEl: HTMLElement | null = null;
	private zoomBtns: Record<ZoomLevel, HTMLElement> | null = null;

	private dateProp: BasesPropertyId | null = null;
	private endProp: BasesPropertyId | null = null;
	private doneProp: BasesPropertyId | null = null;
	private subtitleProp: BasesPropertyId | null = null;
	private sortOrderProp: BasesPropertyId | null = null;
	private zoomLevel: ZoomLevel = 'week';

	private daysVisible = 30;
	private weeksVisible = 12;
	private monthsVisible = 6;

	private prevDaysVisible = 30;
	private prevWeeksVisible = 12;
	private prevMonthsVisible = 6;

	private windowStart: Date | null = null;
	private windowEnd: Date | null = null;
	private cols: Date[] = [];

	private items: TimelineItem[] = [];
	private autoColorMap: Record<string, string> = {};
	private rowYMap = new Map<string, number>();

	// Drag state
	private dragItem: TimelineItem | null = null;
	private dragMode: 'move' | 'resize-left' | 'resize-right' | null = null;
	private dragStartX = 0;
	private dragStartDate: Date | null = null;
	private dragEndDate: Date | null = null;
	private dragBarEl: HTMLElement | null = null;
	private dragMoved = false;

	constructor(ctrl: QueryController, parent: HTMLElement, plugin: BaseViewsPlugin) {
		super(ctrl);
		this.plugin = plugin;
		this.wrap = parent.createDiv('bt-wrap');
	}

	async onDataUpdated(): Promise<void> {
		this.dateProp = this.config.getAsPropertyId('dateProperty') ?? null;
		this.endProp = this.config.getAsPropertyId('endDateProperty') ?? null;
		this.doneProp = this.config.getAsPropertyId('doneProperty') ?? null;
		this.subtitleProp = this.config.getAsPropertyId('subtitleProperty') ?? null;
		this.sortOrderProp = this.config.getAsPropertyId('sortOrderProperty') ?? null;

		const cfgZoom = this.config.get('zoomLevel');
		if (cfgZoom === 'day' || cfgZoom === 'week' || cfgZoom === 'month') {
			if (this.zoomLevel !== cfgZoom) {
				this.zoomLevel = cfgZoom;
				this.windowStart = null;
				this.windowEnd = null;
			}
		}

		const dv = this.config.get('daysVisible');
		if (typeof dv === 'number' && dv >= 1) this.daysVisible = Math.floor(dv);
		const wv = this.config.get('weeksVisible');
		if (typeof wv === 'number' && wv >= 1) this.weeksVisible = Math.floor(wv);
		const mv = this.config.get('monthsVisible');
		if (typeof mv === 'number' && mv >= 1) this.monthsVisible = Math.floor(mv);

		// Invalidate cached window when the active zoom's range changes
		if (
			this.daysVisible !== this.prevDaysVisible ||
			this.weeksVisible !== this.prevWeeksVisible ||
			this.monthsVisible !== this.prevMonthsVisible
		) {
			this.windowStart = null;
			this.windowEnd = null;
			this.prevDaysVisible = this.daysVisible;
			this.prevWeeksVisible = this.weeksVisible;
			this.prevMonthsVisible = this.monthsVisible;
		}

		this.wrap.empty();
		this.buildUI(this.wrap);
	}

	private resolveBgUrl(raw: string): string {
		const trimmed = raw.trim();
		if (/^(https?:|data:|app:|file:)/i.test(trimmed)) return trimmed;
		const file = this.app.vault.getAbstractFileByPath(trimmed);
		if (file instanceof TFile) return this.app.vault.adapter.getResourcePath(file.path);
		return trimmed;
	}

	private buildUI(container: HTMLElement) {
		const bgUrl = this.config.get('bgImage') as string | null;
		if (bgUrl?.trim()) {
			const resolved = this.resolveBgUrl(bgUrl);
			const bgLayer = container.createDiv('bt-bg-layer');
			bgLayer.style.backgroundImage = `url("${resolved}")`;
			const fit = (this.config.get('bgFit') as string) || 'cover';
			bgLayer.style.backgroundSize = fit === 'stretch' ? '100% 100%' : fit;
			const blur = this.config.get('bgBlur') as number | null;
			if (blur && blur > 0) bgLayer.style.filter = `blur(${blur}px)`;
			bgLayer.style.opacity = String((this.config.get('bgOpacity') as number | null) ?? 0.3);
		}

		this.renderToolbar(container);

		const scroll = container.createDiv('bt-scroll');
		this.scrollEl = scroll;

		this.loadItems();
		if (!this.windowStart || !this.windowEnd) this.computeWindow();
		this.buildContent(scroll);
	}

	// ── Toolbar ────────────────────────────────────────────────────────────────

	private renderToolbar(container: HTMLElement) {
		const toolbar = container.createDiv('bt-toolbar');

		const nav = toolbar.createDiv('bt-nav');
		const prev = nav.createEl('button', { cls: 'bt-btn' });
		prev.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';
		const todayBtn = nav.createEl('button', { text: 'Today', cls: 'bt-today' });
		const next = nav.createEl('button', { cls: 'bt-btn' });
		next.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';

		this.titleEl = toolbar.createEl('span', { cls: 'bt-title' });

		const zoomGroup = toolbar.createDiv('bt-zoom-group');
		const zDay = zoomGroup.createEl('button', { text: 'Day', cls: 'bt-zoom' });
		const zWeek = zoomGroup.createEl('button', { text: 'Week', cls: 'bt-zoom' });
		const zMonth = zoomGroup.createEl('button', { text: 'Month', cls: 'bt-zoom' });
		this.zoomBtns = { day: zDay, week: zWeek, month: zMonth };

		const addBtn = toolbar.createEl('button', { cls: 'bt-add-btn', title: 'Add new note', text: '+' });
		addBtn.addEventListener('click', () => this.createTimelineNote());

		const setZoom = (z: ZoomLevel) => {
			this.zoomLevel = z;
			this.windowStart = null;
			this.windowEnd = null;
			this.wrap.empty();
			this.buildUI(this.wrap);
		};
		zDay.onclick = () => setZoom('day');
		zWeek.onclick = () => setZoom('week');
		zMonth.onclick = () => setZoom('month');

		const shift = (dir: 1 | -1) => {
			if (!this.windowStart || !this.windowEnd || !this.scrollEl) return;
			const days = NAV_SHIFTS_DAYS[this.zoomLevel] * dir;
			this.windowStart = new Date(this.windowStart.getTime() + days * MS_PER_DAY);
			this.windowEnd = new Date(this.windowEnd.getTime() + days * MS_PER_DAY);
			this.normalizeWindowBoundaries();
			this.cols = this.buildCols();
			this.scrollEl.empty();
			this.barsLayerEl = null;
			this.buildContent(this.scrollEl);
		};
		prev.onclick = () => shift(-1);
		next.onclick = () => shift(1);

		todayBtn.onclick = () => {
			this.windowStart = null;
			this.windowEnd = null;
			this.wrap.empty();
			this.buildUI(this.wrap);
		};
	}

	// ── Data loading ───────────────────────────────────────────────────────────

	private loadItems() {
		this.items = [];
		const groups = this.data.groupedData;
		if (!groups?.length || !this.dateProp) return;

		const viewColorMap = this.getViewColorMap();

		for (const group of groups) {
			const gKey = group.hasKey() && group.key ? group.key.toString() : '';

			for (const entry of group.entries) {
				const file = entry.file;
				if (!(file instanceof TFile)) continue;

				const val = entry.getValue(this.dateProp);
				if (!val || val instanceof NullValue) continue;

				const sd = new Date(val.toString() + 'T00:00:00');
				if (isNaN(sd.getTime())) continue;
				sd.setHours(0, 0, 0, 0);

				let ed: Date = new Date(sd);
				let isSingleDay = true;
				if (this.endProp) {
					const ev2 = entry.getValue(this.endProp);
					if (ev2 && !(ev2 instanceof NullValue)) {
						const d2 = new Date(ev2.toString() + 'T00:00:00');
						if (!isNaN(d2.getTime())) {
							d2.setHours(0, 0, 0, 0);
							if (d2.getTime() >= sd.getTime()) { ed = d2; isSingleDay = false; }
						}
					}
				}

				let done = false;
				if (this.doneProp) {
					const dv = entry.getValue(this.doneProp);
					if (dv instanceof BooleanValue) done = dv.isTruthy();
				}

				let subtitle = '';
				if (this.subtitleProp) {
					const sv = entry.getValue(this.subtitleProp);
					if (sv && !(sv instanceof NullValue)) subtitle = sv.toString();
				}

				let sortOrder = Infinity;
				if (this.sortOrderProp) {
					const sv = entry.getValue(this.sortOrderProp);
					if (sv && !(sv instanceof NullValue)) {
						const n = Number(sv.toString());
						if (!isNaN(n)) sortOrder = n;
					}
				}

				this.items.push({
					id: file.path,
					title: file.basename,
					subtitle,
					start: sd,
					end: ed,
					isSingleDay,
					done,
					color: this.getItemColor(entry, viewColorMap),
					groupKey: gKey,
					sortOrder,
					file,
					entry,
				});
			}
		}

		// Build auto-color map when colorProperty set but no colorValues configured
		this.autoColorMap = {};
		const raw = (this.config.get('colorProperty') as string | undefined)?.trim() ?? '';
		const propName = raw.startsWith('note.') ? raw.slice(5) : raw;
		if (propName && Object.keys(this.getViewColorMap()).length === 0) {
			const pid = `note.${propName}` as BasesPropertyId;
			const unique = [...new Set(
				this.items
					.map(it => it.entry.getValue(pid))
					.filter((v): v is NonNullable<typeof v> => !!v && !(v instanceof NullValue))
					.map(v => v.toString().trim())
					.filter(Boolean),
			)].sort();
			unique.forEach((v, i) => { this.autoColorMap[v] = AUTO_PALETTE[i % AUTO_PALETTE.length]; });
		}
	}

	private getViewColorMap(): Record<string, string> {
		const entries = this.config.get('colorValues') as string[] | null ?? [];
		const map: Record<string, string> = {};
		for (const e of entries) {
			const i = e.lastIndexOf(':');
			if (i > 0) map[e.slice(0, i).trim()] = e.slice(i + 1).trim();
		}
		return map;
	}

	private getItemColor(entry: BasesEntry, viewColorMap: Record<string, string>): string | null {
		const raw = (this.config.get('colorProperty') as string | undefined)?.trim() ?? '';
		const propName = raw.startsWith('note.') ? raw.slice(5) : raw;

		if (propName) {
			const pid = `note.${propName}` as BasesPropertyId;
			const val = entry.getValue(pid);
			if (val && !(val instanceof NullValue)) {
				const valStr = val.toString().trim();
				return viewColorMap[valStr] ?? this.autoColorMap[valStr] ?? null;
			}
		}

		return null;
	}

	// ── Window / column math ───────────────────────────────────────────────────

	private computeWindow() {
		let minStart: Date | null = null;
		let maxEnd: Date | null = null;
		for (const item of this.items) {
			if (!minStart || item.start < minStart) minStart = new Date(item.start);
			if (!maxEnd || item.end > maxEnd) maxEnd = new Date(item.end);
		}

		const today = new Date(); today.setHours(0, 0, 0, 0);
		const padDays = { day: 7, week: 28, month: 60 } as const;

		if (!minStart || !maxEnd) {
			// Use configured visible range, starting from today
			const configuredDays = this.getConfiguredDays();
			minStart = new Date(today);
			maxEnd = new Date(today.getTime() + configuredDays * MS_PER_DAY);
		} else {
			// Use max of data range and configured range
			const configuredDays = this.getConfiguredDays();
			const pad = padDays[this.zoomLevel];
			const dataMin = new Date(minStart.getTime() - pad * MS_PER_DAY);
			const dataMax = new Date(maxEnd.getTime() + pad * MS_PER_DAY);
			const cfgMin = new Date(today);
			const cfgMax = new Date(today.getTime() + configuredDays * MS_PER_DAY);
			minStart = dataMin < cfgMin ? dataMin : cfgMin;
			maxEnd = dataMax > cfgMax ? dataMax : cfgMax;
		}

		this.windowStart = minStart;
		this.windowEnd = maxEnd;
		this.normalizeWindowBoundaries();
		this.cols = this.buildCols();
	}

	private getConfiguredDays(): number {
		switch (this.zoomLevel) {
			case 'day': return this.daysVisible;
			case 'week': return this.weeksVisible * 7;
			case 'month': return this.monthsVisible * 30;
		}
	}

	private normalizeWindowBoundaries() {
		if (!this.windowStart) return;
		if (this.zoomLevel === 'week') {
			const dow = this.windowStart.getDay();
			const back = dow === 0 ? 6 : dow - 1;
			this.windowStart = new Date(this.windowStart.getTime() - back * MS_PER_DAY);
		} else if (this.zoomLevel === 'month') {
			this.windowStart = new Date(this.windowStart.getFullYear(), this.windowStart.getMonth(), 1);
		}
	}

	private buildCols(): Date[] {
		if (!this.windowStart || !this.windowEnd) return [];
		const cols: Date[] = [];
		if (this.zoomLevel === 'day') {
			let d = new Date(this.windowStart);
			while (d <= this.windowEnd) { cols.push(new Date(d)); d = new Date(d.getTime() + MS_PER_DAY); }
		} else if (this.zoomLevel === 'week') {
			let d = new Date(this.windowStart);
			while (d <= this.windowEnd) { cols.push(new Date(d)); d = new Date(d.getTime() + 7 * MS_PER_DAY); }
		} else {
			let yr = this.windowStart.getFullYear(), mo = this.windowStart.getMonth();
			const endYr = this.windowEnd.getFullYear(), endMo = this.windowEnd.getMonth();
			while (yr < endYr || (yr === endYr && mo <= endMo)) {
				cols.push(new Date(yr, mo, 1));
				mo++; if (mo > 11) { mo = 0; yr++; }
			}
		}
		return cols;
	}

	private getColWidth(): number { return COL_WIDTHS[this.zoomLevel]; }

	private dateToColFraction(d: Date): number {
		if (!this.windowStart) return 0;
		if (this.zoomLevel === 'day') return (d.getTime() - this.windowStart.getTime()) / MS_PER_DAY;
		if (this.zoomLevel === 'week') return (d.getTime() - this.windowStart.getTime()) / (7 * MS_PER_DAY);
		const yr0 = this.windowStart.getFullYear(), mo0 = this.windowStart.getMonth();
		const yr1 = d.getFullYear(), mo1 = d.getMonth();
		const monthIdx = (yr1 - yr0) * 12 + (mo1 - mo0);
		const daysInMonth = new Date(yr1, mo1 + 1, 0).getDate();
		return monthIdx + (d.getDate() - 1) / daysInMonth;
	}

	private dateToPixel(d: Date): number { return this.dateToColFraction(d) * this.getColWidth(); }

	private snapDate(d: Date): Date {
		const out = new Date(d); out.setHours(0, 0, 0, 0);
		if (this.zoomLevel === 'week') {
			const dow = out.getDay(); const back = dow === 0 ? 6 : dow - 1;
			return new Date(out.getTime() - back * MS_PER_DAY);
		}
		if (this.zoomLevel === 'month') return new Date(out.getFullYear(), out.getMonth(), 1);
		return out;
	}

	private deltaXToMs(deltaX: number): number {
		const cw = this.getColWidth();
		if (this.zoomLevel === 'day') return (deltaX / cw) * MS_PER_DAY;
		if (this.zoomLevel === 'week') return (deltaX / cw) * 7 * MS_PER_DAY;
		return (deltaX / cw) * 30 * MS_PER_DAY;
	}

	private updateToolbarTitle() {
		if (!this.titleEl || !this.windowStart || !this.windowEnd) return;
		const fmt = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-US', opts);
		const s = fmt(this.windowStart, { month: 'short', year: 'numeric' });
		const e = fmt(this.windowEnd, { month: 'short', year: 'numeric' });
		this.titleEl.textContent = s === e ? s : `${s} — ${e}`;
		if (this.zoomBtns) {
			(Object.entries(this.zoomBtns) as [ZoomLevel, HTMLElement][]).forEach(([k, btn]) =>
				btn.toggleClass('bt-zoom-active', k === this.zoomLevel));
		}
	}

	// ── DOM building ───────────────────────────────────────────────────────────

	private buildContent(scroll: HTMLElement) {
		this.updateToolbarTitle();
		const cw = this.getColWidth();
		const colCount = this.cols.length;
		const totalWidth = LABEL_WIDTH + colCount * cw;

		const content = scroll.createDiv('bt-content');
		content.style.minWidth = `${totalWidth}px`;

		this.renderHeader(content, cw, colCount);

		let rowY = HEADER_HEIGHT;
		this.rowYMap.clear();

		const isGrouped = this.items.some(i => i.groupKey);

		const sortItems = (arr: TimelineItem[]) =>
			this.sortOrderProp ? [...arr].sort((a, b) => a.sortOrder - b.sortOrder) : arr;

		if (isGrouped) {
			const order: string[] = [];
			const byGroup = new Map<string, TimelineItem[]>();
			for (const item of this.items) {
				const k = item.groupKey;
				if (!byGroup.has(k)) { byGroup.set(k, []); order.push(k); }
				byGroup.get(k)!.push(item);
			}
			for (const k of order) {
				rowY = this.renderSwimlaneHeader(content, k, rowY, totalWidth);
				for (const item of sortItems(byGroup.get(k)!)) {
					rowY = this.renderItemRow(content, item, rowY, cw, colCount);
				}
			}
		} else {
			for (const item of sortItems(this.items)) {
				rowY = this.renderItemRow(content, item, rowY, cw, colCount);
			}
		}

		if (this.items.length === 0) {
			const empty = content.createDiv('bt-empty');
			empty.textContent = this.dateProp
				? 'No items with a start date found.'
				: 'Configure a start date property in the view settings.';
		}

		content.style.minHeight = `${rowY}px`;

		const barsLayer = content.createDiv('bt-bars-layer');
		barsLayer.style.top = `${HEADER_HEIGHT}px`;
		barsLayer.style.height = `${Math.max(rowY - HEADER_HEIGHT, 0)}px`;
		this.barsLayerEl = barsLayer;

		this.renderTodayLine(barsLayer);
		this.renderBars(barsLayer);

		this.scrollToToday(scroll, cw);
	}

	private renderHeader(content: HTMLElement, cw: number, colCount: number) {
		const headerRow = content.createDiv('bt-header-row');

		const corner = headerRow.createDiv('bt-corner');
		corner.style.width = `${LABEL_WIDTH}px`;

		const headerMain = headerRow.createDiv('bt-header-main');
		headerMain.style.width = `${colCount * cw}px`;

		const monthStrip = headerMain.createDiv('bt-month-strip');
		const colStrip = headerMain.createDiv('bt-col-strip');

		const today = new Date(); today.setHours(0, 0, 0, 0);

		// Build month/year band segments
		interface Seg { label: string; colStart: number; colEnd: number; }
		const segs: Seg[] = [];
		let curLabel = '';
		let curStart = 0;

		for (let i = 0; i < this.cols.length; i++) {
			const col = this.cols[i];
			const label = this.zoomLevel === 'month'
				? String(col.getFullYear())
				: col.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
			if (label !== curLabel) {
				if (curLabel) segs.push({ label: curLabel, colStart: curStart, colEnd: i - 1 });
				curLabel = label; curStart = i;
			}
		}
		if (curLabel) segs.push({ label: curLabel, colStart: curStart, colEnd: this.cols.length - 1 });

		for (const seg of segs) {
			const el = monthStrip.createDiv('bt-month-seg');
			el.style.width = `${(seg.colEnd - seg.colStart + 1) * cw}px`;
			el.textContent = seg.label;
		}

		// Column labels
		for (let i = 0; i < this.cols.length; i++) {
			const col = this.cols[i];
			const colHdr = colStrip.createDiv('bt-col-hdr');
			colHdr.style.width = `${cw}px`;

			let label = '';
			let cls = '';
			if (this.zoomLevel === 'day') {
				label = String(col.getDate());
				const dow = col.getDay();
				if (dow === 0 || dow === 6) cls = 'bt-col-weekend';
				if (dow === 1) cls = 'bt-col-monday';
				if (col.getTime() === today.getTime()) cls = 'bt-col-today';
			} else if (this.zoomLevel === 'week') {
				label = col.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
				const weekEnd = new Date(col.getTime() + 6 * MS_PER_DAY);
				if (today >= col && today <= weekEnd) cls = 'bt-col-today';
			} else {
				label = col.toLocaleDateString('en-US', col.getMonth() === 0 ? { month: 'short', year: 'numeric' } : { month: 'short' });
				if (col.getFullYear() === today.getFullYear() && col.getMonth() === today.getMonth()) cls = 'bt-col-today';
			}

			colHdr.textContent = label;
			if (cls) colHdr.addClass(cls);
		}
	}

	private renderSwimlaneHeader(content: HTMLElement, label: string, rowY: number, totalWidth: number): number {
		const hdr = content.createDiv('bt-swimlane-hdr');
		hdr.textContent = label || '(no value)';
		hdr.style.top = `${rowY}px`;
		hdr.style.width = `${totalWidth}px`;
		return rowY + GROUP_ROW_HEIGHT;
	}

	private renderItemRow(content: HTMLElement, item: TimelineItem, rowY: number, cw: number, colCount: number): number {
		this.rowYMap.set(item.id, rowY);

		const row = content.createDiv('bt-row');
		row.style.top = `${rowY}px`;
		row.style.height = `${ROW_HEIGHT}px`;

		// Label cell (sticky left)
		const label = row.createDiv('bt-row-label');
		label.style.width = `${LABEL_WIDTH}px`;

		const titleEl = label.createDiv('bt-row-title');
		titleEl.textContent = item.title;
		titleEl.title = item.title;
		titleEl.onclick = () => this.app.workspace.getLeaf(false)?.openFile(item.file);

		if (item.subtitle) {
			const subEl = label.createDiv('bt-row-subtitle');
			subEl.textContent = item.subtitle;
			subEl.title = item.subtitle;
		}

		// Track cells (one per column, for grid lines and shading)
		const track = row.createDiv('bt-row-track');
		track.style.width = `${colCount * cw}px`;

		const today = new Date(); today.setHours(0, 0, 0, 0);
		for (let i = 0; i < colCount; i++) {
			const col = this.cols[i];
			const cell = track.createDiv('bt-row-cell');
			cell.style.width = `${cw}px`;
			if (this.zoomLevel === 'day') {
				const dow = col.getDay();
				if (dow === 0 || dow === 6) cell.addClass('bt-cell-weekend');
				if (col.getTime() === today.getTime()) cell.addClass('bt-cell-today');
			} else if (this.zoomLevel === 'week') {
				const weekEnd = new Date(col.getTime() + 6 * MS_PER_DAY);
				if (today >= col && today <= weekEnd) cell.addClass('bt-cell-today');
			} else {
				if (col.getFullYear() === today.getFullYear() && col.getMonth() === today.getMonth())
					cell.addClass('bt-cell-today');
			}
		}

		return rowY + ROW_HEIGHT;
	}

	private renderTodayLine(barsLayer: HTMLElement) {
		if (!this.windowStart || !this.windowEnd) return;
		const today = new Date(); today.setHours(0, 0, 0, 0);
		if (today < this.windowStart || today > this.windowEnd) return;

		const line = barsLayer.createDiv('bt-today-line');
		line.style.left = `${this.dateToPixel(today)}px`;
	}

	private renderBars(barsLayer: HTMLElement) {
		for (const item of this.items) {
			const rowY = this.rowYMap.get(item.id);
			if (rowY === undefined) continue;

			const barTop = rowY - HEADER_HEIGHT + (ROW_HEIGHT - BAR_HEIGHT) / 2;
			const cw = this.getColWidth();
			const left = this.dateToPixel(item.start);
			const endNext = new Date(item.end.getTime() + MS_PER_DAY);
			const width = Math.max(this.dateToPixel(endNext) - left, item.isSingleDay ? cw * 0.5 : 4);

			const bar = barsLayer.createDiv('bt-bar');
			bar.style.left = `${left}px`;
			bar.style.width = `${width}px`;
			bar.style.top = `${barTop}px`;

			if (item.color) {
				bar.style.background = `color-mix(in srgb, ${item.color} 35%, var(--background-primary))`;
				bar.style.borderLeftColor = item.color;
			}
			if (item.done) bar.addClass('bt-bar-done');

			// Left resize handle
			const handleL = bar.createDiv('bt-bar-handle bt-bar-handle-left');
			// Done checkbox
			if (this.doneProp) {
				const cb = bar.createDiv('bt-bar-check' + (item.done ? ' bt-bar-check-on' : ''));
				cb.addEventListener('click', async (e) => {
					e.stopPropagation();
					const newVal = !item.done;
					await writeProp(this.app, item.file, this.doneProp!, newVal);
					item.done = newVal;
					bar.toggleClass('bt-bar-done', newVal);
					cb.toggleClass('bt-bar-check-on', newVal);
				});
			}
			// Label
			const labelEl = bar.createSpan({ cls: 'bt-bar-label', text: item.title });
			labelEl.title = item.title;
			// Right resize handle
			const handleR = bar.createDiv('bt-bar-handle bt-bar-handle-right');

			this.attachBarDrag(bar, handleL, handleR, labelEl, item);
			this.attachBarContextMenu(bar, item);
		}
	}

	// ── Bar drag & resize ──────────────────────────────────────────────────────

	private updateBarPosition(barEl: HTMLElement, start: Date, end: Date) {
		const cw = this.getColWidth();
		const left = this.dateToPixel(start);
		const endNext = new Date(end.getTime() + MS_PER_DAY);
		const width = Math.max(this.dateToPixel(endNext) - left, 4);
		barEl.style.left = `${left}px`;
		barEl.style.width = `${width}px`;
	}

	private attachBarDrag(
		bar: HTMLElement,
		handleL: HTMLElement,
		handleR: HTMLElement,
		labelEl: HTMLElement,
		item: TimelineItem,
	) {
		// Left resize handle
		handleL.addEventListener('pointerdown', (e: PointerEvent) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			handleL.setPointerCapture(e.pointerId);
			this.dragItem = item;
			this.dragMode = 'resize-left';
			this.dragStartX = e.clientX;
			this.dragStartDate = new Date(item.start);
			this.dragEndDate = new Date(item.end);
			this.dragBarEl = bar;
			this.dragMoved = false;
			bar.addClass('bt-bar-resizing');
		});
		handleL.addEventListener('pointermove', (e: PointerEvent) => {
			if (this.dragMode !== 'resize-left' || this.dragItem !== item) return;
			const deltaX = e.clientX - this.dragStartX;
			this.dragMoved = this.dragMoved || Math.abs(deltaX) > DRAG_THRESHOLD;
			const newStart = this.snapDate(new Date(this.dragStartDate!.getTime() + this.deltaXToMs(deltaX)));
			if (newStart < this.dragEndDate!) this.updateBarPosition(bar, newStart, this.dragEndDate!);
		});
		handleL.addEventListener('pointerup', async (e: PointerEvent) => {
			if (this.dragMode !== 'resize-left' || this.dragItem !== item) return;
			bar.removeClass('bt-bar-resizing');
			if (this.dragMoved) {
				const deltaX = e.clientX - this.dragStartX;
				const newStart = this.snapDate(new Date(this.dragStartDate!.getTime() + this.deltaXToMs(deltaX)));
				if (newStart < this.dragEndDate! && DK(newStart) !== DK(this.dragStartDate!)) {
					await writeProp(this.app, item.file, this.dateProp!, DK(newStart));
					item.start = newStart;
					item.isSingleDay = newStart.getTime() === item.end.getTime();
					this.updateBarPosition(bar, item.start, item.end);
				} else {
					this.updateBarPosition(bar, item.start, item.end);
				}
			}
			this.clearDragState();
		});

		// Right resize handle
		handleR.addEventListener('pointerdown', (e: PointerEvent) => {
			if (e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			handleR.setPointerCapture(e.pointerId);
			this.dragItem = item;
			this.dragMode = 'resize-right';
			this.dragStartX = e.clientX;
			this.dragStartDate = new Date(item.start);
			this.dragEndDate = new Date(item.end);
			this.dragBarEl = bar;
			this.dragMoved = false;
			bar.addClass('bt-bar-resizing');
		});
		handleR.addEventListener('pointermove', (e: PointerEvent) => {
			if (this.dragMode !== 'resize-right' || this.dragItem !== item) return;
			const deltaX = e.clientX - this.dragStartX;
			this.dragMoved = this.dragMoved || Math.abs(deltaX) > DRAG_THRESHOLD;
			const newEnd = this.snapDate(new Date(this.dragEndDate!.getTime() + this.deltaXToMs(deltaX)));
			if (newEnd >= this.dragStartDate!) this.updateBarPosition(bar, this.dragStartDate!, newEnd);
		});
		handleR.addEventListener('pointerup', async (e: PointerEvent) => {
			if (this.dragMode !== 'resize-right' || this.dragItem !== item) return;
			bar.removeClass('bt-bar-resizing');
			if (this.dragMoved) {
				const deltaX = e.clientX - this.dragStartX;
				const newEnd = this.snapDate(new Date(this.dragEndDate!.getTime() + this.deltaXToMs(deltaX)));
				if (newEnd >= this.dragStartDate! && DK(newEnd) !== DK(this.dragEndDate!)) {
					if (this.endProp) {
						await writeProp(this.app, item.file, this.endProp, DK(newEnd));
					}
					item.end = newEnd;
					item.isSingleDay = item.start.getTime() === newEnd.getTime();
					this.updateBarPosition(bar, item.start, item.end);
				} else {
					this.updateBarPosition(bar, item.start, item.end);
				}
			}
			this.clearDragState();
		});

		// Bar body — move
		bar.addEventListener('pointerdown', (e: PointerEvent) => {
			if (e.button !== 0) return;
			// Ignore if originating from a handle
			const target = e.target as HTMLElement;
			if (target.hasClass('bt-bar-handle') || target.hasClass('bt-bar-check')) return;
			e.preventDefault();
			bar.setPointerCapture(e.pointerId);
			this.dragItem = item;
			this.dragMode = 'move';
			this.dragStartX = e.clientX;
			this.dragStartDate = new Date(item.start);
			this.dragEndDate = new Date(item.end);
			this.dragBarEl = bar;
			this.dragMoved = false;
			bar.addClass('bt-bar-dragging');
		});
		bar.addEventListener('pointermove', (e: PointerEvent) => {
			if (this.dragMode !== 'move' || this.dragItem !== item) return;
			const deltaX = e.clientX - this.dragStartX;
			this.dragMoved = this.dragMoved || Math.abs(deltaX) > DRAG_THRESHOLD;
			if (!this.dragMoved) return;
			const deltaMs = this.deltaXToMs(deltaX);
			const newStart = this.snapDate(new Date(this.dragStartDate!.getTime() + deltaMs));
			const duration = this.dragEndDate!.getTime() - this.dragStartDate!.getTime();
			const newEnd = new Date(newStart.getTime() + duration);
			this.updateBarPosition(bar, newStart, newEnd);
		});
		bar.addEventListener('pointerup', async (e: PointerEvent) => {
			if (this.dragMode !== 'move' || this.dragItem !== item) return;
			bar.removeClass('bt-bar-dragging');
			if (this.dragMoved) {
				const deltaX = e.clientX - this.dragStartX;
				const deltaMs = this.deltaXToMs(deltaX);
				const newStart = this.snapDate(new Date(this.dragStartDate!.getTime() + deltaMs));
				const duration = this.dragEndDate!.getTime() - this.dragStartDate!.getTime();
				const newEnd = new Date(newStart.getTime() + duration);
				if (DK(newStart) !== DK(this.dragStartDate!)) {
					await writeProp(this.app, item.file, this.dateProp!, DK(newStart));
					if (this.endProp && !item.isSingleDay) {
						await writeProp(this.app, item.file, this.endProp, DK(newEnd));
					}
					item.start = newStart;
					item.end = newEnd;
					this.updateBarPosition(bar, newStart, newEnd);
				} else {
					this.updateBarPosition(bar, item.start, item.end);
				}
			} else {
				// Click — open note
				const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(e as unknown as MouseEvent));
				leaf?.openFile(item.file);
			}
			this.clearDragState();
		});
		bar.addEventListener('pointercancel', () => {
			if (this.dragItem !== item) return;
			bar.removeClass('bt-bar-dragging');
			bar.removeClass('bt-bar-resizing');
			this.updateBarPosition(bar, item.start, item.end);
			this.clearDragState();
		});
	}

	private clearDragState() {
		this.dragItem = null;
		this.dragMode = null;
		this.dragBarEl = null;
		this.dragStartDate = null;
		this.dragEndDate = null;
		this.dragMoved = false;
	}

	// ── Context menu ───────────────────────────────────────────────────────────

	private attachBarContextMenu(bar: HTMLElement, item: TimelineItem) {
		bar.addEventListener('contextmenu', (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const menu = new Menu();

			menu.addItem(i => i.setTitle('Open').setIcon('file-text').onClick(() =>
				this.app.workspace.getLeaf(false)?.openFile(item.file)));
			menu.addItem(i => i.setTitle('Open in new tab').setIcon('file-plus').onClick(() =>
				this.app.workspace.getLeaf(true)?.openFile(item.file)));
			menu.addItem(i => i.setTitle('Open to the right').setIcon('separator-vertical').onClick(() =>
				this.app.workspace.getLeaf('split')?.openFile(item.file)));

			menu.addSeparator();

			menu.addItem(i => i.setTitle('Change start date…').setIcon('calendar').onClick(async () => {
				if (!this.dateProp) return;
				const modal = new DatePromptModal(this.app, item.start, 'Change start date');
				const newDate = await modal.open();
				if (!newDate || DK(newDate) === DK(item.start)) return;
				await writeProp(this.app, item.file, this.dateProp, DK(newDate));
				item.start = newDate;
				if (newDate > item.end) item.end = new Date(newDate);
				this.updateBarPosition(bar, item.start, item.end);
			}));

			if (this.endProp) {
				menu.addItem(i => i.setTitle('Change end date…').setIcon('calendar-range').onClick(async () => {
					const modal = new DatePromptModal(this.app, item.end, 'Change end date');
					const newDate = await modal.open();
					if (!newDate || DK(newDate) === DK(item.end)) return;
					if (newDate >= item.start) {
						await writeProp(this.app, item.file, this.endProp!, DK(newDate));
						item.end = newDate;
						item.isSingleDay = item.start.getTime() === newDate.getTime();
						this.updateBarPosition(bar, item.start, item.end);
					}
				}));
			}

			if (this.doneProp) {
				menu.addItem(i => i
					.setTitle(item.done ? 'Mark as not done' : 'Mark as done')
					.setIcon(item.done ? 'circle' : 'check-circle')
					.onClick(async () => {
						const newVal = !item.done;
						await writeProp(this.app, item.file, this.doneProp!, newVal);
						item.done = newVal;
						bar.toggleClass('bt-bar-done', newVal);
						const cb = bar.querySelector('.bt-bar-check');
						if (cb) cb.toggleClass('bt-bar-check-on', newVal);
					}));
			}

			menu.addSeparator();
			menu.addItem(i => i.setTitle('Delete').setIcon('trash').onClick(async () => {
				await this.app.vault.trash(item.file, true);
			}));

			menu.showAtMouseEvent(e);
		});
	}

	// ── Scroll to today ────────────────────────────────────────────────────────

	private scrollToToday(scroll: HTMLElement, cw: number) {
		if (!this.windowStart || !this.windowEnd) return;
		const today = new Date(); today.setHours(0, 0, 0, 0);
		const todayPx = LABEL_WIDTH + this.dateToPixel(today);
		const targetLeft = todayPx - scroll.clientWidth / 2;
		scroll.scrollLeft = Math.max(0, targetLeft);
	}

	// ── Create new note ────────────────────────────────────────────────────────

	private createTimelineNote() {
		const folder = ((this.config.get('newNoteFolder') as string) ?? '').trim();
		new QuickAddModal(this.app, this.plugin.settings, this.plugin, undefined, folder || undefined).open();
	}
}
