import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build, defineConfig, type Plugin } from "vite";

const boxes = fileURLToPath(new URL("./src/boxes", import.meta.url));

// @approved
//  The modules a Box client shares with the host, as `index.html`'s import
// map names them: each specifier to the stable host chunk it is built as.
const hostModules: Record<string, string> = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(readFileSync(new URL("./index.html", import.meta.url), "utf8"))![1]!).imports;

// @approved
//  A package's host chunk re-exports it by name, since a CommonJS package
// such as React would otherwise leave its chunk only a default export. The
// names are the installed package's own.
const hostChunks: Plugin = {
	name: "host-chunks",
	apply: "build",
	buildStart() {
		for (const [specifier, url] of Object.entries(hostModules)) {
			const id = specifier.startsWith("@/") ? specifier : `\0host:${specifier}`;
			this.emitFile({ type: "chunk", id, fileName: url.slice(1), preserveSignature: "strict" });
		}
	},
	resolveId: (id) => id.startsWith("\0host:") ? id : undefined,
	async load(id) {
		if (!id.startsWith("\0host:")) return;
		const specifier = id.slice("\0host:".length);
		const names = Object.keys(await import(specifier)).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
		return `export { ${names.join(", ")} } from "${specifier}";`;
	},
};

const linkStylesheet = `await new Promise((resolve, reject) => document.head.append(Object.assign(document.createElement("link"), {
	rel: "stylesheet", href: new URL("./client.css", import.meta.url).href, onload: resolve, onerror: () => reject(new Error("Its stylesheet did not load.")),
})));`;

// @approved
//  A Box's client module, `client.js`, built from its folder's `client.tsx`
// alone, as a plugin's is: the host modules stay imports the import map
// resolves. A stylesheet the module imports is emitted beside it as
// `client.css`, and the module links it and waits for it before it
// resolves, so the host renders no surface of a Box without its styles.
const buildBoxClient = async (folder: string, outDir: string): Promise<void> => {
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

/** @approved Every built-in Box's client builds into `dist/boxes/<id>` after the host. */
const builtInBoxClients: Plugin = {
	name: "built-in-box-clients",
	apply: "build",
	async closeBundle() {
		for (const id of readdirSync(boxes)) await buildBoxClient(join(boxes, id), fileURLToPath(new URL(`./dist/boxes/${id}`, import.meta.url)));
	},
};

/** @approved The dev server serves a Box's client module from its source: a built-in's from `src/boxes`, a plugin's from `data/boxes`. */
const devBoxClients: Plugin = {
	name: "dev-box-clients",
	apply: "serve",
	configureServer(server) {
		server.middlewares.use((request, _, next) => {
			const id = /^\/boxes\/([^/]+)\/client\.js(?:\?|$)/.exec(request.url ?? "")?.[1];
			if (id !== undefined) request.url = existsSync(join(boxes, id)) ? `/src/boxes/${id}/client.tsx` : `/data/boxes/${id}/client.js`;
			next();
		});
	},
};

export default defineConfig({
	plugins: [react(), tailwindcss(), hostChunks, builtInBoxClients, devBoxClients],
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	server: {
		host: "127.0.0.1",
		allowedHosts: ["tan-server.taild926e3.ts.net"],
		port: 5173,
		proxy: {
			"/api": "http://127.0.0.1:3000",
		},
	},
	build: {
		outDir: "dist",
	},
});
