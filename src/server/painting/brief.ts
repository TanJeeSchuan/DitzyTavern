import type { Database } from "bun:sqlite";
import { authorRoleOf, ConversationNotFoundError, ConversationNotPlayableError, InvalidConversationCommandError,
	readConversationSummaryFromConnection, readConversationGenerationSettingsFromConnection, readSelectedHistoryThroughVariant,
	readVariantData, runConversationReadTransaction } from "../conversation";
import { createConnectionSettingsModule, connectionSnapshotOf, type ConnectionSettingsModuleOptions } from "../connection-settings";
import { assertGenerationPlan, compileGenerationPlan } from "../generation-plan";
import { createModelClient, projectModelClientGenerationSettings, type ModelFetch } from "../model-client";
import { readPromptPresetRecipe } from "../prompt-preset";
import { readPaintPresetSettings } from "../prompt-preset";
import { hasEnabledBriefInstruction, hasEnabledLoreSlot, type PromptPresetSlot } from "../../shared/contract/prompt-preset";
import { evaluateScopedLore, evaluateScopedLoreAsync, noLoreEvaluation } from "../lorebook/evaluation";
import { createAttemptEnvironment } from "../../shared/prompt-macro-engine";
import { deriveMacroState } from "../prompt-macros";
import { imageLoader } from "../image";
import { promptImageResolutionFor } from "../workflows/prompt-image-resolution";
import type { BriefRequest } from "../../shared/contract/painting";

export async function* writeBrief(database: Database, conversationId: number, request: BriefRequest,
	options: ConnectionSettingsModuleOptions & { fetch?: ModelFetch }, signal: AbortSignal) {
	const captured = runConversationReadTransaction(database, (db) => {
		const chat = readConversationSummaryFromConnection(db, conversationId);
		if (!chat) throw new ConversationNotFoundError(conversationId);
		const human = chat.cast.find((participant) => participant.id === chat.control.humanParticipantId);
		const model = chat.cast.find((participant) => participant.id === chat.control.modelParticipantId);
		if (!human || !model || human.id === model.id) throw new ConversationNotPlayableError(conversationId);
		const selection = readPaintPresetSettings(database, conversationId);
		const preset = readPromptPresetRecipe(database, selection.paintPresetId);
		if (!preset || !hasEnabledBriefInstruction(preset.slots)) throw new InvalidConversationCommandError("Choose a Paint Preset with an enabled Brief instruction.");
		const selected = readSelectedHistoryThroughVariant(db, conversationId, request.variantId)!;
		const messages = selection.briefMessageCount === null ? selected.messages : selected.messages.slice(-selection.briefMessageCount);
		const settings = readConversationGenerationSettingsFromConnection(db, conversationId);
		if (!settings) throw new ConversationNotFoundError(conversationId);
		const connections = createConnectionSettingsModule(database, options);
		const connectionSettings = connections.get();
		const profile = connectionSettings.profiles.find((profile) => profile.id === settings.connectionProfileId);
		if (!profile) throw new InvalidConversationCommandError("Choose a story model and connection before writing a Brief.");
		const connection = connectionSnapshotOf(connectionSettings, profile);
		const variantIds = selected.messages.flatMap(({ variant }) => variant === null ? [] : [variant.id]);
		const variantData = readVariantData(db, variantIds, ["macroWrites"]);
		const variables = deriveMacroState({ initialData: selected.initialData, presetId: preset.id, selectedVariants: selected.messages.map(({ variant }) => ({ selected: variant !== null, macroWrites: variant === null ? [] : variantData.get(variant.id)?.macroWrites ?? [] })) });
		const recipe: PromptPresetSlot[] = preset.slots.map((slot) => slot.reference === "brief-instruction" ? { ...slot, reference: "instruction", name: "Brief instruction" } : slot);
		const context = messages.flatMap((message) => message.variant === null ? [] : [{ kind: "message" as const,
			speakerName: message.author?.capturedName ?? null, content: message.variant.content, role: authorRoleOf(message, chat.control) }]);
		const lore = hasEnabledLoreSlot(recipe) ? evaluateScopedLore({ database, conversationId,
			messages: messages.flatMap((message) => message.variant === null ? [] : [{ id: message.id, content: message.variant.content }]), connectionSettings: options,
		}) : noLoreEvaluation();
		return { human, model, settings, connection, recipe, context, lore,
			ask: request.ask.trim() ? request.ask : `Describe the scene at Message ${selected.position}, the final Message in the supplied history.`,
			attempt: createAttemptEnvironment({ self: human.name, other: model.name, conversationId, promptPresetId: preset.id, now: new Date(), variables, timeZone: request.timeZone, locale: request.locale }),
			client: createModelClient({ profile, secrets: connections.getProfileSecrets(profile.id), loadImage: imageLoader(database), fetch: options.fetch }),
		};
	});
	const lore = captured.lore.activation.mode !== "keyword-fallback" || captured.lore.sources === undefined ? captured.lore : await evaluateScopedLoreAsync(captured.lore.sources, { fetch: options.fetch, signal });
	const plan = assertGenerationPlan(compileGenerationPlan({ ...captured, boxes: {}, lore: lore.candidates, loreAllowance: lore.allowance,
		trailingMessages: [{ role: "human", content: captured.ask }],
		images: promptImageResolutionFor(database, captured.connection, captured.settings),
	}));
	yield* captured.client.generate({ promptPlan: plan.promptPlan, modelId: plan.effectiveSettings.modelId,
		generationSettings: projectModelClientGenerationSettings(plan.effectiveSettings), connection: captured.connection, signal });
}
