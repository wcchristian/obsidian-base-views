import { App, PluginSettingTab, Setting } from 'obsidian';
import BaseViewsPlugin from './main';
import { FolderSuggest, FileSuggest } from './util';

export interface QuickAddProp {
  name: string;   // frontmatter key, e.g. "date", "project"
  value: string;  // "today" → YYYY-MM-DD, "" → user prompted, anything else → literal
  type?: 'text' | 'number' | 'checkbox' | 'date' | 'datetime' | 'list';
}

export interface QuickAddProfile {
  id: string;             // Date.now().toString() on creation
  name: string;           // display name, e.g. "Work Notes"
  folder: string;         // vault-relative folder path, "" = vault root
  props: QuickAddProp[];
  templateFile?: string;  // optional path to a template file
}

export interface BaseViewsSettings {
  enableCalendar: boolean;
  enableKanban: boolean;
  enableTimeline: boolean;
  enableList: boolean;
  localOrder: Record<string, string[]>;
  quickAddProfiles: QuickAddProfile[];
}

export const DEFAULT_SETTINGS: BaseViewsSettings = {
  enableCalendar: true,
  enableKanban: true,
  enableTimeline: true,
  enableList: true,
  localOrder: {},
  quickAddProfiles: [],
};

export function migrateSettings(raw: any): BaseViewsSettings {
  const out: BaseViewsSettings = {
    enableCalendar: raw?.enableCalendar !== false,
    enableKanban: raw?.enableKanban !== false,
    enableTimeline: raw?.enableTimeline !== false,
    enableList: raw?.enableList !== false,
    localOrder: raw?.localOrder ?? {},
    quickAddProfiles: Array.isArray(raw?.quickAddProfiles) ? raw.quickAddProfiles : [],
  };

  // Migrate existing props without type: default to 'text'
  for (const profile of out.quickAddProfiles) {
    for (const prop of profile.props) {
      if (!prop.type) prop.type = 'text';
    }
  }

  return out;
}

export class BaseViewsSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: BaseViewsPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Base Views Settings' });

    // ── View toggles ───────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Views' });
    containerEl.createEl('p', {
      text: 'Enable or disable individual views. Disabled views will show a placeholder message when opened.',
      cls: 'setting-item-description'
    });

    new Setting(containerEl)
      .setName('Calendar view')
      .setDesc('Show month, week, and agenda calendar layouts for date-based notes.')
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.enableCalendar);
        toggle.onChange(async (value) => {
          this.plugin.settings.enableCalendar = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Kanban view')
      .setDesc('Show notes as cards in a Kanban board grouped by a property.')
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.enableKanban);
        toggle.onChange(async (value) => {
          this.plugin.settings.enableKanban = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Timeline view')
      .setDesc('Show notes as bars on a scrollable Gantt-chart timeline.')
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.enableTimeline);
        toggle.onChange(async (value) => {
          this.plugin.settings.enableTimeline = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('List view')
      .setDesc('Show notes as a flat or grouped list with color, properties, and sorting.')
      .addToggle(toggle => {
        toggle.setValue(this.plugin.settings.enableList);
        toggle.onChange(async (value) => {
          this.plugin.settings.enableList = value;
          await this.plugin.saveSettings();
        });
      });

    // ── Quick Add profiles ─────────────────────────────
    containerEl.createEl('h3', { text: 'Quick Add' });
    containerEl.createEl('p', {
      text: 'Configure profiles for the Quick Add ribbon button and command. Each profile defines a target folder and frontmatter properties to auto-fill. Set a property value to "today" for today\'s date, leave blank to prompt each time, or type any literal value.',
      cls: 'setting-item-description'
    });

    this.plugin.settings.quickAddProfiles.forEach((profile, idx) => {
      this.renderQuickAddProfile(containerEl, profile, idx);
    });

    new Setting(containerEl)
      .addButton(btn => {
        btn.setButtonText('+ Add profile');
        btn.onClick(async () => {
          this.plugin.settings.quickAddProfiles.push({
            id: Date.now().toString(),
            name: 'New Profile',
            folder: '',
            props: [{ name: '', value: '', type: 'text' }],
          });
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }

  private renderQuickAddProfile(container: HTMLElement, profile: QuickAddProfile, idx: number) {
    const profileEl = container.createDiv('bv-qa-profile');

    // ── Destination section ─────────────────────────────────────
    const destSection = profileEl.createDiv('bv-qa-section');
    destSection.createDiv({ cls: 'qa-section-title', text: 'Destination' });

    const headerRow = destSection.createDiv('bv-qa-profile-header');

    const nameInput = headerRow.createEl('input', { cls: 'bv-qa-name' });
    nameInput.type = 'text';
    nameInput.value = profile.name;
    nameInput.placeholder = 'Profile name';
    nameInput.addEventListener('change', async () => {
      profile.name = nameInput.value;
      await this.plugin.saveSettings();
    });

    const folderWrapper = headerRow.createDiv({ cls: 'bv-qa-folder-wrap' });
    const folderInput = folderWrapper.createEl('input', { cls: 'bv-qa-folder' });
    folderInput.type = 'text';
    folderInput.value = profile.folder;
    folderInput.placeholder = 'Folder path (empty = vault root)';
    folderInput.addEventListener('change', async () => {
      profile.folder = folderInput.value.trim();
      await this.plugin.saveSettings();
    });
    new FolderSuggest(this.app, folderInput);

    const removeProfileBtn = headerRow.createEl('button', { cls: 'bv-qa-remove', text: 'Remove profile' });
    removeProfileBtn.addEventListener('click', async () => {
      this.plugin.settings.quickAddProfiles.splice(idx, 1);
      await this.plugin.saveSettings();
      this.display();
    });

    // Template file row
    const tplRow = destSection.createDiv('bv-qa-tpl-row');
    const tplLabel = tplRow.createEl('label', { text: 'Template file:' });
    tplLabel.style.fontSize = 'var(--font-ui-small)';
    tplLabel.style.color = 'var(--text-muted)';
    tplLabel.style.marginRight = '6px';
    const tplInput = tplRow.createEl('input', { cls: 'bv-qa-folder' });
    tplInput.type = 'text';
    tplInput.value = profile.templateFile ?? '';
    tplInput.placeholder = 'templates/My Template.md';
    tplInput.style.flex = '1';
    new FileSuggest(this.app, tplInput);
    tplInput.addEventListener('change', async () => {
      profile.templateFile = tplInput.value.trim() || undefined;
      await this.plugin.saveSettings();
    });

    // ── Properties section ──────────────────────────────────────
    const propsSection = profileEl.createDiv('bv-qa-section');
    propsSection.createDiv({ cls: 'qa-section-title', text: 'Properties' });

    const propsEl = propsSection.createDiv('bv-qa-props');
    profile.props.forEach((prop, propIdx) => {
      this.renderPropRow(propsEl, profile, prop, propIdx);
    });

    new Setting(propsSection)
      .addButton(btn => {
        btn.setButtonText('+ Add property');
        btn.onClick(async () => {
          profile.props.push({ name: '', value: '', type: 'text' });
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }

  private renderPropRow(container: HTMLElement, profile: QuickAddProfile, prop: QuickAddProp, propIdx: number) {
    const row = container.createDiv('bv-qa-prop-row');

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = prop.name;
    nameInput.className = 'bv-qa-prop-name';
    nameInput.placeholder = 'Property name';
    nameInput.addEventListener('change', async () => {
      prop.name = nameInput.value.trim();
      await this.plugin.saveSettings();
    });
    row.appendChild(nameInput);

    // Type dropdown
    const typeSelect = document.createElement('select');
    typeSelect.className = 'bv-qa-prop-type';
    const types: Array<{ v: string; label: string }> = [
      { v: 'text', label: 'Text' },
      { v: 'number', label: 'Number' },
      { v: 'checkbox', label: 'Checkbox' },
      { v: 'date', label: 'Date' },
      { v: 'datetime', label: 'DateTime' },
      { v: 'list', label: 'List' },
    ];
    types.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.v;
      opt.textContent = t.label;
      if ((prop.type ?? 'text') === t.v) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener('change', async () => {
      prop.type = typeSelect.value as QuickAddProp['type'];
      await this.plugin.saveSettings();
    });
    row.appendChild(typeSelect);

    const valueInput = document.createElement('input');
    valueInput.type = prop.type === 'date' || prop.type === 'datetime' ? 'text' : 'text';
    valueInput.value = prop.value;
    valueInput.className = 'bv-qa-prop-value';
    valueInput.placeholder = prop.type === 'date' || prop.type === 'datetime' ? '"today" or YYYY-MM-DD' : '"today", literal value, or empty to prompt';
    valueInput.addEventListener('change', async () => {
      prop.value = valueInput.value;
      await this.plugin.saveSettings();
    });
    row.appendChild(valueInput);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'bv-qa-prop-remove';
    removeBtn.addEventListener('click', async () => {
      profile.props.splice(propIdx, 1);
      await this.plugin.saveSettings();
      this.display();
    });
    row.appendChild(removeBtn);
  }
}
