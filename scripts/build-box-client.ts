import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { build } from "vite";

// The modules a Box client shares with the host, as `index.html`'s import
// map names them: each specifier to the stable host chunk it is built as.
export const hostModules: Record<string, string> = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(readFileSync(new URL("../index.html", import.meta.url), "utf8"))![1]!).imports;

const linkStylesheet = `await new Promise((resolve, reject) => document.head.append(Object.assign(document.createElement("link"), {
	rel: "stylesheet", href: new URL("./client.css", import.meta.url).href, onload: resolve, onerror: () => reject(new Error("Its stylesheet did not load.")),
})));`;

// A Box's client module, `client.js`, built from its folder's `client.tsx`
// alone, a built-in's and a plugin's alike: the host modules stay imports the
// import map resolves. A stylesheet the module imports is emitted beside it as
// `client.css`, and the module links it and waits for it before it resolves,
// so the host renders no surface of a Box without its styles.
export const buildBoxClient = async (folder: string, outDir: string): Promise<void> => {
	await build({
		configFile: false,
		root: folder,
		publicDir: false,
		logLevel: "warn",
		plugins: [react()],
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		build: {
			outDir,
			emptyOutDir: true,
			lib: { entry: join(folder, "client.tsx"), formats: ["es"], fileName: () => "client.js", cssFileName: "client" },
			rolldownOptions: { external: Object.keys(hostModules) },
		},
	});
	if (!existsSync(join(outDir, "client.css"))) return;
	const module = join(outDir, "client.js");
	writeFileSync(module, `${linkStylesheet}\n${readFileSync(module, "utf8")}`);
};

// `bun run box:build <folder>` builds a plugin's client into the `dist`
// folder inside it, where the server serves it from.
if (import.meta.main) {
	const [path] = process.argv.slice(2);
	if (path === undefined) throw new Error("Name the plugin's folder: bun run box:build <folder>");
	const folder = resolve(path);
	await buildBoxClient(folder, join(folder, "dist"));
}
