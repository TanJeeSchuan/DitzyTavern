import { expect, test } from "bun:test";
import { publishDockerBuild } from "./publish-docker";

const revision = "a".repeat(40);
const image = "ghcr.io/example/ditzytavern";
const digest10 = `sha256:${"1".repeat(64)}`;
const annotations = (number: number) => ({
	"io.ditzytavern.distribution": "official",
	"io.ditzytavern.build-number": String(number),
	"org.opencontainers.image.revision": revision,
});

function registry() {
	const tags = new Map<string, { digest: string; annotations: Record<string, string> }>();
	const commands: string[][] = [];
	return {
		tags,
		commands,
		fetch: async (input: string | URL | Request, _init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === "/token") return Response.json({ token: "registry-token" });
			const tag = url.pathname.split("/").at(-1)!;
			const manifest = tags.get(tag);
			return manifest
				? Response.json({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", annotations: manifest.annotations }, { headers: { "docker-content-digest": manifest.digest } })
				: Response.json({ errors: [{ code: "MANIFEST_UNKNOWN" }] }, { status: 404 });
		},
		run: async (command: string[]) => {
			commands.push(command);
			if (command.includes("--push")) {
				const metadata: Record<string, string> = {};
				for (let index = 0; index < command.length; index++) {
					if (command[index] === "--annotation") {
						const [key, value] = command[index + 1]!.replace("index:", "").split("=");
						metadata[key!] = value!;
					}
				}
				tags.set(command[command.indexOf("--tag") + 1]!.split(":").at(-1)!, { digest: digest10, annotations: metadata });
			}
			if (command.includes("create")) {
				const source = command.at(-1)!.split("@")[1];
				const existing = [...tags.values()].find(manifest => manifest.digest === source);
				if (!existing || command.length !== 7) throw new Error("Promotion must copy one existing index digest without transformations");
				tags.set("latest", existing);
			}
		},
	};
}

const build = { image, runNumber: 10, revision, eventName: "push", ref: "refs/heads/master", username: "example", password: "test-token" };

test("first publication makes latest the exact numbered index", async () => {
	const remote = registry();
	await publishDockerBuild(build, remote);
	expect(remote.tags.get("build-10")?.digest).toBe(digest10);
	expect(remote.tags.get("latest")?.digest).toBe(digest10);
});

test("reruns reuse the immutable numbered index without building", async () => {
	const remote = registry();
	const original = `sha256:${"2".repeat(64)}`;
	remote.tags.set("build-10", { digest: original, annotations: annotations(10) });
	await publishDockerBuild(build, remote);
	expect(remote.tags.get("build-10")?.digest).toBe(original);
	expect(remote.tags.get("latest")?.digest).toBe(original);
	expect(remote.commands.some(command => command.includes("build"))).toBe(false);
});

test("out-of-order publication leaves the greater latest build untouched", async () => {
	const remote = registry();
	const newer = { digest: `sha256:${"3".repeat(64)}`, annotations: annotations(11) };
	remote.tags.set("latest", newer);
	await publishDockerBuild(build, remote);
	expect(remote.tags.get("latest")).toEqual(newer);
	expect(remote.tags.get("build-10")?.digest).toBe(digest10);
});

test("equal build numbers with conflicting digests fail instead of replacing latest", async () => {
	const remote = registry();
	remote.tags.set("latest", { digest: `sha256:${"3".repeat(64)}`, annotations: annotations(10) });
	await expect(publishDockerBuild(build, remote)).rejects.toThrow("conflicting");
	expect(remote.tags.get("latest")?.digest).toBe(`sha256:${"3".repeat(64)}`);
});

test("lookup failures never authorize a numbered overwrite or latest promotion", async () => {
	for (const tag of ["build-10", "latest"]) {
		for (const status of [401, 403, 404, 500]) {
			const remote = registry();
			const fetchRegistry = remote.fetch;
			remote.fetch = async (input, init) => String(input).endsWith(`/manifests/${tag}`)
				? Response.json({ errors: [{ code: "DENIED" }] }, { status })
				: fetchRegistry(input, init);
			await expect(publishDockerBuild(build, remote)).rejects.toThrow("lookup");
			expect(remote.commands.some(command => command.includes("create"))).toBe(false);
			if (tag === "build-10") expect(remote.commands).toEqual([]);
		}
	}
});

test("unnumbered or malformed indexes fail rather than invent an ordering", async () => {
	for (const metadata of [{}, { ...annotations(10), "io.ditzytavern.build-number": "0" }, { ...annotations(10),
		"io.ditzytavern.build-number": "10x" }, { ...annotations(10), "io.ditzytavern.distribution": "custom" }, { ...annotations(10),
		"org.opencontainers.image.revision": "short" }]) {
		const remote = registry();
		remote.tags.set("latest", { digest: digest10, annotations: metadata });
		await expect(publishDockerBuild(build, remote)).rejects.toThrow("metadata");
		expect(remote.commands.some(command => command.includes("create"))).toBe(false);
	}
});

test("a numbered tag cannot claim a different build identity", async () => {
	const remote = registry();
	remote.tags.set("build-10", { digest: digest10, annotations: annotations(9) });
	await expect(publishDockerBuild(build, remote)).rejects.toThrow("identity");
	expect(remote.commands).toEqual([]);
});

test("missing or unsupported index schema versions prevent publication", async () => {
	for (const tag of ["build-10", "latest"]) {
		for (const schemaVersion of [undefined, 1, "2"]) {
			const remote = registry();
			remote.tags.set("build-10", { digest: digest10, annotations: annotations(10) });
			remote.tags.set("latest", { digest: `sha256:${"9".repeat(64)}`, annotations: annotations(9) });
			const fetchRegistry = remote.fetch;
			remote.fetch = async (input, init) => {
				const response = await fetchRegistry(input, init);
				return String(input).endsWith(`/manifests/${tag}`)
					? Response.json({ ...await response.json(), schemaVersion }, { headers: response.headers })
					: response;
			};
			await expect(publishDockerBuild(build, remote)).rejects.toThrow("metadata");
			expect(remote.commands).toEqual([]);
			expect(remote.tags.get("latest")?.annotations["io.ditzytavern.build-number"]).toBe("9");
		}
	}
});

test("PR and tag execution performs no Docker work or registry requests", async () => {
	for (const event of [{ eventName: "pull_request", ref: "refs/pull/1/merge" }, { eventName: "push", ref: "refs/tags/v1" }]) {
		const remote = registry();
		remote.fetch = async () => { throw new Error("Unexpected registry request"); };
		await publishDockerBuild({ ...build, ...event }, remote);
		expect(remote.commands).toEqual([]);
	}
});

test("an interrupted promotion fails and rerunning repairs its existing numbered digest", async () => {
	const remote = registry();
	remote.tags.set("latest", { digest: `sha256:${"9".repeat(64)}`, annotations: annotations(9) });
	const runCommand = remote.run;
	remote.run = async command => {
		if (command.includes("create")) throw new Error("Interrupted promotion");
		await runCommand(command);
	};
	await expect(publishDockerBuild(build, remote)).rejects.toThrow("Interrupted");
	expect(remote.tags.get("build-10")?.digest).toBe(digest10);
	expect(remote.tags.get("latest")?.annotations["io.ditzytavern.build-number"]).toBe("9");
	remote.commands.length = 0;
	remote.run = runCommand;
	await publishDockerBuild(build, remote);
	expect(remote.tags.get("latest")?.digest).toBe(digest10);
	expect(remote.commands.some(command => command.includes("build"))).toBe(false);
});

test("unverified alias promotion is a failed publication", async () => {
	const remote = registry();
	const runCommand = remote.run;
	remote.run = async command => { if (!command.includes("create")) await runCommand(command); };
	await expect(publishDockerBuild(build, remote)).rejects.toThrow("digest mismatch");
});

test("master smoke failure prevents numbered publication", async () => {
	const remote = registry();
	const runCommand = remote.run;
	remote.run = async command => {
		if (command[0] === "bash") throw new Error("Smoke check failed");
		await runCommand(command);
	};
	await expect(publishDockerBuild(build, remote)).rejects.toThrow("Smoke");
	expect(remote.tags.size).toBe(0);
});

test("numeric ordering promotes build 10 over build 9 even at the same revision", async () => {
	const remote = registry();
	remote.tags.set("latest", { digest: `sha256:${"9".repeat(64)}`, annotations: annotations(9) });
	await publishDockerBuild(build, remote);
	expect(remote.tags.get("latest")?.annotations).toEqual(annotations(10));
});

test("network and authentication failures perform no Docker work", async () => {
	const remote = registry();
	remote.fetch = async () => { throw new Error("Network offline"); };
	await expect(publishDockerBuild(build, remote)).rejects.toThrow("Network offline");
	expect(remote.commands).toEqual([]);
	remote.fetch = async () => new Response("Unauthorized", { status: 401 });
	await expect(publishDockerBuild(build, remote)).rejects.toThrow("authentication");
	expect(remote.commands).toEqual([]);
});
