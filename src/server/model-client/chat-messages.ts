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

type ChatMessage =
	| { role: "system" | "assistant"; content: string }
	| { role: "user"; content: string | UserPart[] };

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

const speakerPrefix = (speakerName: string | null): string => speakerName === null ? "" : `${speakerName}: `;

const userParts = (segments: readonly Segment[], speakerName: string | null): UserPart[] =>
	segments.map((segment, index): UserPart => "image" in segment
		? imagePart(segment.image)
		: { type: "text", text: `${index === 0 ? speakerPrefix(speakerName) : ""}${segment.text}` });

// @approved
//  Images only travel in user messages. A system or assistant message keeps
// its text and anchors; its Images follow in a user message, each after its
// anchor.
const followingImages = (segments: readonly Segment[]): UserPart[] =>
	segments.flatMap((segment): UserPart[] =>
		"image" in segment ? [{ type: "text", text: segment.anchor }, imagePart(segment.image)] : []);

export function toMessages(
	input: Pick<ModelClientGenerationInput, "promptPlan" | "assistantPrefill">,
	load: ImageLoader,
): ChatMessage[] {
	const messages: ChatMessage[] = [];
	const loaded = new Map<string, LoadedImage | undefined>();
	const loadImage = (hash: string) => {
		if (!loaded.has(hash)) loaded.set(hash, load(hash));
		return loaded.get(hash);
	};
	const images = new Map(input.promptPlan.images.map((image) => [`${image.block}:${image.start}`, image]));
	const renderBlock = (blockIndex: number, content: string) =>
		renderContent(blockIndex, content, images, loadImage);
	const push = (role: "system" | "user" | "assistant", segments: readonly Segment[], speakerName: string | null = null) => {
		const sent = segments.some((segment) => "image" in segment);
		const text = `${speakerPrefix(speakerName)}${segments.map((segment) => "text" in segment ? segment.text : "").join("")}`;
		if (role === "user") {
			messages.push({ role, content: sent ? userParts(segments, speakerName) : text });
			return;
		}
		messages.push({ role, content: text });
		if (sent) messages.push({ role: "user", content: followingImages(segments) });
	};

	const continuationIntent = input.promptPlan.intent?.type === "continuation"
		? input.promptPlan.intent
		: undefined;
	const assistantPrefill = continuationIntent?.strategy === "assistant-prefill";
	if (assistantPrefill && !isPrefillSuffix(continuationIntent.suffix)) {
		throw new ModelClientTransportError(
			"The selected Assistant prefill suffix is unsupported by this adapter.",
			"protocol",
		);
	}
	if (
		assistantPrefill &&
		input.assistantPrefill !== undefined &&
		input.assistantPrefill.suffix !== continuationIntent.suffix
	) {
		throw new ModelClientTransportError(
			"Assistant prefill metadata does not match the selected suffix.",
			"protocol",
		);
	}
	const lastModelHistoryIndex = input.promptPlan.blocks.reduce(
		(last, block, index) => block.kind === "history" && block.role === "model"
			? index
			: last,
		-1,
	);
	let lastModelHistoryContent: string | undefined;
	for (const [blockIndex, block] of input.promptPlan.blocks.entries()) {
		if (block.kind === "history") {
			const role = block.role;
			if (role === "model") {
				lastModelHistoryContent = block.content;
			}
			// @approved
			//  The selected preceding model text is moved to the final assistant
			// message below when prefill is active. Leaving the history copy in
			// place would send the prefix twice and would not be a true prefill.
			if (assistantPrefill && blockIndex === lastModelHistoryIndex) {
				continue;
			}
			if (block.content.length > 0) {
				push(role === "model" ? "assistant" : "user", renderBlock(blockIndex, block.content), block.speakerName);
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
	// @approved
	//  Continuation instructions are request intent, not Conversation history.
	// Keep them as an adapter-owned system message so no synthetic user turn
	// is persisted or inferred by the provider-neutral workflow.
	if (continuationIntent?.strategy === "instruction") {
		if (continuationIntent.instruction.length > 0) {
			messages.push({ role: "system", content: projectImageAnchors(continuationIntent.instruction) });
		}
	}
	if (continuationIntent?.strategy === "assistant-prefill") {
		const prefix = input.assistantPrefill?.prefix ?? lastModelHistoryContent;
		if (lastModelHistoryIndex < 0 || prefix === undefined || prefix.length === 0) {
			throw new ModelClientTransportError(
				"Assistant prefill requires a visible preceding model message.",
				"protocol",
			);
		}
		if (input.promptPlan.images.some((image) => image.block === lastModelHistoryIndex && image.disposition === "send")) {
			throw new ModelClientTransportError(
				"Assistant prefill cannot continue text that contains an Image. Continue with an instruction instead.",
				"protocol",
			);
		}
		messages.push({
			role: "assistant",
			content: `${projectImageAnchors(prefix)}${continuationIntent.suffix}`,
		});
	}
	return messages;
}

function isPrefillSuffix(value: string): value is "" | " " | "\n" | "\n\n" {
	return value === "" || value === " " || value === "\n" || value === "\n\n";
}
