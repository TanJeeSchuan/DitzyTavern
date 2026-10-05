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

// ==[HUMAN APPROVED]== The plan keeps provider-neutral presentation roles; this adapter owns the
// translation into provider vocabulary, exactly as it does for history
// authorship.
const providerRoleFor = {
	system: "system",
	human: "user",
	model: "assistant",
} as const satisfies Record<"system" | "human" | "model", "system" | "user" | "assistant">;

// A piece of writing: plain text, or a sent Image together with its anchor.
type Segment = { text: string } | { anchor: string; image: LoadedImage };

interface RenderedContent {
	// The writing with every Reference read as its anchor.
	readonly text: string;
	readonly segments: Segment[];
	readonly sent: boolean;
}

// Every Reference becomes its anchor in the text; each one the plan marks as
// sent also emits its Image right after the anchor, unless the model is
// text-only or the store no longer holds the bytes.
const renderContent = (
	content: string,
	images: ReadonlyMap<number, PromptImage>,
	loadImage: ImageLoader,
): RenderedContent => {
	const segments: Segment[] = [];
	let pending = "";
	let cursor = 0;
	for (const { start, end, name, hash } of parseImageReferences(content)) {
		const anchor = imageAnchor(name);
		pending += content.slice(cursor, start) + anchor;
		cursor = end;
		const image = images.get(start)?.disposition === "send" ? loadImage(hash) : undefined;
		if (image === undefined) continue;
		segments.push({ text: pending }, { anchor, image });
		pending = "";
	}
	pending += content.slice(cursor);
	if (pending.length > 0) segments.push({ text: pending });
	return { text: projectImageAnchors(content), segments, sent: segments.some((segment) => "image" in segment) };
};

const imagePart = ({ bytes, mediaType }: LoadedImage): UserPart => ({ type: "file", data: bytes, mediaType });

const speakerPrefix = (speakerName: string | null): string => speakerName === null ? "" : `${speakerName}: `;

// A segment list with a sent Image always opens with the text up to its anchor,
// so the speaker prefix joins that first text.
const userParts = (segments: readonly Segment[], speakerName: string | null): UserPart[] =>
	segments.map((segment, index): UserPart => "image" in segment
		? imagePart(segment.image)
		: { type: "text", text: `${index === 0 ? speakerPrefix(speakerName) : ""}${segment.text}` });

// ==[HUMAN APPROVED]== Images only travel in user messages. A system or assistant message keeps
// its text and anchors; its Images follow in a user message, each after its
// anchor.
const followingImages = (segments: readonly Segment[]): UserPart[] =>
	segments.flatMap((segment): UserPart[] =>
		"image" in segment ? [{ type: "text", text: segment.anchor }, imagePart(segment.image)] : []);

export interface ChatMessages {
	readonly messages: ChatMessage[];
	readonly sentImages: boolean;
}

export function toMessages(
	input: ModelClientGenerationInput,
	images: { readonly load: ImageLoader; readonly textOnly: boolean },
): ChatMessages {
	const messages: ChatMessage[] = [];
	let sentImages = false;
	const loaded = new Map<string, LoadedImage | undefined>();
	const loadImage = (hash: string) => {
		if (images.textOnly) return undefined;
		if (!loaded.has(hash)) loaded.set(hash, images.load(hash));
		return loaded.get(hash);
	};
	const imagesByBlock = new Map<number, Map<number, PromptImage>>();
	for (const image of input.promptPlan.images) {
		const block = imagesByBlock.get(image.block) ?? new Map<number, PromptImage>();
		block.set(image.start, image);
		imagesByBlock.set(image.block, block);
	}
	const renderBlock = (blockIndex: number, content: string) =>
		renderContent(content, imagesByBlock.get(blockIndex) ?? new Map(), loadImage);
	const push = (role: "system" | "user" | "assistant", rendered: RenderedContent, speakerName: string | null = null) => {
		sentImages ||= rendered.sent;
		if (role === "user") {
			messages.push({ role, content: rendered.sent ? userParts(rendered.segments, speakerName) : `${speakerPrefix(speakerName)}${rendered.text}` });
			return;
		}
		messages.push({ role, content: `${speakerPrefix(speakerName)}${rendered.text}` });
		if (rendered.sent) messages.push({ role: "user", content: followingImages(rendered.segments) });
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
			// ==[HUMAN APPROVED]== The selected preceding model text is moved to the final assistant
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
		// ==[HUMAN APPROVED]== The compiled presentation role is presentation truth: the recipe
		// slot chose it and the plan kept it provider-neutral, so the adapter
		// owns the same translation it applies to history authorship.
		push(providerRoleFor[block.role], renderBlock(blockIndex, block.content));
	}
	// ==[HUMAN APPROVED]== Continuation instructions are request intent, not Conversation history.
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
		if (!images.textOnly && parseImageReferences(prefix).length > 0) {
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
	return { messages, sentImages };
}

function isPrefillSuffix(value: string): value is "" | " " | "\n" | "\n\n" {
	return value === "" || value === " " || value === "\n" || value === "\n\n";
}
