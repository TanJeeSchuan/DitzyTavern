import { imageAnchor, parseImageReferences, projectImageAnchors } from "../../shared/image-reference";
import type { PromptImage } from "../../shared/contract/conversation-schema";
import { ModelClientTransportError } from "./errors";
import type { ModelClientGenerationInput } from "./types";

export interface LoadedImage {
	readonly bytes: Uint8Array;
	readonly mediaType: string;
}

export type ImageLoader = (hash: string) => LoadedImage | undefined;

type UserPart =
	| { type: "text"; text: string }
	| { type: "file"; data: Uint8Array; mediaType: string };

type ChatMessage = (
	| { role: "system" | "assistant"; content: string }
	| { role: "user"; content: string | UserPart[] }
) & { providerOptions?: typeof cacheBreakpoint };

// @approved
//  Claude caches only up to a marked block. The end of history is the last
// prefix the next Send repeats, so it carries the one breakpoint. OpenRouter
// and the Anthropic provider both read this key; other providers ignore it.
const cacheBreakpoint = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

// @approved
//  The plan keeps provider-neutral presentation roles; this adapter owns the
// translation into provider vocabulary, exactly as it does for history
// authorship.
const providerRoleFor = {
	system: "system",
	human: "user",
	model: "assistant",
} as const satisfies Record<"system" | "human" | "model", "system" | "user" | "assistant">;

type Segment = { text: string } | { anchor: string; image: LoadedImage };

const renderContent = (
	block: number,
	content: string,
	images: ReadonlyMap<string, PromptImage>,
	loadImage: ImageLoader,
): Segment[] => {
	const segments: Segment[] = [];
	let pending = "";
	let cursor = 0;
	for (const { start, end, name, hash } of parseImageReferences(content)) {
		const anchor = imageAnchor(name);
		pending += content.slice(cursor, start) + anchor;
		cursor = end;
		const image = images.get(`${block}:${start}`)?.disposition === "send" ? loadImage(hash) : undefined;
		if (image === undefined) continue;
		segments.push({ text: pending }, { anchor, image });
		pending = "";
	}
	pending += content.slice(cursor);
	if (pending.length > 0) segments.push({ text: pending });
	return segments;
};

const imagePart = ({ bytes, mediaType }: LoadedImage): UserPart => ({ type: "file", data: bytes, mediaType });

const userParts = (segments: readonly Segment[]): UserPart[] =>
	segments.map((segment): UserPart => "image" in segment
		? imagePart(segment.image)
		: { type: "text", text: segment.text });

// @approved
//  Images only travel in user messages. A system or assistant message keeps
// its text and anchors; its Images follow in a user message, each after its
// anchor. A system message's Images wait for the end of its run of system
// messages, so a leading run stays leading.
const followingImages = (segments: readonly Segment[]): UserPart[] =>
	segments.flatMap((segment): UserPart[] =>
		"image" in segment ? [{ type: "text", text: segment.anchor }, imagePart(segment.image)] : []);

export function toMessages(
	{ promptPlan }: Pick<ModelClientGenerationInput, "promptPlan">,
	load: ImageLoader,
): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const loaded = new Map<string, LoadedImage | undefined>();
	const loadImage = (hash: string) => {
		if (!loaded.has(hash)) loaded.set(hash, load(hash));
		return loaded.get(hash);
	};
	const images = new Map(promptPlan.images.map((image) => [`${image.block}:${image.start}`, image]));
	const renderBlock = (blockIndex: number, content: string) =>
		renderContent(blockIndex, content, images, loadImage);
	let systemImages: UserPart[] = [];
	const flushSystemImages = () => {
		if (systemImages.length > 0) messages.push({ role: "user", content: systemImages });
		systemImages = [];
	};
	const push = (role: "system" | "user" | "assistant", segments: readonly Segment[]) => {
		const sent = segments.some((segment) => "image" in segment);
		const text = segments.map((segment) => "text" in segment ? segment.text : "").join("");
		if (role === "system") {
			messages.push({ role, content: text });
			systemImages.push(...followingImages(segments));
			return;
		}
		flushSystemImages();
		if (role === "user") {
			messages.push({ role, content: sent ? userParts(segments) : text });
			return;
		}
		messages.push({ role, content: text });
		if (sent) messages.push({ role: "user", content: followingImages(segments) });
	};

	const continuationIntent = promptPlan.intent?.type === "continuation"
		? promptPlan.intent
		: undefined;
	const prefill = continuationIntent?.strategy === "assistant-prefill" ? continuationIntent : undefined;
	if (prefill !== undefined && !isPrefillSuffix(prefill.suffix)) {
		throw new ModelClientTransportError(
			"The selected Assistant prefill suffix is unsupported by this adapter.",
			"protocol",
		);
	}
	const prefillIndex = prefill === undefined ? -1 : promptPlan.blocks.findLastIndex((block) =>
		block.kind === "history" && block.role === "model");
	let lastHistoryMessage: ChatMessage | undefined;
	for (const [blockIndex, block] of promptPlan.blocks.entries()) {
		if (block.kind === "history") {
			// @approved
			//  The selected preceding model text is moved to the final assistant
			// message below when prefill is active. Leaving the history copy in
			// place would send the prefix twice and would not be a true prefill.
			if (blockIndex === prefillIndex) {
				continue;
			}
			if (block.content.length > 0) {
				push(block.role === "model" ? "assistant" : "user", renderBlock(blockIndex, block.content));
				lastHistoryMessage = messages.at(-1);
			}
			continue;
		}
		if (block.content.length === 0) continue;
		// @approved
		//  The compiled presentation role is presentation truth: the recipe
		// slot chose it and the plan kept it provider-neutral, so the adapter
		// owns the same translation it applies to history authorship.
		push(providerRoleFor[block.role], renderBlock(blockIndex, block.content));
	}
	flushSystemImages();
	// @approved
	//  Continuation instructions are request intent, not Conversation history:
	// a trailing system message, or a user message when Strict System
	// Placement demoted it. Either way nothing is persisted as a turn.
	if (continuationIntent?.strategy === "instruction" && continuationIntent.instruction.length > 0) {
		messages.push({
			role: continuationIntent.demoted === true ? "user" : "system",
			content: projectImageAnchors(continuationIntent.instruction),
		});
	}
	if (prefill !== undefined) {
		const prefix = promptPlan.blocks[prefillIndex]?.content;
		if (prefix === undefined || prefix.length === 0) {
			throw new ModelClientTransportError(
				"Assistant prefill requires a visible preceding model message.",
				"protocol",
			);
		}
		if (promptPlan.images.some((image) => image.block === prefillIndex && image.disposition === "send")) {
			throw new ModelClientTransportError(
				"Assistant prefill cannot continue text that contains an Image. Continue with an instruction instead.",
				"protocol",
			);
		}
		messages.push({
			role: "assistant",
			content: `${projectImageAnchors(prefix)}${prefill.suffix}`,
		});
		lastHistoryMessage = messages.at(-1);
	}
	if (lastHistoryMessage !== undefined) lastHistoryMessage.providerOptions = cacheBreakpoint;
	return messages;
}

function isPrefillSuffix(value: string): value is "" | " " | "\n" | "\n\n" {
	return value === "" || value === " " || value === "\n" || value === "\n\n";
}
