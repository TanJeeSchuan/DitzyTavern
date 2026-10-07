const distribution = process.env.DISTRIBUTION ?? "custom";
const buildNumber = distribution === "official" ? Number(process.env.BUILD_NUMBER) : null;
const revision = distribution === "official" ? process.env.SOURCE_REVISION : null;
if (distribution !== "custom" && distribution !== "official"
	|| distribution === "official" && (!Number.isSafeInteger(buildNumber) || buildNumber! <= 0 || !/^[1-9]\d*$/.test(process.env.BUILD_NUMBER ?? "") || !/^[a-f0-9]{40}$/.test(revision ?? ""))) {
	throw new Error("Official builds require a positive build number and full source revision");
}
await Bun.write(process.argv[2] ?? "src/server/build-metadata.json", `${JSON.stringify({ distribution, buildNumber, revision })}\n`);

export {};
