import { Value } from "@sinclair/typebox/value";
import { publishedBuildIndex } from "../src/shared/contract/update-registry";

type Build = {
	image: string;
	runNumber: number;
	revision: string;
	eventName: string;
	ref: string;
	username: string;
	password: string;
};

type Commands = { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; run: (command: string[]) => Promise<void> };

export async function publishDockerBuild(build: Build, commands: Commands) {
	if (build.eventName !== "push" || build.ref !== "refs/heads/master") return;
	if (!Number.isSafeInteger(build.runNumber) || build.runNumber <= 0 || !/^[a-f0-9]{40}$/.test(build.revision) ||
		!/^ghcr\.io\/[a-z0-9._/-]+$/.test(build.image)) throw new Error("Invalid publishing build identity");
	const repository = build.image.slice("ghcr.io/".length);
	const read = async (tag: string) => {
		const tokenResponse = await commands.fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull,push`, {
			headers: { Authorization: `Basic ${Buffer.from(`${build.username}:${build.password}`).toString("base64")}` },
		});
		if (!tokenResponse.ok) throw new Error(`Registry authentication failed: ${tokenResponse.status}`);
		const { token }: { token: string } = await tokenResponse.json();
		const response = await commands.fetch(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" },
		});
		if (response.status === 404) {
			const body: { errors?: { code: string }[] } = await response.json();
			if (body.errors?.some(error => error.code === "MANIFEST_UNKNOWN" || error.code === "NAME_UNKNOWN")) return null;
		}
		if (!response.ok) throw new Error(`Registry lookup ${tag} failed: ${response.status}`);
		const manifest: unknown = await response.json();
		const digest = response.headers.get("docker-content-digest");
		if (!Value.Check(publishedBuildIndex, manifest) || !Number.isSafeInteger(Number(manifest.annotations["io.ditzytavern.build-number"]))) {
			throw new Error(`Invalid official index metadata for ${tag}; unnumbered latest requires an explicit registry transition`);
		}
		if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid official index digest for ${tag}`);
		return { digest, number: Number(manifest.annotations["io.ditzytavern.build-number"]), revision: manifest.annotations["org.opencontainers.image.revision"] };
	};
	const numbered = `build-${build.runNumber}`;
	let candidate = await read(numbered);
	if (!candidate) {
		const args = ["--build-arg", "DISTRIBUTION=official", "--build-arg", `BUILD_NUMBER=${build.runNumber}`, "--build-arg", `SOURCE_REVISION=${build.revision}`];
		await commands.run(["docker", "buildx", "build", "--load", "--platform", "linux/amd64", "--tag", "ditzytavern:ci", ...args, "."]);
		await commands.run(["bash", "scripts/verify-image-metadata.sh", "ditzytavern:ci", "linux/amd64", String(build.runNumber), build.revision]);
		await commands.run(["bash", "scripts/docker-smoke.sh"]);
		await commands.run(["docker", "buildx", "build", "--load", "--platform", "linux/arm64", "--tag", "ditzytavern:ci-arm64", ...args, "."]);
		await commands.run(["bash", "scripts/verify-image-metadata.sh", "ditzytavern:ci-arm64", "linux/arm64", String(build.runNumber), build.revision]);
		await commands.run(["docker", "buildx", "build", "--push", "--platform", "linux/amd64,linux/arm64", "--tag", `${build.image}:${numbered}`, ...args,
			"--annotation", "index:io.ditzytavern.distribution=official", "--annotation", `index:io.ditzytavern.build-number=${build.runNumber}`,
			"--annotation", `index:org.opencontainers.image.revision=${build.revision}`, "."]);
		candidate = await read(numbered);
	}
	if (!candidate) throw new Error("Numbered index missing after publication");
	if (candidate.number !== build.runNumber || candidate.revision !== build.revision) throw new Error("Numbered index identity does not match this workflow run");
	const latest = await read("latest");
	if (latest && latest.number === build.runNumber) {
		if (latest.digest !== candidate.digest) throw new Error("Equal build numbers have conflicting digests");
		return;
	}
	if (latest && latest.number > build.runNumber) return;
	await commands.run(["docker", "buildx", "imagetools", "create", "--tag", `${build.image}:latest`, `${build.image}@${candidate.digest}`]);
	if ((await read("latest"))?.digest !== candidate.digest) throw new Error("Latest promotion digest mismatch");
}

if (import.meta.main) {
	await publishDockerBuild({
		image: `ghcr.io/${process.env.GITHUB_REPOSITORY?.toLowerCase()}`,
		runNumber: Number(process.env.GITHUB_RUN_NUMBER), revision: process.env.GITHUB_SHA!,
		eventName: process.env.GITHUB_EVENT_NAME!, ref: process.env.GITHUB_REF!,
		username: process.env.GITHUB_ACTOR!, password: process.env.GITHUB_TOKEN!,
	}, {
		fetch,
		run: async (command) => {
			const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
			if (await child.exited !== 0) throw new Error(`Command failed: ${command.join(" ")}`);
		},
	});
}
