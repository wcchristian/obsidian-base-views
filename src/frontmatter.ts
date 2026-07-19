import { App, TFile, BasesPropertyId, parsePropertyId } from 'obsidian';

export type PropWriteValue = string | number | boolean | string[] | null;

/**
 * Write a single frontmatter property using Obsidian's canonical YAML writer.
 * An empty string clears the value (serialized as an empty/null YAML entry),
 * matching how Bases treats "no value" when grouping.
 */
export async function writeProp(app: App, file: TFile, pid: BasesPropertyId, value: PropWriteValue): Promise<void> {
	const { name } = parsePropertyId(pid);
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		fm[name] = value === '' ? null : value;
	});
}
