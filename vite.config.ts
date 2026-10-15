import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildBoxClient, hostModules } from "./scripts/build-box-client.ts";

const boxes = fileURLToPath(new URL("./src/boxes", import.meta.url));

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

/** @approved Every built-in Box's client builds into `dist/boxes/<id>` after the host. */
const builtInBoxClients: Plugin = {
	name: "built-in-box-clients",
	apply: "build",
	async closeBundle() {
		for (const id of readdirSync(boxes)) await buildBoxClient(join(boxes, id), fileURLToPath(new URL(`./dist/boxes/${id}`, import.meta.url)));
	},
};

/** @approved The dev server serves a built-in Box's client module from its source, and a plugin's as `box:build` built it in `data/boxes`. */
const devBoxClients: Plugin = {
	name: "dev-box-clients",
	apply: "serve",
	configureServer(server) {
		server.middlewares.use((request, _, next) => {
			const id = /^\/boxes\/([^/]+)\/client\.js(?:\?|$)/.exec(request.url ?? "")?.[1];
			if (id !== undefined) request.url = existsSync(join(boxes, id)) ? `/src/boxes/${id}/client.tsx` : `/data/boxes/${id}/dist/client.js`;
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
