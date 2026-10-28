import type { ConversationJsonValue } from "./types";

// @approved
//  The three prompt captures are one zstd frame: the plan repeats the writing
// context's text, so compressing them together removes the repetition as
// well (a 77k-token Chat's 920 KB capture stores as about 200 KB).
export interface GenerationCapture {
	readonly promptPlan: ConversationJsonValue;
	readonly promptInspection: ConversationJsonValue;
	readonly promptContext: ConversationJsonValue;
}

const imageReference = /image:[0-9a-f]{64}/g;

export const encodeGenerationCapture = (json: string) => ({
	capture: Bun.zstdCompressSync(json),
	image_references: [...new Set(json.match(imageReference))].join(" "),
});

export const decodeGenerationCapture = (capture: Uint8Array): GenerationCapture =>
	// @approved
	//  SAFETY: acceptance is the only writer, and it encodes exactly this
	// object from three values it has already serialized as JSON.
	JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(capture))) as GenerationCapture;
