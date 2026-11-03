import { lstat, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// @approved
//  A sandboxed plugin's folder may arrive unpacked from an archive, so its
// layout is the guest's as much as its contents. Before anything in it is
// read or written, the whole tree is walked with `lstat`, and a folder
// holding a symbolic link, a file with more than one link, or anything but
// plain files and folders is refused: no path the host later reads or
// writes inside it can lead out. Every file is read here, once, so what the
// loader checks, hashes and builds are the same bytes. Paths are relative,
// with `/` between parts.
export const sandboxedFolder = async (folder: string, name: string) => {
	const files = new Map<string, string>();
	const refuse = (path: string, what: string) => new Error(`The ${name} Box's folder holds ${path}, ${what}; a sandboxed Box's folder holds only plain files and folders.`);
	const walk = async (directory: string, prefix: string) => {
		for (const entry of (await readdir(directory)).sort()) {
			const path = join(directory, entry);
			const relative = `${prefix}${entry}`;
			const stats = await lstat(path);
			if (stats.isSymbolicLink()) throw refuse(relative, "a link");
			if (stats.isDirectory()) await walk(path, `${relative}/`);
			else if (!stats.isFile()) throw refuse(relative, "which is not a file");
			else if (stats.nlink > 1) throw refuse(relative, "a file with another link");
			else files.set(relative, await Bun.file(path).text());
		}
	};
	if (!(await lstat(folder)).isDirectory()) throw new Error(`The ${name} Box's folder is not a folder.`);
	await walk(folder, "");
	return files;
};
export type SandboxedFiles = ReadonlyMap<string, string>;

// @approved
//  Replaces a file the loader writes into a Box's folder: the text goes to a
// new file beside it, created exclusively so no existing name is followed,
// which is then renamed over the old one. Nothing is ever truncated in place.
export const replaceFile = async (path: string, text: string) => {
	const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
	try {
		await writeFile(temporary, text, { flag: "wx" });
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
};
