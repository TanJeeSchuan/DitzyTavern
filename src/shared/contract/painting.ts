import { Type, type Static } from "@sinclair/typebox";
import { briefMessageCount, generationFormattingContext } from "./conversation-schema";
import { modelSelection } from "./model-selection";
import { invalidOutcome, notFoundOutcome, notPlayableOutcome } from "./outcomes";
import { referenceSet, referenceSetCommand } from "./reference-set";

export const paintingAspectRatio = Type.Union([Type.Literal("9:16"), Type.Literal("3:4"), Type.Literal("1:1"), Type.Literal("4:3"), Type.Literal("16:9")]);
export const paintingSettings = Type.Object({ aspectRatio: paintingAspectRatio });
export type PaintingAspectRatio = Static<typeof paintingAspectRatio>;
export const DEFAULT_PAINTING_ASPECT_RATIO: PaintingAspectRatio = "1:1";
const paintingInput = Type.Object({ brief: Type.String(), references: Type.String(), ask: Type.String(), imageModel: modelSelection, aspectRatio: paintingAspectRatio });
export const illustration = Type.Composite([paintingInput, Type.Object({ image: Type.String({ pattern: "^image:[0-9a-f]{64}$" }) })]);
export const keptImage = Type.Union([illustration, Type.Object({ image: illustration.properties.image, name: Type.String() })]);
const paintingBase = Type.Composite([paintingInput, Type.Object({ id: Type.String(), variantId: Type.Integer() })]);
const painting = Type.Union([
	Type.Composite([paintingBase, Type.Object({ kind: Type.Literal("painting") })]),
	Type.Composite([paintingBase, Type.Object({ kind: Type.Literal("failed"), message: Type.String() })]),
	Type.Composite([paintingBase, Type.Object({ kind: Type.Literal("illustration"), image: illustration.properties.image })]),
]);
export type Painting = Static<typeof painting>;
export const DEFAULT_BRIEF_MESSAGE_COUNT = 5;

const paintPresetSettings = Type.Object({
	paintPresetId: Type.Integer(),
	briefMessageCount,
	paintPresets: Type.Array(Type.Object({ id: Type.Integer(), name: Type.String() })),
});
export type PaintPresetSettings = Static<typeof paintPresetSettings>;
const referenceSetSelection = Type.Object({ referenceSets: Type.Array(referenceSet, { minItems: 1 }), referenceSetId: Type.String() });
const illustrationsRead = Type.Composite([paintPresetSettings, referenceSetSelection, Type.Object({ aspectRatio: paintingAspectRatio, paintings: Type.Array(painting) })]);
export type IllustrationsRead = Static<typeof illustrationsRead>;
export const paintingCommand = Type.Union([
	Type.Object({ type: Type.Literal("paint"), variantId: Type.Integer(), brief: Type.String({ minLength: 1 }), references: Type.String(), ask: Type.String(), aspectRatio: paintingAspectRatio }),
	Type.Object({ type: Type.Literal("retry"), variantId: Type.Integer(), id: Type.String() }),
	Type.Object({ type: Type.Literal("dismiss"), variantId: Type.Integer(), id: Type.String() }),
	Type.Object({ type: Type.Literal("delete"), variantId: Type.Integer(), id: Type.String() }),
	Type.Object({ type: Type.Literal("keep-in-gallery"), variantId: Type.Integer(), id: Type.String() }),
	Type.Object({ type: Type.Literal("add-to-gallery"), hash: Type.String({ pattern: "^[0-9a-f]{64}$" }), name: Type.String() }),
	Type.Object({ type: Type.Literal("remove-from-gallery"), id: Type.String() }),
	Type.Object({ type: Type.Literal("set-aspect-ratio"), aspectRatio: paintingAspectRatio }),
	...referenceSetCommand.anyOf,
]);
export type PaintingCommand = Static<typeof paintingCommand>;
export const paintingCommandResponse = {
	200: Type.Object({ outcome: Type.Literal("accepted"), referenceRevision: Type.Optional(Type.Object({ before: Type.Integer(), after: Type.Integer() })) }),
	404: notFoundOutcome,
	422: invalidOutcome,
};
export const illustrationsResponse = { 200: illustrationsRead, 404: notFoundOutcome };

export const briefRequest = Type.Object({ ...generationFormattingContext.properties, variantId: Type.Integer(), ask: Type.String() });
export type BriefRequest = Static<typeof briefRequest>;

export const briefResponse = { 404: notFoundOutcome, 409: notPlayableOutcome, 422: invalidOutcome };

const galleryRead = Type.Array(Type.Object({ hash: Type.String({ pattern: "^[0-9a-f]{64}$" }), name: Type.String(), source: Type.String(), keptId: Type.Optional(Type.String()),
	painted: Type.Optional(Type.Pick(paintingInput, ["brief", "references", "ask"])),
}));
export type GalleryRead = Static<typeof galleryRead>;

export const galleryResponse = { 200: galleryRead, 404: notFoundOutcome };
