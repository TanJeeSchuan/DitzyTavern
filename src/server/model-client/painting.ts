import { createImageModelAdapter } from "./adapter";
import { generateImage } from "ai";
import type { ConnectionProfileDraft, ConnectionProfileSecretSnapshot } from "../connection-settings";
import { parseImageReferences, projectImageAnchors } from "../../shared/image-reference";
import { resolveRequestUrl } from "../../shared/connection-url";
import { authenticatedHeaders } from "./authenticated-headers";
import { readProviderDiagnostic } from "./diagnostics";
import type { ModelFetch } from "./model-fetch";

export async function paintImage(input: {
	profile: ConnectionProfileDraft;
	modelId: string;
	secrets: ConnectionProfileSecretSnapshot | null;
	brief: string;
	aspectRatio: `${number}:${number}`;
	loadImage: (hash: string) => { bytes: Uint8Array; mediaType: string } | undefined;
	fetch?: ModelFetch;
	signal?: AbortSignal;
}) {
	const { profile, secrets } = input;
	if (profile.apiFormat !== "images" || profile.adapter === "deepseek") throw new Error("Choose an Images connection with the OpenRouter or OpenAI-compatible adapter.");
	if (profile.timeoutMs === null || profile.timeoutMs <= 0) throw new Error("An Images connection needs a positive timeout.");
	const images = parseImageReferences(input.brief).map(({ hash, name }) => {
		const image = input.loadImage(hash);
		if (image === undefined) throw new Error(`The Image "${name}" is missing.`);
		return `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString("base64")}`;
	});
	const requestUrl = resolveRequestUrl(profile.requestUrl, "images", { adapter: profile.adapter, references: images.length > 0 });
	const credential = secrets?.credential ?? null;
	const headers = secrets?.headers ?? {};
	const model = createImageModelAdapter({ adapter: profile.adapter, modelId: input.modelId, requestUrl, credential: credential ?? "", headers,
		fetch: async (_url, init) => {
			const response = await (input.fetch ?? fetch)(requestUrl, { ...init, headers: authenticatedHeaders(init?.headers, credential, headers), redirect: "error" });
			if (response.ok) return response;
			return new Response(await readProviderDiagnostic(response, [credential ?? "", ...Object.values(headers)]), { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "text/plain" } });
		},
	});
	const timeout = AbortSignal.timeout(profile.timeoutMs);
	const aspectRatioOptions = profile.adapter === "openrouter" ? { aspectRatio: input.aspectRatio } : { providerOptions: { "ditzytavern-openai-compatible": { aspect_ratio: input.aspectRatio } } };
	const prompt = images.length === 0 ? projectImageAnchors(input.brief) : { text: projectImageAnchors(input.brief), images };
	const abortSignal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
	const result = await generateImage({ model, prompt, ...aspectRatioOptions, n: 1, maxRetries: 0, abortSignal });
	return result.image.uint8Array;
}
