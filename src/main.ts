import {
  Plugin, BasesView, QueryController,
  BasesAllOptions, BasesDropdownOption, BasesSliderOption,
  BasesTextOption, BasesMultitextOption, BasesToggleOption,
} from 'obsidian';
import { BaseCalendarView, VIEW_TYPE_BASE_CALENDAR } from './calendar-view';
import { BaseKanbanView, VIEW_TYPE_BASE_KANBAN } from './kanban-view';
import { BaseViewsSettings, DEFAULT_SETTINGS, BaseViewsSettingTab, migrateSettings } from './settings';
import { QuickAddModal } from './quick-add-modal';

class DisabledView extends BasesView {
  readonly type: string;

  constructor(ctrl: QueryController, parent: HTMLElement, viewType: string, viewName: string) {
    super(ctrl);
    this.type = viewType;
    const msg = parent.createDiv();
    msg.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:var(--font-ui-small);padding:24px;text-align:center;';
    msg.textContent = `${viewName} view is disabled. Enable it in Base Views plugin settings.`;
  }

  async onDataUpdated(): Promise<void> {}
}

export default class BaseViewsPlugin extends Plugin {
  settings: BaseViewsSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.registerBasesView(VIEW_TYPE_BASE_CALENDAR, {
      name: 'Calendar',
      icon: 'calendar',
      factory: (controller, containerEl) => {
        if (!this.settings.enableCalendar) {
          return new DisabledView(controller, containerEl, VIEW_TYPE_BASE_CALENDAR, 'Calendar');
        }
        return new BaseCalendarView(controller, containerEl, this);
      },
      options: () => ([
        {
          type: 'group',
          displayName: 'Properties',
          items: [
            { type: 'property', displayName: 'Date property', key: 'dateProperty' },
            { type: 'property', displayName: 'End date property', key: 'endDateProperty' },
            { type: 'property', displayName: 'Done property', key: 'doneProperty' },
          ],
        },
        {
          type: 'group',
          displayName: 'Display',
          items: [
            {
              type: 'dropdown',
              displayName: 'Default view',
              key: 'viewMode',
              default: 'month',
              options: { month: 'Month', week: 'Week', agenda: 'Agenda' },
            } as BasesDropdownOption,
            {
              type: 'slider',
              displayName: 'Max events per day (month view)',
              key: 'maxPerDay',
              default: 3,
              min: 1,
              max: 10,
              step: 1,
            } as BasesSliderOption,
          ],
        },
        {
          type: 'group',
          displayName: 'Color',
          items: [
            { type: 'property', displayName: 'Color by property', key: 'colorProperty' },
            {
              type: 'multitext',
              displayName: 'Value colors (value:color)',
              key: 'colorValues',
              default: [],
            } as BasesMultitextOption,
          ],
        },
        {
          type: 'group',
          displayName: 'Background image',
          items: [
            {
              type: 'text',
              displayName: 'Image URL or vault path',
              key: 'bgImage',
              placeholder: 'https://... or path/to/image.png',
            } as BasesTextOption,
            {
              type: 'dropdown',
              displayName: 'Fit',
              key: 'bgFit',
              default: 'cover',
              options: { cover: 'Cover', contain: 'Contain', stretch: 'Stretch' },
            } as BasesDropdownOption,
            {
              type: 'slider',
              displayName: 'Blur',
              key: 'bgBlur',
              default: 0,
              min: 0,
              max: 20,
              step: 1,
            } as BasesSliderOption,
            {
              type: 'slider',
              displayName: 'Opacity',
              key: 'bgOpacity',
              default: 0.3,
              min: 0,
              max: 1,
              step: 0.05,
            } as BasesSliderOption,
          ],
        },
      ] as BasesAllOptions[])
    });

    this.registerBasesView(VIEW_TYPE_BASE_KANBAN, {
      name: 'Kanban',
      icon: 'columns-3',
      factory: (controller, containerEl) => {
        if (!this.settings.enableKanban) {
          return new DisabledView(controller, containerEl, VIEW_TYPE_BASE_KANBAN, 'Kanban');
        }
        return new BaseKanbanView(controller, containerEl);
      },
      options: () => ([
        {
          type: 'group',
          displayName: 'Layout',
          items: [
            { type: 'property', displayName: 'Sub-group by', key: 'subgroupProperty' },
            {
              type: 'toggle',
              displayName: 'Show empty columns',
              key: 'showEmptyColumns',
              default: true,
            } as BasesToggleOption,
          ],
        },
        {
          type: 'group',
          displayName: 'Cards',
          items: [
            { type: 'property', displayName: 'Card title property', key: 'cardTitleProperty' },
            { type: 'property', displayName: 'Done property', key: 'doneProperty' },
          ],
        },
        {
          type: 'group',
          displayName: 'Column order',
          items: [
            {
              type: 'multitext',
              displayName: 'Column order',
              key: 'columnOrder',
              default: [],
            } as BasesMultitextOption,
            {
              type: 'multitext',
              displayName: 'Hidden columns',
              key: 'hiddenColumns',
              default: [],
            } as BasesMultitextOption,
            {
              type: 'multitext',
              displayName: 'Collapsed columns',
              key: 'collapsedColumns',
              default: [],
            } as BasesMultitextOption,
          ],
        },
        {
          type: 'group',
          displayName: 'Sub-groups',
          items: [
            {
              type: 'multitext',
              displayName: 'Hidden sub-groups',
              key: 'hiddenSubgroups',
              default: [],
            } as BasesMultitextOption,
          ],
        },
        {
          type: 'group',
          displayName: 'Colors',
          items: [
            {
              type: 'multitext',
              displayName: 'Column colors (value:color)',
              key: 'columnColors',
              default: [],
            } as BasesMultitextOption,
            {
              type: 'dropdown',
              displayName: 'Apply color to',
              key: 'columnColorMode',
              default: 'header',
              options: { header: 'Header accent', column: 'Whole column', both: 'Header + card border' },
            } as BasesDropdownOption,
          ],
        },
        {
          type: 'group',
          displayName: 'Background image',
          items: [
            {
              type: 'text',
              displayName: 'Image URL or vault path',
              key: 'bgImage',
              placeholder: 'https://... or path/to/image.png',
            } as BasesTextOption,
            {
              type: 'dropdown',
              displayName: 'Fit',
              key: 'bgFit',
              default: 'cover',
              options: { cover: 'Cover', contain: 'Contain', stretch: 'Stretch' },
            } as BasesDropdownOption,
            {
              type: 'slider',
              displayName: 'Blur',
              key: 'bgBlur',
              default: 0,
              min: 0,
              max: 20,
              step: 1,
            } as BasesSliderOption,
            {
              type: 'slider',
              displayName: 'Opacity',
              key: 'bgOpacity',
              default: 0.3,
              min: 0,
              max: 1,
              step: 0.05,
            } as BasesSliderOption,
          ],
        },
      ] as BasesAllOptions[]),
    });

    this.addSettingTab(new BaseViewsSettingTab(this.app, this));

    this.addRibbonIcon('plus-circle', 'Quick add to base', () => {
      new QuickAddModal(this.app, this.settings, this).open();
    });

    this.addCommand({
      id: 'quick-add-to-base',
      name: 'Quick add to base',
      callback: () => new QuickAddModal(this.app, this.settings, this).open(),
    });
  }

  onunload() {
    this.saveSettings();
  }

  async loadSettings() {
    const raw = await this.loadData();
    this.settings = migrateSettings(raw ?? {});
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
