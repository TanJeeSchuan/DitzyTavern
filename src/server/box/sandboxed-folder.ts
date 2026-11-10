import { lstat, opendir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** @approved The most a sandboxed plugin's folder may hold, checked while it is walked and before any file is read: bytes in all, entries, and folder depth. */
export const SANDBOXED_FOLDER = { bytes: 16 * 1024 * 1024, entries: 256, depth: 8 } as const;

// @approved
//  A sandboxed plugin's folder may arrive unpacked from an archive, so its
// layout is the guest's as much as its contents. Before anything in it is
// read or written, the whole tree is walked with `lstat`, and a folder
// holding a symbolic link, a file with more than one link, or anything but
// plain files and folders is refused: no path the host later reads or
// writes inside it can lead out. The walk counts entries, depth and bytes as
// it goes, and refuses a folder past `SANDBOXED_FOLDER` before reading the
// file that would pass it, so no folder can make the host buffer more than
// that. Every file is read here, once, so what the loader checks, hashes and
// builds are the same bytes. Paths are relative, with `/` between parts.
export const sandboxedFolder = async (folder: string, name: string) => {
	const files = new Map<string, string>();
	let entries = 0;
	let bytes = 0;
	const refuse = (path: string, what: string) => new Error(`The ${name} Box's folder holds ${path}, ${what}; a sandboxed Box's folder holds only plain files and folders.`);
	const over = (what: string) => new Error(`The ${name} Box's folder holds more than ${what}.`);
	const walk = async (directory: string, prefix: string, depth: number) => {
		if (depth > SANDBOXED_FOLDER.depth) throw over(`${SANDBOXED_FOLDER.depth} levels of folders`);
		for await (const entry of await opendir(directory)) {
			if (++entries > SANDBOXED_FOLDER.entries) throw over(`${SANDBOXED_FOLDER.entries} files and folders`);
			const path = join(directory, entry.name);
			const relative = `${prefix}${entry.name}`;
			const stats = await lstat(path);
			if (stats.isSymbolicLink()) throw refuse(relative, "a link");
			if (stats.isDirectory()) await walk(path, `${relative}/`, depth + 1);
			else if (!stats.isFile()) throw refuse(relative, "which is not a file");
			else if (stats.nlink > 1) throw refuse(relative, "a file with another link");
			else if ((bytes += stats.size) > SANDBOXED_FOLDER.bytes) throw over(`${SANDBOXED_FOLDER.bytes / 1024 / 1024} MiB`);
			else files.set(relative, await Bun.file(path).text());
		}
	};
	if (!(await lstat(folder)).isDirectory()) throw new Error(`The ${name} Box's folder is not a folder.`);
	await walk(folder, "", 0);
	return files;
};
export type SandboxedFiles = ReadonlyMap<string, string>;

// @approved
//  Replaces a file the loader writes into a Box's folder: the text goes to a
// new file beside it, created exclusively so no existing name is followed,
// which is then renamed over the old one. Nothing is ever truncated in place.
export const replaceFile = async (path: string, text: string | Uint8Array) => {
	const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
	try {
		await writeFile(temporary, text, { flag: "wx" });
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
};
