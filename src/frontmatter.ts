import { TFile, BasesPropertyId, parsePropertyId, Vault } from 'obsidian';

export async function writeProp(vault: Vault, file: TFile, pid: BasesPropertyId, raw: string): Promise<void> {
	const content = await vault.read(file);
	const fm = content.match(/^---\n([\s\S]*?)\n---/);
	const { name } = parsePropertyId(pid);

	if (!fm) {
		await vault.modify(file, `---\n${name}: ${raw}\n---\n\n${content}`);
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

	await vault.modify(file, content.replace(/^---\n[\s\S]*?\n---/, `---\n${newFm}\n---`));
}
