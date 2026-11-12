import { Type, type Static } from "@sinclair/typebox";
import { generationFormattingContext } from "./conversation-schema";
import { modelSelection } from "./model-selection";
import { invalidOutcome, notFoundOutcome, notPlayableOutcome } from "./outcomes";

export const paintingAspectRatio = Type.Union([Type.Literal("9:16"), Type.Literal("3:4"), Type.Literal("1:1"), Type.Literal("4:3"), Type.Literal("16:9")]);
export const paintingSettings = Type.Object({ aspectRatio: paintingAspectRatio });
export type PaintingAspectRatio = Static<typeof paintingAspectRatio>;
export const DEFAULT_PAINTING_ASPECT_RATIO: PaintingAspectRatio = "1:1";
const paintingInput = Type.Object({ brief: Type.String(), imageModel: modelSelection, aspectRatio: paintingAspectRatio });
export const illustration = Type.Composite([paintingInput, Type.Object({ image: Type.String({ pattern: "^image:[0-9a-f]{64}$" }) })]);
const paintingBase = Type.Composite([paintingInput, Type.Object({ id: Type.String(), variantId: Type.Integer() })]);
export const painting = Type.Union([
	Type.Composite([paintingBase, Type.Object({ kind: Type.Literal("painting") })]),
	Type.Composite([paintingBase, Type.Object({ kind: Type.Literal("failed"), message: Type.String() })]),
	Type.Composite([paintingBase, Type.Object({ kind: Type.Literal("illustration"), image: illustration.properties.image })]),
]);
export type Painting = Static<typeof painting>;
export const DEFAULT_BRIEF_MESSAGE_COUNT = 5;

export const paintPresetSettings = Type.Object({
	paintPresetId: Type.Integer(),
	briefMessageCount: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
	paintPresets: Type.Array(Type.Object({ id: Type.Integer(), name: Type.String() })),
});
export type PaintPresetSettings = Static<typeof paintPresetSettings>;
export const paintPresetCommand = Type.Union([
	Type.Object({ type: Type.Literal("select-paint-preset"), paintPresetId: Type.Integer() }),
	Type.Object({ type: Type.Literal("set-brief-message-count"), briefMessageCount: paintPresetSettings.properties.briefMessageCount }),
]);
export type PaintPresetCommand = Static<typeof paintPresetCommand>;
export const illustrationsRead = Type.Object({ ...paintPresetSettings.properties, aspectRatio: paintingAspectRatio, paintings: Type.Array(painting) });
export type IllustrationsRead = Static<typeof illustrationsRead>;
export const paintingCommand = Type.Union([
	paintPresetCommand,
	Type.Object({ type: Type.Literal("paint"), variantId: Type.Integer(), brief: Type.String({ minLength: 1 }), aspectRatio: paintingAspectRatio }),
	Type.Object({ type: Type.Literal("retry"), variantId: Type.Integer(), id: Type.String() }),
	Type.Object({ type: Type.Literal("dismiss"), variantId: Type.Integer(), id: Type.String() }),
	Type.Object({ type: Type.Literal("delete"), variantId: Type.Integer(), id: Type.String() }),
	Type.Object({ type: Type.Literal("set-aspect-ratio"), aspectRatio: paintingAspectRatio }),
]);
export type PaintingCommand = Static<typeof paintingCommand>;
export const paintingAccepted = Type.Object({ outcome: Type.Literal("accepted") });
export const paintingErrors = Type.Union([invalidOutcome, notFoundOutcome]);

export const briefRequest = Type.Object({ ...generationFormattingContext.properties, variantId: Type.Integer(), ask: Type.String() });
export type BriefRequest = Static<typeof briefRequest>;

export const briefErrors = Type.Union([invalidOutcome, notFoundOutcome, notPlayableOutcome]);
