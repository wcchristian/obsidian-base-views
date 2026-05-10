import { BasesView, TFile, Notice, QueryController, HoverParent, HoverPopover, Keymap, BasesEntry, BasesPropertyId, parsePropertyId, Value, BooleanValue, StringValue, NumberValue, DateValue, TagValue, NullValue, Menu, App, Modal, Platform } from 'obsidian';
import BaseViewsPlugin from './main';
import { QuickAddModal } from './quick-add-modal';
import { AUTO_PALETTE } from './util';

export const VIEW_TYPE_BASE_CALENDAR = 'base-calendar-view';

type ViewMode = 'month' | 'week' | 'agenda';

interface CalEvent {
	id: string;
	title: string;
	dateKey: string;
	start: Date;
	end: Date | null;
	file: TFile;
	entry: BasesEntry;
	done: boolean;
	groupKey: string;
}

interface DayInfo {
	dateKey: string;
	date: Date;
	weekIdx: number;
	colIdx: number;
	isCurrentMonth: boolean;
	isToday: boolean;
	events: CalEvent[];
	cell: HTMLElement | null;
	numEl: HTMLElement | null;
	evList: HTMLElement | null;
}

interface WeekInfo {
	days: DayInfo[];
	overlay: HTMLElement | null;
}

const DK = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const MS_PER_DAY = 86400000;
const LANE_HEIGHT = 16;
const LANE_GAP = 2;

class DatePromptModal extends Modal {
	private resolvePromise: ((d: Date | null) => void) | null = null;

	constructor(app: App, private initial: Date, private title: string) {
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
		contentEl.createEl('h3', { text: this.title });
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

export class BaseCalendarView extends BasesView implements HoverParent {
	readonly type = VIEW_TYPE_BASE_CALENDAR;
	hoverPopover: HoverPopover | null = null;

	private wrap: HTMLElement;
	private events: CalEvent[] = [];
	private days: DayInfo[] = [];
	private weeks: WeekInfo[] = [];
	private curDate = new Date();
	private viewMode: ViewMode = 'month';
	private titleEl: HTMLElement | null = null;
	private bodyEl: HTMLElement | null = null;
	private hrowEl: HTMLElement | null = null;
	private modeButtons: { month: HTMLElement; week: HTMLElement; agenda: HTMLElement } | null = null;
	private dateProp: BasesPropertyId | null = null;
	private endProp: BasesPropertyId | null = null;
	private doneProp: BasesPropertyId | null = null;
	private propOrder: BasesPropertyId[] = [];
	private plugin: BaseViewsPlugin;
	private maxPerDay = 3;
	private monthExpand = false;
	private agendaDays = 30;
	private weekDays = 7;
	private weekRolling = false;
	private sortOrderProp: string | null = null;
	private grouped = false;
	private autoColorMap: Record<string, string> = {};

	private dragOrderId: string | null = null;
	private dragSourceDateKey: string | null = null;
	private dropIndicator: HTMLElement | null = null;

	private isSelecting = false;
	private selectionStart: DayInfo | null = null;
	private selectionEnd: DayInfo | null = null;
	private bgLayer: HTMLElement | null = null;
	private mouseUpHandler: ((e: MouseEvent) => void) | null = null;
	private morePopover: HTMLElement | null = null;
	private moreOutsideHandler: ((e: MouseEvent) => void) | null = null;

	constructor(ctrl: QueryController, parent: HTMLElement, plugin: BaseViewsPlugin) {
		super(ctrl);
		this.plugin = plugin;
		this.wrap = parent.createDiv('bc-wrap');
	}

	async onDataUpdated(): Promise<void> {
		this.events = [];
		this.wrap.empty();

		this.dateProp = this.config.getAsPropertyId('dateProperty') ?? null;
		this.endProp = this.config.getAsPropertyId('endDateProperty') ?? null;
		this.doneProp = this.config.getAsPropertyId('doneProperty') ?? null;
		this.propOrder = this.config.getOrder();

		const cfgMode = this.config.get('viewMode');
		if (cfgMode === 'month' || cfgMode === 'week' || cfgMode === 'agenda') {
			this.viewMode = cfgMode;
		}
		const mpd = this.config.get('maxPerDay');
		if (typeof mpd === 'number' && mpd >= 1) this.maxPerDay = Math.floor(mpd);
		this.monthExpand = !!this.config.get('monthExpand');
		const ad = this.config.get('agendaDays');
		if (typeof ad === 'number' && ad >= 1) this.agendaDays = Math.min(30, Math.floor(ad));

		const wd = this.config.get('weekDays');
		if (typeof wd === 'number' && wd >= 1) this.weekDays = Math.min(10, Math.floor(wd));
		this.weekRolling = !!this.config.get('weekRolling');

		const sop = this.config.getAsPropertyId('sortOrderProperty');
		this.sortOrderProp = sop ? parsePropertyId(sop).name : null;

		this.buildUI(this.wrap);
		await this.loadData();
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

	private buildUI(container: HTMLElement) {
		container.addClass('bc-wrap');
		if (Platform.isMobile) container.addClass('bc-mobile');

		const hdr = container.createDiv('bc-hdr');
		const nav = hdr.createDiv('bc-nav');

		const prev = nav.createEl('button', { cls: 'bc-btn' });
		prev.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>';

		const today = nav.createEl('button', { text: 'Today', cls: 'bc-today' });

		const next = nav.createEl('button', { cls: 'bc-btn' });
		next.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';

		this.titleEl = hdr.createEl('h2', { cls: 'bc-title' });

		const modeGroup = hdr.createDiv('bc-mode-group');
		const mMonth = modeGroup.createEl('button', { text: 'Month', cls: 'bc-mode' });
		const mWeek = modeGroup.createEl('button', { text: 'Week', cls: 'bc-mode' });
		const mAgenda = modeGroup.createEl('button', { text: 'Agenda', cls: 'bc-mode' });
		this.modeButtons = { month: mMonth, week: mWeek, agenda: mAgenda };
		mMonth.onclick = () => { this.viewMode = 'month'; this.render(); };
		mWeek.onclick = () => { this.viewMode = 'week'; this.render(); };
		mAgenda.onclick = () => { this.viewMode = 'agenda'; this.render(); };


		prev.onclick = () => {
			if (this.viewMode === 'month') this.curDate = new Date(this.curDate.getFullYear(), this.curDate.getMonth() - 1, 1);
			else if (this.viewMode === 'week') this.curDate = new Date(this.curDate.getTime() - this.weekDays * MS_PER_DAY);
			else this.curDate = new Date(this.curDate.getTime() - this.agendaDays * MS_PER_DAY);
			this.render();
		};
		next.onclick = () => {
			if (this.viewMode === 'month') this.curDate = new Date(this.curDate.getFullYear(), this.curDate.getMonth() + 1, 1);
			else if (this.viewMode === 'week') this.curDate = new Date(this.curDate.getTime() + this.weekDays * MS_PER_DAY);
			else this.curDate = new Date(this.curDate.getTime() + this.agendaDays * MS_PER_DAY);
			this.render();
		};
		today.onclick = () => { this.curDate = new Date(); this.render(); };

		const grid = container.createDiv('bc-grid');

		const bgUrl = this.config.get('bgImage') as string | null;
		this.bgLayer = null;
		if (bgUrl && bgUrl.trim()) {
			const resolved = this.resolveBgUrl(bgUrl);
			this.bgLayer = grid.createDiv('bc-bg-layer');
			this.bgLayer.style.backgroundImage = `url("${resolved}")`;
			const fit = (this.config.get('bgFit') as string) || 'cover';
			this.bgLayer.style.backgroundSize = fit === 'stretch' ? '100% 100%' : fit;
			const blur = this.config.get('bgBlur') as number | null;
			if (blur && blur > 0) this.bgLayer.style.filter = `blur(${blur}px)`;
			const opacity = this.config.get('bgOpacity') as number | null;
			this.bgLayer.style.opacity = String(opacity ?? 0.3);
		}

		this.hrowEl = grid.createDiv('bc-hrow');
		this.bodyEl = grid.createDiv('bc-body');

		this.render();

		if (this.mouseUpHandler) {
			document.removeEventListener('mouseup', this.mouseUpHandler);
		}

		const finishSelection = async () => {
			if (!this.isSelecting) return;
			this.isSelecting = false;
			const [start, end] = this.getSelectionRange();
			this.clearSelectionHighlight();
			const startDate = start?.date;
			const endDate = start !== end ? (end?.date ?? null) : null;
			if (startDate && endDate) {
				await this.createNote(startDate, endDate);
			}
			this.selectionStart = null;
			this.selectionEnd = null;
		};
		this.mouseUpHandler = finishSelection;
		document.addEventListener('mouseup', this.mouseUpHandler);
	}

	private getSelectionRange(): [DayInfo | null, DayInfo | null] {
		if (!this.selectionStart) return [null, null];
		const a = this.selectionStart;
		const b = this.selectionEnd ?? this.selectionStart;
		if (a.date.getTime() <= b.date.getTime()) return [a, b === a ? null : b];
		return [b, a];
	}

	private updateSelectionHighlight() {
		this.days.forEach(d => d.cell?.removeClass('bc-selecting'));
		const [start, end] = this.getSelectionRange();
		if (!start) return;
		const startTime = start.date.getTime();
		const endTime = end ? end.date.getTime() : startTime;
		this.days.forEach(d => {
			const t = d.date.getTime();
			if (t >= startTime && t <= endTime) {
				d.cell?.addClass('bc-selecting');
			}
		});
	}

	private clearSelectionHighlight() {
		this.days.forEach(d => d.cell?.removeClass('bc-selecting'));
	}

	private render() {
		if (!this.titleEl || !this.bodyEl || !this.hrowEl) return;
		this.closeMorePopover();
		this.bodyEl.empty();
		this.hrowEl.empty();
		this.days = [];
		this.weeks = [];

		if (this.modeButtons) {
			Object.entries(this.modeButtons).forEach(([k, btn]) => {
				btn.toggleClass('bc-mode-active', k === this.viewMode);
			});
		}

		this.bodyEl.removeClass('bc-body-month');
		this.bodyEl.removeClass('bc-body-week');
		this.bodyEl.removeClass('bc-body-agenda');
		this.bodyEl.removeClass('bc-body-month-expand');
		this.hrowEl.style.display = '';

		if (this.viewMode === 'month') {
			this.bodyEl.addClass('bc-body-month');
			if (this.monthExpand) this.bodyEl.addClass('bc-body-month-expand');
			this.renderMonth();
		} else if (this.viewMode === 'week') {
			this.bodyEl.addClass('bc-body-week');
			this.renderWeek();
		} else {
			this.bodyEl.addClass('bc-body-agenda');
			this.hrowEl.style.display = 'none';
			this.renderAgenda();
		}

		this.placeEvents();
	}

	private renderMonth() {
		if (!this.titleEl || !this.bodyEl || !this.hrowEl) return;
		this.titleEl.textContent = this.curDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

		// Always 7 columns for month view
		this.bodyEl.style.setProperty('--bc-cols', '7');
		this.hrowEl.style.setProperty('--bc-cols', '7');
		['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => this.hrowEl!.createEl('div', { text: d, cls: 'bc-dname' }));

		const yr = this.curDate.getFullYear();
		const mo = this.curDate.getMonth();
		const today = new Date(); today.setHours(0,0,0,0);
		const first = new Date(yr, mo, 1);
		const off = first.getDay();
		const dim = new Date(yr, mo + 1, 0).getDate();
		const dpm = new Date(yr, mo, 0).getDate();

		for (let w = 0; w < 6; w++) {
			const weekRow = this.bodyEl.createDiv('bc-week');
			const weekDays: DayInfo[] = [];

			for (let c = 0; c < 7; c++) {
				const i = w * 7 + c;
				let dt: Date;
				let cur = true;
				if (i < off) { dt = new Date(yr, mo - 1, dpm - off + i + 1); cur = false; }
				else if (i >= off + dim) { dt = new Date(yr, mo + 1, i - off - dim + 1); cur = false; }
				else { dt = new Date(yr, mo, i - off + 1); }
				dt.setHours(0,0,0,0);
				const info = this.makeCell(weekRow, dt, w, c, today, cur);
				weekDays.push(info);
			}

			const overlay = weekRow.createDiv('bc-md-overlay');
			this.weeks.push({ days: weekDays, overlay });
		}
	}

	private renderWeek() {
		if (!this.titleEl || !this.bodyEl || !this.hrowEl) return;

		const today = new Date(); today.setHours(0,0,0,0);
		let weekStart: Date;

		if (this.weekRolling) {
			// Rolling: start from today (or curDate)
			const cur = new Date(this.curDate); cur.setHours(0,0,0,0);
			weekStart = cur;
		} else {
			// Fixed: start from Sunday of current week
			const cur = new Date(this.curDate); cur.setHours(0,0,0,0);
			weekStart = new Date(cur.getTime() - cur.getDay() * MS_PER_DAY);
		}

		const weekEnd = new Date(weekStart.getTime() + (this.weekDays - 1) * MS_PER_DAY);

		const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		this.titleEl.textContent = `${fmt(weekStart)} — ${fmt(weekEnd)}, ${weekEnd.getFullYear()}`;

		// Set CSS variable for column count
		this.bodyEl.style.setProperty('--bc-cols', String(this.weekDays));
		this.hrowEl.style.setProperty('--bc-cols', String(this.weekDays));

		// Generate day headers from actual dates
		for (let c = 0; c < this.weekDays; c++) {
			const dt = new Date(weekStart.getTime() + c * MS_PER_DAY);
			const dayName = dt.toLocaleDateString('en-US', { weekday: 'short' });
			this.hrowEl.createEl('div', { text: dayName, cls: 'bc-dname' });
		}

		const weekRow = this.bodyEl.createDiv('bc-week');
		const weekDays: DayInfo[] = [];
		for (let c = 0; c < this.weekDays; c++) {
			const dt = new Date(weekStart.getTime() + c * MS_PER_DAY);
			dt.setHours(0,0,0,0);
			const info = this.makeCell(weekRow, dt, 0, c, today, true);
			weekDays.push(info);
		}
		const overlay = weekRow.createDiv('bc-md-overlay');
		this.weeks.push({ days: weekDays, overlay });
	}

	private renderAgenda() {
		if (!this.titleEl || !this.bodyEl) return;
		const today = new Date(); today.setHours(0,0,0,0);
		const start = new Date(this.curDate); start.setHours(0,0,0,0);
		const end = new Date(start.getTime() + (this.agendaDays - 1) * MS_PER_DAY);

		const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
		this.titleEl.textContent = `${fmt(start)} — ${fmt(end)}, ${end.getFullYear()}`;

		for (let i = 0; i < this.agendaDays; i++) {
			const dt = new Date(start.getTime() + i * MS_PER_DAY); dt.setHours(0,0,0,0);
			const dk = DK(dt);
			const isT = dt.getTime() === today.getTime();
			const section = this.bodyEl.createDiv('bc-agenda-day' + (isT ? ' bc-agenda-today' : ''));
			const header = section.createDiv('bc-agenda-date');
			header.createSpan({ cls: 'bc-agenda-dow', text: dt.toLocaleDateString('en-US', { weekday: 'short' }) });
			header.createSpan({ cls: 'bc-agenda-num', text: String(dt.getDate()) });
			header.createSpan({ cls: 'bc-agenda-mon', text: dt.toLocaleDateString('en-US', { month: 'short' }) });
			const list = section.createDiv('bc-agenda-list');
			const addBtn = section.createEl('button', { cls: 'bc-add bc-add-agenda', attr: { 'aria-label': 'Add note for this day', title: 'Add note for this day', type: 'button' } });
			addBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
			addBtn.onclick = e => {
				e.preventDefault();
				e.stopPropagation();
				this.createNote(dt, null);
			};
			const info: DayInfo = {
				dateKey: dk, date: dt, weekIdx: 0, colIdx: 0,
				isCurrentMonth: true, isToday: isT, events: [],
				cell: section, numEl: null, evList: list
			};
			this.attachDropTarget(section, list, info);
			this.days.push(info);
		}
	}

	private makeCell(parent: HTMLElement, dt: Date, w: number, c: number, today: Date, cur: boolean): DayInfo {
		const dk = DK(dt);
		const isT = dt.getTime() === today.getTime();
		const cell = parent.createDiv('bc-cell' + (cur ? '' : ' bc-other') + (isT ? ' bc-today' : ''));
		const num = cell.createEl('span', { cls: 'bc-num', text: String(dt.getDate()) });
		const addBtn = cell.createEl('button', { cls: 'bc-add', attr: { 'aria-label': 'Add note for this day', title: 'Add note for this day', type: 'button' } });
		addBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
		addBtn.onclick = e => {
			e.preventDefault();
			e.stopPropagation();
			this.createNote(dt, null);
		};
		addBtn.addEventListener('mousedown', e => { e.stopPropagation(); });
		const el = cell.createDiv('bc-evs');
		const info: DayInfo = { dateKey: dk, date: dt, weekIdx: w, colIdx: c, isCurrentMonth: cur, isToday: isT, events: [], cell, numEl: num, evList: el };
		this.days.push(info);

		this.attachDropTarget(cell, el, info);

		cell.addEventListener('mousedown', e => {
			if (e.button !== 0) return;
			if ((e.target as HTMLElement).closest('.bc-chip')) return;
			if ((e.target as HTMLElement).closest('.bc-md-bar')) return;
			if ((e.target as HTMLElement).closest('.bc-more')) return;
			if ((e.target as HTMLElement).closest('.bc-add')) return;
			this.isSelecting = true;
			this.selectionStart = info;
			this.selectionEnd = info;
			this.updateSelectionHighlight();
		});
		cell.addEventListener('mouseenter', () => {
			if (this.isSelecting) {
				this.selectionEnd = info;
				this.updateSelectionHighlight();
			}
		});
		cell.addEventListener('dblclick', e => {
			if ((e.target as HTMLElement).closest('.bc-chip')) return;
			if ((e.target as HTMLElement).closest('.bc-md-bar')) return;
			if ((e.target as HTMLElement).closest('.bc-more')) return;
			if ((e.target as HTMLElement).closest('.bc-add')) return;
			e.preventDefault();
			e.stopPropagation();
			this.createNote(dt, null);
		});
		return info;
	}

	private placeEvents() {
		this.days.forEach(d => { d.events = []; });
		this.weeks.forEach(wk => { if (wk.overlay) wk.overlay.empty(); });

		const isAgenda = this.viewMode === 'agenda';
		const singleDayByDate = new Map<string, CalEvent[]>();
		const multiByWeek: { ev: CalEvent; startCol: number; endCol: number; isStart: boolean; isEnd: boolean }[][] = this.weeks.map(() => []);

		for (const ev of this.events) {
			const isMulti = !!ev.end && ev.end.getTime() > ev.start.getTime();

			if (isAgenda) {
				if (isMulti) {
					const evEndT = (ev.end as Date).getTime();
					const evStartT = ev.start.getTime();
					this.days.forEach(d => {
						const t = d.date.getTime();
						if (t >= evStartT && t <= evEndT) {
							const list = singleDayByDate.get(d.dateKey) ?? [];
							list.push(ev);
							singleDayByDate.set(d.dateKey, list);
						}
					});
				} else {
					const list = singleDayByDate.get(ev.dateKey) ?? [];
					list.push(ev);
					singleDayByDate.set(ev.dateKey, list);
				}
				continue;
			}

			if (!isMulti) {
				const list = singleDayByDate.get(ev.dateKey) ?? [];
				list.push(ev);
				singleDayByDate.set(ev.dateKey, list);
				continue;
			}

			const evStartT = ev.start.getTime();
			const evEndT = (ev.end as Date).getTime();
			this.weeks.forEach((wk, wIdx) => {
				const weekStartT = wk.days[0].date.getTime();
				const weekEndT = wk.days[wk.days.length - 1].date.getTime();
				if (evEndT < weekStartT || evStartT > weekEndT) return;

				const segStartT = Math.max(evStartT, weekStartT);
				const segEndT = Math.min(evEndT, weekEndT);
				const startCol = Math.round((segStartT - weekStartT) / MS_PER_DAY);
				const endCol = Math.round((segEndT - weekStartT) / MS_PER_DAY);
				multiByWeek[wIdx].push({
					ev, startCol, endCol,
					isStart: evStartT >= weekStartT,
					isEnd: evEndT <= weekEndT
				});
			});
		}

		this.days.forEach(d => {
			if (!d.evList) return;
			d.evList.empty();
			let evs = singleDayByDate.get(d.dateKey) ?? [];

			// Sort: localOrder first, then sortOrderProperty if configured, else Bases-supplied order
			const order = this.plugin.settings.localOrder[d.dateKey];
			if (order && order.length > 0) {
				const out: CalEvent[] = [];
				const remaining = [...evs];
				for (const id of order) {
					const idx = remaining.findIndex(e => e.id === id);
					if (idx !== -1) out.push(remaining.splice(idx, 1)[0]);
				}
				evs = [...out, ...remaining];
			} else if (this.sortOrderProp) {
				evs = [...evs].sort((a, b) => {
					const va = a.entry.getValue(`note.${this.sortOrderProp}` as BasesPropertyId);
					const vb = b.entry.getValue(`note.${this.sortOrderProp}` as BasesPropertyId);
					const na = va && !(va instanceof NullValue) ? parseFloat(va.toString()) : Infinity;
					const nb = vb && !(vb instanceof NullValue) ? parseFloat(vb.toString()) : Infinity;
					return na - nb;
				});
			}
			// else: use Bases-supplied order (no modification)

			d.events = evs;

			if (this.viewMode === 'month' && !this.monthExpand && evs.length > this.maxPerDay) {
				const visible = evs.slice(0, this.maxPerDay - 1);
				this.renderDayChips(d.evList, visible);
				const more = d.evList.createDiv('bc-more');
				const hidden = evs.length - visible.length;
				more.textContent = `+${hidden} more`;
				more.onclick = (e) => {
					e.stopPropagation();
					this.openMorePopover(d, more, false);
				};

				// Hover popover support
				let hoverTimer: number | null = null;
				d.cell!.addEventListener('mouseenter', () => {
					if (this.morePopover) return; // already open (click-pinned)
					hoverTimer = window.setTimeout(() => this.openMorePopover(d, more, true), 200);
				});
				d.cell!.addEventListener('mouseleave', () => {
					if (hoverTimer !== null) { clearTimeout(hoverTimer); hoverTimer = null; }
				});
			} else {
				this.renderDayChips(d.evList, evs);
			}
		});

		this.weeks.forEach((wk, wIdx) => {
			const segs = multiByWeek[wIdx];

			if (this.monthExpand && this.viewMode === 'month') {
				// Inline mode: render a bar in each day's evList instead of the overlay
				if (segs.length === 0) return;
				segs.sort((a, b) => a.startCol - b.startCol || (b.endCol - b.startCol) - (a.endCol - a.startCol));
				for (const seg of segs) {
					for (let col = seg.startCol; col <= seg.endCol; col++) {
						const day = wk.days[col];
						if (!day?.evList) continue;
						const bar = day.evList.createDiv('bc-md-inline');
						const color = this.getEventColor(seg.ev);
						if (color) {
							bar.style.background = `color-mix(in srgb, ${color} 60%, var(--background-primary))`;
						} else {
							bar.style.background = `color-mix(in srgb, var(--interactive-accent) 35%, var(--background-primary))`;
						}
						if (col === seg.startCol) {
							bar.textContent = seg.ev.title;
							bar.title = seg.ev.title;
						} else {
							bar.style.opacity = '0.6';
						}
						bar.onclick = (e) => {
							e.stopPropagation();
							const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(e as MouseEvent));
							leaf?.openFile(seg.ev.file);
						};
					}
				}
				return;
			}

			if (!wk.overlay) return;
			if (segs.length === 0) {
				wk.overlay.style.height = '0px';
				wk.days.forEach(d => { if (d.evList) d.evList.style.paddingTop = '0px'; });
				return;
			}

			segs.sort((a, b) => a.startCol - b.startCol || (b.endCol - b.startCol) - (a.endCol - a.startCol));

			const lanes: number[] = [];
			const assigned: number[] = [];
			for (const seg of segs) {
				let lane = 0;
				while (lane < lanes.length && lanes[lane] >= seg.startCol) lane++;
				lanes[lane] = seg.endCol;
				assigned.push(lane);
			}

			const laneCount = lanes.length;
			const overlayHeight = laneCount * LANE_HEIGHT + (laneCount - 1) * LANE_GAP;
			wk.overlay.style.height = `${overlayHeight}px`;

			segs.forEach((seg, i) => {
				const lane = assigned[i];
				this.makeMultiDayBar(wk.overlay!, seg, lane);
			});

			wk.days.forEach(d => {
				if (d.evList) d.evList.style.paddingTop = `${overlayHeight + 4}px`;
			});
		});
	}

	private renderDayChips(parent: HTMLElement, evs: CalEvent[]) {
		if (!this.grouped) {
			evs.forEach(ev => this.makeChip(parent, ev));
			return;
		}
		const order: string[] = [];
		const byKey = new Map<string, CalEvent[]>();
		for (const ev of evs) {
			const k = ev.groupKey;
			if (!byKey.has(k)) { byKey.set(k, []); order.push(k); }
			byKey.get(k)!.push(ev);
		}
		for (const k of order) {
			const section = parent.createDiv('bc-group');
			const label = section.createDiv('bc-group-label');
			label.textContent = k || '—';
			label.title = k || '—';
			const items = section.createDiv('bc-group-items');
			for (const ev of byKey.get(k)!) {
				this.makeChip(items, ev);
			}
		}
	}

	private getViewColorMap(): Record<string, string> {
		const entries = this.config.get('colorValues') as string[] | null ?? [];
		const map: Record<string, string> = {};
		for (const entry of entries) {
			const i = entry.lastIndexOf(':');
			if (i > 0) map[entry.slice(0, i).trim()] = entry.slice(i + 1).trim();
		}
		return map;
	}

	private getEventColor(ev: CalEvent): string | null {
		const viewProp = this.getColorPropName();
		if (!viewProp) return null;

		const pid = `note.${viewProp}` as BasesPropertyId;
		const val = ev.entry.getValue(pid);
		if (val && !(val instanceof NullValue)) {
			const valStr = val.toString().trim();
			const viewMap = this.getViewColorMap();
			return viewMap[valStr] ?? this.autoColorMap[valStr] ?? null;
		}
		return null;
	}

	private getColorPropName(): string {
		const raw = (this.config.get('colorProperty') as string | undefined)?.trim();
		if (!raw) return '';
		return raw.startsWith('note.') ? raw.slice(5) : raw;
	}

	private makeMultiDayBar(overlay: HTMLElement, seg: { ev: CalEvent; startCol: number; endCol: number; isStart: boolean; isEnd: boolean }, lane: number) {
		const bar = overlay.createDiv('bc-md-bar' + (seg.ev.done ? ' bc-md-done' : ''));
		bar.style.gridColumn = `${seg.startCol + 1} / ${seg.endCol + 2}`;
		bar.style.top = `${lane * (LANE_HEIGHT + LANE_GAP)}px`;
		if (!seg.isStart) bar.addClass('bc-md-cont-left');
		if (!seg.isEnd) bar.addClass('bc-md-cont-right');

		const color = this.getEventColor(seg.ev);
		if (color) {
			bar.style.background = `color-mix(in srgb, ${color} 35%, var(--background-primary))`;
			if (seg.isStart) bar.style.borderLeft = `3px solid ${color}`;
		}

		if (this.doneProp) {
			const cb = bar.createDiv('bc-md-check' + (seg.ev.done ? ' bc-md-check-on' : ''));
			cb.onclick = async (e) => {
				e.stopPropagation();
				const newVal = !seg.ev.done;
				await this.writeProp(seg.ev.file, this.doneProp!, newVal ? 'true' : 'false');
				seg.ev.done = newVal;
				bar.toggleClass('bc-md-done', newVal);
				cb.toggleClass('bc-md-check-on', newVal);
			};
		}

		const label = bar.createSpan({ cls: 'bc-md-label', text: seg.ev.title });
		label.title = seg.ev.title;
		label.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(e as MouseEvent));
			leaf?.openFile(seg.ev.file);
		};
		bar.onmouseover = (e) => {
			this.app.workspace.trigger('hover-link', { event: e, source: 'bases', hoverParent: this, targetEl: bar, linktext: seg.ev.file.path });
		};
		bar.addEventListener('contextmenu', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showContextMenu(e, seg.ev);
		});

		bar.setAttribute('draggable', 'true');
		bar.addEventListener('dragstart', e => {
			e.dataTransfer?.setData('text/plain', seg.ev.id);
			e.dataTransfer!.effectAllowed = 'move';
			this.dragOrderId = seg.ev.id;
			this.dragSourceDateKey = seg.ev.dateKey;
			setTimeout(() => bar.addClass('bc-dragging'), 0);
		});
		bar.addEventListener('dragend', () => {
			bar.removeClass('bc-dragging');
			this.dragOrderId = null;
			this.dragSourceDateKey = null;
		});
	}

	private makeChip(container: HTMLElement, ev: CalEvent) {
		const chip = container.createDiv('bc-chip' + (ev.done ? ' bc-chip-done' : ''));
		const color = this.getEventColor(ev);
		if (color) {
			chip.style.borderLeft = `2px solid ${color}`;
			chip.style.background = `color-mix(in srgb, ${color} 12%, var(--background-primary))`;
		}

		const titleRow = chip.createDiv('bc-chip-title');

		if (this.doneProp) {
			const cb = titleRow.createDiv('bc-check' + (ev.done ? ' bc-check-on' : ''));
			cb.onclick = async (e) => {
				e.preventDefault();
				e.stopPropagation();
				const newVal = !ev.done;
				await this.writeProp(ev.file, this.doneProp!, newVal ? 'true' : 'false');
				ev.done = newVal;
				chip.toggleClass('bc-chip-done', newVal);
				cb.toggleClass('bc-check-on', newVal);
			};
		}

		const link = titleRow.createEl('a', { text: ev.title, cls: 'bc-chip-link', href: '#' });
		link.title = ev.title;
		link.onclick = e => {
			e.preventDefault();
			e.stopPropagation();
			const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(e as MouseEvent));
			leaf?.openFile(ev.file);
		};
		link.onmouseover = e => {
			this.app.workspace.trigger('hover-link', { event: e, source: 'bases', hoverParent: this, targetEl: chip, linktext: ev.file.path });
		};

		chip.onclick = e => {
			if ((e.target as HTMLElement).closest('.bc-check')) return;
			e.preventDefault();
			e.stopPropagation();
			const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(e as MouseEvent));
			leaf?.openFile(ev.file);
		};

		chip.addEventListener('contextmenu', e => {
			e.preventDefault();
			e.stopPropagation();
			this.showContextMenu(e, ev);
		});

		if (color) {
			chip.addEventListener('mouseenter', () => {
				chip.style.background = `color-mix(in srgb, ${color} 22%, var(--background-primary))`;
			});
			chip.addEventListener('mouseleave', () => {
				chip.style.background = `color-mix(in srgb, ${color} 12%, var(--background-primary))`;
			});
		}

		chip.addEventListener('dblclick', e => { e.stopPropagation(); });

		const props = chip.createDiv('bc-chip-props');
		this.propOrder.forEach(pid => {
			const { name } = parsePropertyId(pid);
			if (name === 'name') return;
			if (this.doneProp && pid === this.doneProp) return;
			const val = ev.entry.getValue(pid);
			if (!val || val instanceof NullValue) return;
			const row = props.createDiv('bc-prop-row');
			row.createSpan({ cls: 'bc-prop-label', text: this.config.getDisplayName(pid) + ': ' });
			this.renderPropVal(row, val, ev, pid);
		});

		chip.setAttribute('draggable', 'true');
		chip.addEventListener('dragstart', e => {
			e.dataTransfer?.setData('text/plain', ev.id);
			e.dataTransfer!.effectAllowed = 'move';
			this.dragOrderId = ev.id;
			this.dragSourceDateKey = ev.dateKey;
			setTimeout(() => chip.addClass('bc-dragging'), 0);
		});
		chip.addEventListener('dragend', () => {
			chip.removeClass('bc-dragging');
			this.dragOrderId = null;
			this.dragSourceDateKey = null;
			this.removeDropIndicator();
		});
	}

	private showContextMenu(e: MouseEvent, ev: CalEvent) {
		const menu = new Menu();
		menu.addItem(item => item.setTitle('Open in new tab').setIcon('file-plus').onClick(() => {
			this.app.workspace.getLeaf('tab').openFile(ev.file);
		}));
		menu.addItem(item => item.setTitle('Open to the right').setIcon('separator-vertical').onClick(() => {
			this.app.workspace.getLeaf('split').openFile(ev.file);
		}));
		menu.addSeparator();
		menu.addItem(item => item.setTitle('Change date…').setIcon('calendar').onClick(async () => {
			const d = await new DatePromptModal(this.app, ev.start, `Change date for "${ev.title}"`).open();
			if (d) await this.moveEvent(ev.id, d);
		}));
		menu.addItem(item => item.setTitle('Duplicate').setIcon('copy').onClick(async () => {
			await this.duplicateEvent(ev);
		}));
		menu.addSeparator();
		menu.addItem(item => item.setTitle('Delete').setIcon('trash').setWarning(true).onClick(async () => {
			await this.app.fileManager.trashFile(ev.file);
			new Notice(`Trashed "${ev.title}"`);
		}));
		menu.showAtMouseEvent(e);
	}

	private async duplicateEvent(ev: CalEvent) {
		const dir = ev.file.parent?.path ?? '';
		let base = `${ev.file.basename} (copy)`;
		let path = dir ? `${dir}/${base}.md` : `${base}.md`;
		let i = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			base = `${ev.file.basename} (copy ${i})`;
			path = dir ? `${dir}/${base}.md` : `${base}.md`;
			i++;
		}
		try {
			const newFile = await this.app.vault.copy(ev.file, path);
			this.app.workspace.getLeaf(false)?.openFile(newFile);
		} catch (err) {
			console.error(err);
			new Notice('Failed to duplicate');
		}
	}

	private openMorePopover(day: DayInfo, anchor: HTMLElement, isHover: boolean) {
		this.closeMorePopover();
		const pop = document.body.createDiv('bc-more-popover');
		this.morePopover = pop;

		const title = pop.createDiv('bc-more-title');
		title.textContent = day.date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
		const list = pop.createDiv('bc-more-list');
		this.renderDayChips(list, day.events);

		const rect = anchor.getBoundingClientRect();
		pop.style.position = 'fixed';
		pop.style.left = `${rect.left}px`;
		pop.style.top = `${rect.bottom + 4}px`;
		pop.style.minWidth = `${Math.max(rect.width, 220)}px`;

		requestAnimationFrame(() => {
			const popRect = pop.getBoundingClientRect();
			if (popRect.right > window.innerWidth - 8) {
				pop.style.left = `${window.innerWidth - popRect.width - 8}px`;
			}
			if (popRect.bottom > window.innerHeight - 8) {
				pop.style.top = `${rect.top - popRect.height - 4}px`;
			}
		});

		if (isHover) {
			// For hover: close when leaving both the cell and the popover
			const cellEl = day.cell;
			let insideCell = false;
			let insidePop = false;

			const checkClose = () => {
				if (!insideCell && !insidePop) this.closeMorePopover();
			};

			if (cellEl) {
				cellEl.addEventListener('mouseleave', () => { insideCell = false; setTimeout(checkClose, 50); });
				cellEl.addEventListener('mouseenter', () => { insideCell = true; });
				insideCell = true;
			}
			pop.addEventListener('mouseenter', () => { insidePop = true; });
			pop.addEventListener('mouseleave', () => { insidePop = false; setTimeout(checkClose, 50); });
		} else {
			const handler = (e: MouseEvent) => {
				if (!this.morePopover) return;
				if (this.morePopover.contains(e.target as Node)) return;
				this.closeMorePopover();
			};
			this.moreOutsideHandler = handler;
			setTimeout(() => document.addEventListener('mousedown', handler), 0);
		}
	}

	private closeMorePopover() {
		if (this.morePopover) {
			this.morePopover.remove();
			this.morePopover = null;
		}
		if (this.moreOutsideHandler) {
			document.removeEventListener('mousedown', this.moreOutsideHandler);
			this.moreOutsideHandler = null;
		}
	}

	private renderPropVal(parent: HTMLElement, val: Value, ev: CalEvent, pid: BasesPropertyId) {
		if (val instanceof BooleanValue) {
			const checked = val.isTruthy();
			const tog = parent.createEl('div', { cls: 'bc-toggle' + (checked ? ' bc-toggle-on' : '') });
			tog.createEl('div', { cls: 'bc-toggle-knob' });
			tog.onclick = async (e) => {
				e.stopPropagation();
				const newVal = !checked;
				await this.writeProp(ev.file, pid, newVal ? 'true' : 'false');
				tog.toggleClass('bc-toggle-on', newVal);
			};
		} else if (val instanceof StringValue || val instanceof NumberValue || val instanceof TagValue || val instanceof DateValue) {
			const span = parent.createSpan({ cls: 'bc-prop-val', text: val.toString() });
			span.onclick = async (e) => {
				e.stopPropagation();
				const input = parent.createEl('input', { cls: 'bc-prop-input', value: val.toString(), type: 'text' });
				span.style.display = 'none';
				input.focus();
				input.select();
				const commit = async () => {
					await this.writeProp(ev.file, pid, input.value);
					input.remove();
					span.style.display = '';
				};
				input.onblur = commit;
				input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { input.remove(); span.style.display = ''; } };
			};
		} else {
			parent.createSpan({ cls: 'bc-prop-val', text: val.toString() });
		}
	}

	private async writeProp(file: TFile, pid: BasesPropertyId, raw: string) {
		const content = await this.app.vault.read(file);
		const fm = content.match(/^---\n([\s\S]*?)\n---/);
		const { name } = parsePropertyId(pid);

		if (!fm) {
			await this.app.vault.modify(file, `---\n${name}: ${raw}\n---\n\n${content}`);
			return;
		}

		const fmText = fm[1];
		const key = name.includes(' ') || name.includes('-') ? `"${name}"` : name;
		const re = new RegExp(`(${key}:\\s*)[^\\n]+`);

		let newFm: string;
		if (re.test(fmText)) {
			newFm = fmText.replace(re, `$1${raw}`);
		} else {
			newFm = `${key}: ${raw}\n${fmText}`;
		}

		await this.app.vault.modify(file, content.replace(/^---\n[\s\S]*?\n---/, `---\n${newFm}\n---`));
	}

	private positionDropIndicator(e: DragEvent, evList: HTMLElement) {
		if (!this.dropIndicator) {
			this.dropIndicator = document.createElement('div');
			this.dropIndicator.className = 'bc-drop-line';
		}
		const chips = Array.from(evList.querySelectorAll('.bc-chip'));
		let before: HTMLElement | null = null;
		for (const c of chips) {
			const rect = (c as HTMLElement).getBoundingClientRect();
			if (e.clientY < rect.top + rect.height / 2) { before = c as HTMLElement; break; }
		}
		if (before) evList.insertBefore(this.dropIndicator, before);
		else evList.appendChild(this.dropIndicator);
	}

	private removeDropIndicator() {
		if (this.dropIndicator && this.dropIndicator.parentNode) {
			this.dropIndicator.parentNode.removeChild(this.dropIndicator);
		}
	}

	private attachDropTarget(cellEl: HTMLElement, listEl: HTMLElement, info: DayInfo) {
		cellEl.addEventListener('dragover', e => {
			e.preventDefault();
			e.dataTransfer!.dropEffect = 'move';
			cellEl.addClass('bc-drop');
			this.positionDropIndicator(e, listEl);
		});
		cellEl.addEventListener('dragleave', e => {
			if (!cellEl.contains(e.relatedTarget as Node)) {
				cellEl.removeClass('bc-drop');
				this.removeDropIndicator();
			}
		});
		cellEl.addEventListener('drop', async e => {
			e.preventDefault();
			cellEl.removeClass('bc-drop');
			const id = e.dataTransfer?.getData('text/plain');
			if (!id) return;
			if (this.dragSourceDateKey === info.dateKey) {
				await this.reorderEvent(id, listEl);
			} else {
				this.removeDropIndicator();
				await this.moveEvent(id, info.date);
			}
			this.dragOrderId = null;
			this.dragSourceDateKey = null;
		});
	}

	private async reorderEvent(dragId: string, evList: HTMLElement) {
		const chips = Array.from(evList.querySelectorAll('.bc-chip')) as HTMLElement[];
		const indicatorIdx = this.dropIndicator ? Array.from(evList.children).indexOf(this.dropIndicator) : chips.length;
		this.removeDropIndicator();

		const day = this.days.find(d => d.evList === evList);
		if (!day) return;

		const ids = day.events.map(e => e.id);
		const fromIdx = ids.indexOf(dragId);
		if (fromIdx === -1) return;

		const chipsBefore = chips.slice(0, indicatorIdx).filter(c => c !== this.dropIndicator);
		let toIdx = chipsBefore.length;
		if (toIdx > fromIdx) toIdx--;
		if (fromIdx === toIdx) return;

		ids.splice(fromIdx, 1);
		ids.splice(toIdx, 0, dragId);
		this.plugin.settings.localOrder[day.dateKey] = ids;
		await this.plugin.saveSettings();

		// Write sortOrderProperty to frontmatter if configured
		if (this.sortOrderProp && this.dateProp) {
			for (let i = 0; i < ids.length; i++) {
				const ev = this.events.find(e => e.id === ids[i]);
				if (ev) {
					try {
						const sortPropId = `note.${this.sortOrderProp}` as BasesPropertyId;
						await this.writeProp(ev.file, sortPropId, String(i * 10));
					} catch (err) {
						console.error('Failed to write sort order prop:', err);
					}
				}
			}
		}

		this.placeEvents();
	}

	private async moveEvent(id: string, newDate: Date) {
		const ev = this.events.find(e => e.id === id);
		if (!ev) return;
		const ds = DK(newDate);
		try {
			if (this.dateProp) await this.writeProp(ev.file, this.dateProp, ds);
			if (ev.end && this.endProp) {
				const delta = newDate.getTime() - ev.start.getTime();
				const newEnd = new Date(ev.end.getTime() + delta);
				await this.writeProp(ev.file, this.endProp, DK(newEnd));
				ev.end = newEnd;
			}
			ev.start = newDate;
			ev.dateKey = ds;
			this.placeEvents();
			new Notice(`Moved "${ev.title}" to ${ds}`);
		} catch (err) {
			console.error(err);
			new Notice('Failed to update date');
		}
	}

	private createNote(startDate: Date, _endDate: Date | null) {
		new QuickAddModal(this.app, this.plugin.settings, this.plugin, `Note ${DK(startDate)}`).open();
	}

	private async loadData() {
		const groups = this.data.groupedData;
		if (!groups?.length) return;

		this.grouped = groups.some(g => g.hasKey());
		this.events = [];
		const dp = this.dateProp;
		const ep = this.endProp;
		const donePid = this.doneProp;

		for (const group of groups) {
			const gKey = group.hasKey() && group.key ? group.key.toString() : '';
			for (const entry of group.entries) {
				const file = entry.file;
				if (!(file instanceof TFile)) continue;
				if (!dp) continue;

				const val = entry.getValue(dp);
				if (!val) continue;

				const sd = new Date(val.toString() + 'T00:00:00');
				if (isNaN(sd.getTime())) continue;
				sd.setHours(0,0,0,0);

				let ed: Date | null = null;
				if (ep) {
					const ev2 = entry.getValue(ep);
					if (ev2 && !(ev2 instanceof NullValue)) {
						const d2 = new Date(ev2.toString() + 'T00:00:00');
						if (!isNaN(d2.getTime())) { d2.setHours(0,0,0,0); ed = d2; }
					}
				}

				let done = false;
				if (donePid) {
					const dv = entry.getValue(donePid);
					if (dv instanceof BooleanValue) done = dv.isTruthy();
				}

				this.events.push({
					id: file.path,
					title: file.basename,
					dateKey: DK(sd),
					start: sd, end: ed,
					file, entry, done,
					groupKey: gKey
				});
			}
		}

		// Build auto-color map when colorProperty set but no colorValues configured
		this.autoColorMap = {};
		const colorPropName = this.getColorPropName();
		if (colorPropName && Object.keys(this.getViewColorMap()).length === 0) {
			const pid = `note.${colorPropName}` as BasesPropertyId;
			const unique = [...new Set(
				this.events
					.map(ev => ev.entry.getValue(pid))
					.filter((v): v is NonNullable<typeof v> => !!v && !(v instanceof NullValue))
					.map(v => v.toString().trim())
					.filter(Boolean),
			)].sort();
			unique.forEach((v, i) => { this.autoColorMap[v] = AUTO_PALETTE[i % AUTO_PALETTE.length]; });
		}

		this.placeEvents();
	}
}
