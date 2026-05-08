import { App, PluginSettingTab, Setting } from 'obsidian';
import BaseViewsPlugin from './main';

export interface ColorGroup {
  name: string;
  propertyName: string;
  colors: Record<string, string>;
}

export interface QuickAddProp {
  name: string;   // frontmatter key, e.g. "date", "project"
  value: string;  // "today" → YYYY-MM-DD, "" → user prompted, anything else → literal
}

export interface QuickAddProfile {
  id: string;             // Date.now().toString() on creation
  name: string;           // display name, e.g. "Work Notes"
  folder: string;         // vault-relative folder path, "" = vault root
  props: QuickAddProp[];
}

export interface BaseViewsSettings {
  enableCalendar: boolean;
  enableKanban: boolean;
  enableTimeline: boolean;
  colorGroups: ColorGroup[];
  localOrder: Record<string, string[]>;
  quickAddProfiles: QuickAddProfile[];
}

export const DEFAULT_SETTINGS: BaseViewsSettings = {
  enableCalendar: true,
  enableKanban: true,
  enableTimeline: true,
  colorGroups: [
    { name: 'Project', propertyName: 'project', colors: {} }
  ],
  localOrder: {},
  quickAddProfiles: [],
};

export function migrateSettings(raw: any): BaseViewsSettings {
  const out: BaseViewsSettings = {
    enableCalendar: raw?.enableCalendar !== false,
    enableKanban: raw?.enableKanban !== false,
    enableTimeline: raw?.enableTimeline !== false,
    colorGroups: raw?.colorGroups,
    localOrder: raw?.localOrder ?? {},
    quickAddProfiles: Array.isArray(raw?.quickAddProfiles) ? raw.quickAddProfiles : [],
  } as BaseViewsSettings;

  if (!Array.isArray(out.colorGroups) || out.colorGroups.length === 0) {
    out.colorGroups = [{
      name: 'Project',
      propertyName: typeof raw?.projectPropertyName === 'string' && raw.projectPropertyName ? raw.projectPropertyName : 'project',
      colors: (raw?.projectColors && typeof raw.projectColors === 'object') ? raw.projectColors : {}
    }];
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

    // ── Calendar color groups ──────────────────────────────────
    containerEl.createEl('h3', { text: 'Calendar color groups' });
    containerEl.createEl('p', {
      text: 'Define color groups keyed by a frontmatter property. Each calendar view can pick which group drives the primary (left border) and secondary (right border) colors of an event.',
      cls: 'setting-item-description'
    });

    this.plugin.settings.colorGroups.forEach((group, idx) => {
      this.renderGroup(containerEl, group, idx);
    });

    new Setting(containerEl)
      .addButton(btn => {
        btn.setButtonText('+ Add color group');
        btn.onClick(async () => {
          this.plugin.settings.colorGroups.push({ name: 'Group', propertyName: '', colors: {} });
          await this.plugin.saveSettings();
          this.display();
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
            props: [],
          });
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }

  private renderGroup(container: HTMLElement, group: ColorGroup, idx: number) {
    const groupEl = container.createDiv('bc-color-group');
    const headerRow = groupEl.createDiv('bc-color-group-header');

    const nameInput = headerRow.createEl('input', { cls: 'bc-cg-name' });
    nameInput.type = 'text';
    nameInput.value = group.name;
    nameInput.placeholder = 'Group name';
    nameInput.addEventListener('change', async () => {
      group.name = nameInput.value;
      await this.plugin.saveSettings();
    });

    const propInput = headerRow.createEl('input', { cls: 'bc-cg-prop' });
    propInput.type = 'text';
    propInput.value = group.propertyName;
    propInput.placeholder = 'Property name (e.g. project)';
    propInput.addEventListener('change', async () => {
      group.propertyName = nameInput.value.trim() ? propInput.value.trim() : '';
      await this.plugin.saveSettings();
    });

    const removeGroupBtn = headerRow.createEl('button', { cls: 'bc-cg-remove', text: 'Remove group' });
    removeGroupBtn.addEventListener('click', async () => {
      this.plugin.settings.colorGroups.splice(idx, 1);
      await this.plugin.saveSettings();
      this.display();
    });

    const rowsEl = groupEl.createDiv('bc-color-group-rows');
    Object.entries(group.colors).forEach(([value, color]) => {
      this.renderColorRow(rowsEl, group, value, color);
    });

    new Setting(groupEl)
      .addButton(btn => {
        btn.setButtonText('+ Add value');
        btn.onClick(async () => {
          group.colors[`value_${Object.keys(group.colors).length + 1}`] = '#808080';
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }

  private renderQuickAddProfile(container: HTMLElement, profile: QuickAddProfile, idx: number) {
    const profileEl = container.createDiv('bv-qa-profile');
    const headerRow = profileEl.createDiv('bv-qa-profile-header');

    const nameInput = headerRow.createEl('input', { cls: 'bv-qa-name' });
    nameInput.type = 'text';
    nameInput.value = profile.name;
    nameInput.placeholder = 'Profile name';
    nameInput.addEventListener('change', async () => {
      profile.name = nameInput.value;
      await this.plugin.saveSettings();
    });

    const folderInput = headerRow.createEl('input', { cls: 'bv-qa-folder' });
    folderInput.type = 'text';
    folderInput.value = profile.folder;
    folderInput.placeholder = 'Folder path (empty = vault root)';
    folderInput.addEventListener('change', async () => {
      profile.folder = folderInput.value.trim();
      await this.plugin.saveSettings();
    });

    const removeProfileBtn = headerRow.createEl('button', { cls: 'bv-qa-remove', text: 'Remove profile' });
    removeProfileBtn.addEventListener('click', async () => {
      this.plugin.settings.quickAddProfiles.splice(idx, 1);
      await this.plugin.saveSettings();
      this.display();
    });

    const propsEl = profileEl.createDiv('bv-qa-props');
    profile.props.forEach((prop, propIdx) => {
      this.renderPropRow(propsEl, profile, prop, propIdx);
    });

    new Setting(profileEl)
      .addButton(btn => {
        btn.setButtonText('+ Add property');
        btn.onClick(async () => {
          profile.props.push({ name: '', value: '' });
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

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.value = prop.value;
    valueInput.className = 'bv-qa-prop-value';
    valueInput.placeholder = '"today", literal value, or empty to prompt';
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

  private renderColorRow(container: HTMLElement, group: ColorGroup, value: string, color: string) {
    const row = container.createDiv('bc-project-row');

    const valInput = document.createElement('input');
    valInput.type = 'text';
    valInput.value = value;
    valInput.className = 'bc-project-name-input';
    valInput.placeholder = 'Property value';
    valInput.addEventListener('change', async () => {
      const newVal = valInput.value.trim();
      if (newVal && newVal !== value) {
        delete group.colors[value];
        group.colors[newVal] = color;
        await this.plugin.saveSettings();
        this.display();
      }
    });
    row.appendChild(valInput);

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = color;
    colorInput.className = 'bc-project-color-picker';
    colorInput.addEventListener('input', async () => {
      group.colors[value] = colorInput.value;
      await this.plugin.saveSettings();
    });
    row.appendChild(colorInput);

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'bc-project-remove-btn';
    removeBtn.addEventListener('click', async () => {
      delete group.colors[value];
      await this.plugin.saveSettings();
      this.display();
    });
    row.appendChild(removeBtn);
  }
}
