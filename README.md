# Base Views

An Obsidian plugin that adds four custom views to [Obsidian Bases](https://help.obsidian.md/bases):

- **Kanban** — columns from any grouped property, drag-and-drop cards, inline card creation, cover images, sub-group swimlanes
- **Calendar** — month / week / agenda modes with draggable events
- **Timeline** — Gantt-style bars with drag-to-move and drag-to-resize
- **List** — flat or grouped list with inline property editing

Requires Obsidian **1.10.2+** (the Bases API).

## Testing locally (easiest way)

1. **Install and build:**

   ```sh
   npm install
   npm run watch   # rebuilds main.js on every source change
   ```

2. **Symlink the repo into a test vault.** Obsidian only reads `manifest.json`, `main.js`, and `styles.css`, so symlinking the whole repo works fine:

   ```sh
   ln -s /path/to/obsidian-base-views /path/to/TestVault/.obsidian/plugins/obsidian-base-views
   ```

3. In the test vault: **Settings → Community plugins** → turn off Restricted mode → enable **Base Views**.

4. **(Recommended) Install the [Hot Reload](https://github.com/pjeby/hot-reload) plugin** in the test vault and create an empty `.hotreload` file in this repo's root:

   ```sh
   touch .hotreload
   ```

   With `npm run watch` running, every save now rebuilds `main.js` and Hot Reload reloads the plugin instantly — no Obsidian restart needed. Without Hot Reload, toggle the plugin off/on (or run the "Reload app without saving" command) after each build.

5. **Sample data:** copy the `sample_docs/` folder into the vault. Each subfolder (`kanban`, `calendar`, `timeline`, `list`) contains a ready-made `.base` file plus test notes, so you can open a base and switch to the matching view immediately.

## Build for release

```sh
npm run build   # minified production build of main.js
```

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | One-shot development build (with sourcemap) |
| `npm run watch` | Development build that rebuilds on file changes |
| `npm run build` | Minified production build |
