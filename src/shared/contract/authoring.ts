import { Type, type Static } from "@sinclair/typebox";
import { boxValue } from "./box-value";
import { decisionAnswer } from "./decision-model";
import { snapshotQuery } from "./box-sandboxed";

const passage = Type.String({ maxLength: 16 * 1024 });
const decisions = Type.Record(Type.String(), decisionAnswer, { description: "The digest's decide answers, keyed by question id, each as the Decision Model answers it." });
const participantRows = Type.Array(Type.Object({ participantId: Type.Integer({ minimum: 1 }), value: Type.String() }, { additionalProperties: false }));
const libraryRows = Type.Array(Type.Object({ key: Type.String(), value: Type.String(), revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }));
const characterRows = Type.Array(Type.Object({ characterId: Type.Integer({ minimum: 1 }), revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }));
const [participantQuery, libraryKeyQuery, libraryPrefixQuery, characterQuery] = snapshotQuery.anyOf;

// @approved
//  One `run_scenario` call: a setup when the Box has one, a Cast by name (the
// first is the human seat, the second speaks each passage), a seed, and
// turns, each a Human Message's Moves, the passage that answers it and the
// digest's scripted `decide` answers. Each swipe replaces an earlier turn's
// Variant, keeping that turn's seed and Moves. `snapshot` scripts each
// answer `read` may ask for, so a scenario never reads the database. Every
// list is bounded, since the arguments come from a model.
export const scenarioInput = Type.Object({
	setup: Type.Optional(boxValue),
	cast: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 8 }),
	seed: Type.String({ maxLength: 200 }),
	turns: Type.Array(Type.Object({
		moves: Type.Optional(Type.Array(boxValue, { maxItems: 32 })),
		prose: Type.Optional(passage),
		decisions: Type.Optional(decisions),
	}, { additionalProperties: false }), { minItems: 1, maxItems: 40 }),
	swipes: Type.Optional(Type.Array(Type.Object({
		turn: Type.Integer({ minimum: 0, description: "The index of the turn whose Variant this swipe replaces." }),
		prose: Type.Optional(passage),
		decisions: Type.Optional(decisions),
	}, { additionalProperties: false }), { maxItems: 20 })),
	snapshot: Type.Optional(Type.Array(Type.Union([
		Type.Object({ query: participantQuery, answer: participantRows }, { additionalProperties: false }),
		Type.Object({ query: Type.Union([libraryKeyQuery, libraryPrefixQuery]), answer: libraryRows }, { additionalProperties: false }),
		Type.Object({ query: characterQuery, answer: characterRows }, { additionalProperties: false }),
	]), { maxItems: 64 })),
}, { additionalProperties: false });
export type ScenarioInput = Static<typeof scenarioInput>;

const promptItem = Type.Object({ text: Type.String(), priority: Type.Number(), pinned: Type.Optional(Type.Boolean()), literal: Type.Optional(Type.Boolean()) });
/** @approved One turn or swipe as the scenario ran it: its Moves as history renders them, the prompt items `advance` returned, and the record its Variant holds. */
const scenarioTurn = Type.Object({ moves: Type.Array(Type.String()), items: Type.Array(promptItem), record: Type.Optional(Type.Unknown()) });
// @approved
//  What a scenario returns. `diagnostics` holds every refusal and failure the
// loader or a hook raised; a scenario stops at the first, keeping what ran.
// `records` are the selected Variants' records in order, folded into `state`,
// and `recordBytes` their JSON size. A Box with a window reports its `read`,
// and a digesting Box its `status`.
export const scenarioResult = Type.Object({
	ok: Type.Boolean(),
	diagnostics: Type.Array(Type.String()),
	turns: Type.Array(scenarioTurn),
	swipes: Type.Array(scenarioTurn),
	state: Type.Optional(Type.Unknown()),
	records: Type.Array(Type.Unknown()),
	recordBytes: Type.Integer({ minimum: 0 }),
	read: Type.Optional(Type.Object({ view: Type.Unknown(), status: Type.Optional(Type.Union([Type.String(), Type.Null()])) })),
	status: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type ScenarioResult = Static<typeof scenarioResult>;

/** @approved The coding model for one authoring session: a chat Connection Profile and its model. No limits are declared, so libfx sends no output limit and the provider's own default applies. */
export const codingModel = Type.Object({
	profileId: Type.Integer(),
	model: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type CodingModel = Static<typeof codingModel>;

/** @approved Steps per writer message: model requests and tool calls each count against it, and `null` sets no limit. */
export const authoringSteps = Type.Union([Type.Literal(40), Type.Literal(100), Type.Null()]);
export type AuthoringSteps = Static<typeof authoringSteps>;
/** @approved How many more steps Continue gives a paused message. */
export const CONTINUE_STEPS = 20;
export const authoringStartBody = Type.Object({ ...codingModel.properties, steps: authoringSteps }, { additionalProperties: false });
export const authoringStepsBody = Type.Object({ steps: authoringSteps }, { additionalProperties: false });

export const authoringRefused = Type.Object({ outcome: Type.Literal("refused"), reason: Type.String() });
/** @approved A session id names its folder, so it is only ever the UUID the host made. */
export const authoringSessionParams = Type.Object({ session: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }) });
export const authoringPromptBody = Type.Object({ text: Type.String({ minLength: 1, maxLength: 32 * 1024 }) });
const authoringInstalled = Type.Object({ outcome: Type.Literal("installed"), id: Type.String(), label: Type.String() });
const authoringInstallRefused = Type.Object({ outcome: Type.Literal("refused"), reason: Type.String(), diagnostics: Type.Array(Type.String()) });
export const authoringInstall = Type.Union([authoringInstalled, authoringInstallRefused]);

/** @approved A candidate's fixed files as they stand, for the panel to show; a file the agent has not written is absent. */
export const authoringFiles = Type.Object({ files: Type.Array(Type.Object({ name: Type.String(), content: Type.String() })) });

/** @approved `read_contract`'s arguments: nothing for the contract, or the built-in Box whose sources it returns. */
export const readContractInput = Type.Object({
	example: Type.Optional(Type.Union([Type.Literal("mood"), Type.Literal("race")])),
	file: Type.Optional(Type.String({ description: "One of the example's files, as its listing names them." })),
}, { additionalProperties: false });
/** @approved A write tool's arguments: the whole of its one file, and nothing else. */
export const authoredContent = (description: string) => Type.Object({ content: Type.String({ description }) }, { additionalProperties: false });
/** @approved The JSON a `descriptor.json` write must hold: one object, whose id the host sets. */
export const authoredDescriptor = Type.Record(Type.String(), Type.Unknown());
/** @approved The part of a written descriptor a saved session is listed by. */
export const authoredLabel = Type.Object({ label: Type.String() });

// @approved
//  What one authoring turn streams, as NDJSON: the agent's reply text and its
// reasoning, each tool call as it starts, with its input as JSON text, and as
// it ends, with the text the agent read, each scenario's result beside its
// tool call, a pause once the message has taken its steps, and how the turn
// ended. An input or result over the host's cap arrives cut short, marked
// `truncated`.
export const authoringEvent = Type.Union([
	Type.Object({ type: Type.Literal("text"), delta: Type.String() }),
	Type.Object({ type: Type.Literal("reasoning"), delta: Type.String(), truncated: Type.Boolean() }),
	Type.Object({ type: Type.Literal("tool"), id: Type.String(), name: Type.String(), input: Type.String(), truncated: Type.Boolean() }),
	Type.Object({ type: Type.Literal("tool-end"), id: Type.String(), name: Type.String(), isError: Type.Boolean(), content: Type.String(), truncated: Type.Boolean() }),
	Type.Object({ type: Type.Literal("scenario"), id: Type.String(), result: scenarioResult }),
	Type.Object({ type: Type.Literal("paused"), steps: Type.Integer({ minimum: 1 }) }),
	Type.Object({ type: Type.Literal("end"), stopReason: Type.String(), error: Type.Optional(Type.String()) }),
]);
export type AuthoringEvent = Static<typeof authoringEvent>;

// @approved
//  One line of a session's saved log: the writer's message, an event the
// panel was streamed, or a scenario's whole input, saved because the tool
// event the panel sees cuts a large input short.
export const authoringLogEntry = Type.Union([
	Type.Object({ type: Type.Literal("prompt"), text: Type.String() }),
	Type.Object({ type: Type.Literal("scenario-input"), id: Type.String(), input: scenarioInput }),
	authoringEvent,
]);
export type AuthoringLogEntry = Static<typeof authoringLogEntry>;
export const authoringStarted = Type.Object({ outcome: Type.Literal("started"), session: Type.String(), candidate: Type.String() });
export const authoringStart = Type.Union([authoringStarted, authoringRefused]);

// @approved
//  What a session keeps in its folder's meta.json beside its checkpoint, log
// and candidate: the Box id its candidate has, the coding model and steps it
// last ran with, whether it installed its Box, and when it last changed.
export const authoringMeta = Type.Object({
	box: Type.String(),
	...codingModel.properties,
	steps: authoringSteps,
	installed: Type.Boolean(),
	updated: Type.String(),
}, { additionalProperties: false });
export type AuthoringMeta = Static<typeof authoringMeta>;
/** @approved A saved session as the panel lists it: its label once descriptor.json has one, and `installed` only while the Box it installed is still loaded. */
export const authoringSessions = Type.Object({ sessions: Type.Array(Type.Object({
	session: Type.String(),
	...authoringMeta.properties,
	label: Type.Union([Type.String(), Type.Null()]),
})) });
