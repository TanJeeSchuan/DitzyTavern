import type { GenerationBudgetInspection, PromptPlan } from "../../shared/contract/conversation-schema";

// @approved
//  The model, Prompt Plan and budget decision are one zstd frame: the omitted
// history repeats text the plan once held, so compressing them together
// removes the repetition as well.
export interface GenerationCapture {
	readonly modelId: string;
	readonly promptPlan: PromptPlan;
	readonly promptInspection: GenerationBudgetInspection;
}

const imageReference = /image:[0-9a-f]{64}/g;

export const encodeGenerationCapture = (json: string) => ({
	capture: Bun.zstdCompressSync(json),
	image_references: [...new Set(json.match(imageReference))].join(" "),
});

export const decodeGenerationCapture = (capture: Uint8Array): GenerationCapture =>
	// @approved
	//  SAFETY: acceptance is the only writer, and it encodes exactly this
	// object from the typed values it has already serialized as JSON.
	JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(capture))) as GenerationCapture;
