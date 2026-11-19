import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { loadConversationPromptPreset, type ConversationSummary } from "../../conversation";
import { runConversationCommand } from "../../conversation-command-runner";
import { cancellableFetch, conversationKey } from "../../conversation-query";
import { useVisitSignal } from "../../lib/visit";
import {
	listPromptPresets,
	savePromptPresetBlockPatches,
	type PromptPresetOperationOutcome,
} from "../../prompt-preset-library";
import { dirtyBlockPatches, draftIsDirty, type BlockDraft } from "../../prompt-preset-editor-state";
import type { ConversationPromptPreset } from "../../../shared/contract/prompt-preset";
import { usePromptPresetLibrary } from "./usePromptPresetLibrary";

const recipeKey = ["prompt-preset-editor"] as const;

export const presetLibraryQuery = queryOptions({
	queryKey: ["prompt-presets"],
	staleTime: Infinity,
	queryFn: ({ signal }) => cancellableFetch(signal, undefined, listPromptPresets),
});

export const presetRecipeQuery = (conversationId: number, revision: number, presetId: number | undefined) => queryOptions({
	queryKey: [...recipeKey, conversationId, presetId, revision] as const,
	staleTime: Infinity,
	refetchOnReconnect: false,
	queryFn: ({ signal }) => cancellableFetch(signal, undefined, (cancellation) => loadConversationPromptPreset(conversationId, cancellation, presetId)),
});

const operationProblem = (outcome: Exclude<PromptPresetOperationOutcome, { outcome: "available" }>, message: string) =>
	outcome.outcome === "invalid" || outcome.outcome === "unusable" ? outcome.reason
		: outcome.outcome === "not-found" ? "The selected preset no longer exists."
		: message;

export function usePromptPresetEditor({
	conversation,
	preset,
	presetId,
	recipePending,
	onConversationChange,
	onNotice,
}: {
	conversation: ConversationSummary;
	preset: ConversationPromptPreset | null;
	presetId: number | undefined;
	recipePending: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
	onNotice: (notice: string | null) => void;
}) {
	const client = useQueryClient();
	const signal = useVisitSignal();
	const [drafts, setDrafts] = useState<Record<number, BlockDraft>>({});
	const latestDrafts = useRef(drafts);
	const replaceDrafts = (next: Record<number, BlockDraft>) => {
		latestDrafts.current = next;
		setDrafts(next);
	};
	const [busy, setBusy] = useState<"save" | "change" | null>(null);
	const inFlight = useRef(false);
	const [problem, setProblem] = useState<string | null>(null);
	const setNotice = (notice: string | null) => { if (!signal.aborted) onNotice(notice); };
	const dirty = preset?.slots.some((slot) => {
		const draft = drafts[slot.id];
		return draft !== undefined && draftIsDirty(slot, draft);
	}) ?? (Object.keys(drafts).length > 0);

	async function runOperation<R>(kind: NonNullable<typeof busy>, run: () => Promise<R>): Promise<R | undefined> {
		if (signal.aborted || inFlight.current || recipePending) return;
		inFlight.current = true;
		setBusy(kind);
		try {
			return await run();
		} finally {
			inFlight.current = false;
			setBusy(null);
		}
	}

	const { id } = conversation;
	const revision = () => client.getQueryData<ConversationSummary | null>(conversationKey(id))?.revision ?? conversation.revision;
	const refreshRecipe = async () => {
		await client.cancelQueries({ queryKey: recipeKey });
		await client.invalidateQueries({ queryKey: recipeKey });
		if (signal.aborted) return null;
		const options = presetRecipeQuery(id, revision(), presetId);
		const state = client.getQueryState(options.queryKey);
		if (state?.status === "error") throw state.error;
		return client.fetchQuery(options);
	};

	const applySelection = (selectedId: number) => runOperation("change", async () => {
		const conflict = "The Conversation changed elsewhere; the current state was loaded.";
		const applied = await runConversationCommand({
			conversationId: id,
			revision,
			onConversationChange,
			setNotice,
			isCurrent: () => !signal.aborted,
		}, {
			type: "select-prompt-preset",
			promptPresetId: selectedId,
		}, {
			notices: { conflict, notFound: "The Conversation no longer exists." },
			onNotPlayable: () => setNotice(conflict),
			onApplied: () => setNotice(null),
		});
		if (applied) void client.invalidateQueries({ queryKey: presetLibraryQuery.queryKey });
	});

	const runRecipeOperation = (run: () => Promise<PromptPresetOperationOutcome>) => runOperation("change", async () => {
		setProblem(null);
		const outcome = await run();
		if (outcome.outcome !== "available") {
			setProblem(operationProblem(outcome, "The Prompt Preset change could not be reached."));
			return;
		}
		try {
			await refreshRecipe();
		} catch {
			setProblem("The Prompt Preset change could not be reloaded.");
		}
	});

	const save = async () => await runOperation("save", async () => {
		if (preset === null) return false;
		const { patches, submitted } = dirtyBlockPatches(preset, latestDrafts.current);
		if (patches.length === 0) return true;
		setProblem(null);
		const outcome = await savePromptPresetBlockPatches(preset.id, patches);
		if (outcome.outcome !== "available") {
			setProblem(operationProblem(outcome, "The Prompt Preset change could not be saved."));
			return false;
		}
		try {
			const fresh = await refreshRecipe();
			if (signal.aborted || fresh?.id !== preset.id) return false;

			const confirmed = fresh.slots.filter((slot) => {
				const draft = submitted[slot.id];
				return draft !== undefined && !draftIsDirty(slot, draft);
			});
			const kept = { ...latestDrafts.current };
			for (const { id } of confirmed) if (kept[id] === submitted[id]) delete kept[id];
			replaceDrafts(kept);
			if (confirmed.length !== patches.length) {
				setProblem("The Prompt Preset changed elsewhere while saving.");
				return false;
			}
			return !Object.keys(submitted).some((id) => kept[Number(id)] !== undefined)
				&& dirtyBlockPatches(fresh, kept).patches.length === 0;
		} catch {
			setProblem("The saved Prompt Preset could not be reloaded.");
			return false;
		}
	}) ?? false;

	const library = usePromptPresetLibrary({
		selectedId: preset?.id,
		dirty,
		setNotice,
		refreshRecipe,
		refreshLibrary: () => client.invalidateQueries({ queryKey: presetLibraryQuery.queryKey }, { throwOnError: true }),
		run: async (operation) => { await runOperation("change", operation); },
		signal,
	});

	return {
		...library,
		applySelection,
		runRecipeOperation,
		drafts,
		dirty,
		busy,
		problem,
		save,
		discard: () => replaceDrafts({}),
		setDraft: (blockId: number, draft: BlockDraft) => {
			const enabled = latestDrafts.current[blockId]?.enabled;
			replaceDrafts({ ...latestDrafts.current, [blockId]: enabled === undefined ? draft : { ...draft, enabled } });
		},
		setEnabled: (blockId: number, enabled: boolean) => {
			const draft = latestDrafts.current[blockId];
			replaceDrafts({ ...latestDrafts.current, [blockId]: draft === undefined ? { kind: "enabled", enabled } : { ...draft, enabled } });
		},
		clearDraft: (blockId: number) => {
			const next = { ...latestDrafts.current };
			delete next[blockId];
			replaceDrafts(next);
		},
	};
}
