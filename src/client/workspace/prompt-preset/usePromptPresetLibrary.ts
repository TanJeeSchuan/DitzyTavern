import { useState } from "react";
import {
	applyPromptPresetCommand,
	commitSillyTavernPromptPreset,
	importNativePromptPreset,
	loadNativePromptPreset,
	parseNativePromptPreset,
	reviewSillyTavernPromptPreset,
	type PresetCommandOutcome,
	type PromptPresetCommand,
	type SillyTavernImportPreview,
	type SillyTavernImportRequest,
	type SillyTavernJsonValue,
} from "../../prompt-preset-library";
import { downloadNativePromptPreset } from "../../prompt-preset-download";
import { LIBRARY_UNREACHABLE_NOTICE } from "../../character-library";
import { presetDeletionImpactChangedNotice } from "../../prompt-preset-presentation";
import type { ConversationPromptPreset } from "../../../shared/contract/prompt-preset";

export interface SillyTavernReview {
	request: SillyTavernImportRequest & { source: SillyTavernJsonValue };
	preview: SillyTavernImportPreview;
	orderListId: string | null;
}

export function usePromptPresetLibrary({
	selectedId,
	dirty,
	setNotice,
	refreshRecipe,
	refreshLibrary,
	run,
	signal,
}: {
	selectedId: number;
	dirty: boolean;
	setNotice: (notice: string | null) => void;
	refreshRecipe: () => Promise<ConversationPromptPreset | null>;
	refreshLibrary: () => Promise<void>;
	run: (operation: () => Promise<void>) => Promise<void>;
	signal: AbortSignal;
}) {
	const [review, setReview] = useState<SillyTavernReview | null>(null);

	const refreshWithNotice = async (notice: string | null) => {
		try {
			const [, selected] = await Promise.all([refreshLibrary(), refreshRecipe()]);
			setNotice(selected === null ? "The selected Conversation could not be loaded." : notice);
		} catch {
			setNotice(LIBRARY_UNREACHABLE_NOTICE);
		}
	};

	const reportImportFailure = (
		outcome: { outcome: "invalid" | "unusable"; reason: string } | { outcome: "network" },
	): void => setNotice(outcome.outcome === "network" ? LIBRARY_UNREACHABLE_NOTICE : outcome.reason);

	const runPresetCommand = (
		command: PromptPresetCommand,
		successNotice?: (outcome: PresetCommandOutcome) => string | null,
	) => run(async () => {
		if (dirty && command.type === "delete" && selectedId === command.presetId) {
			setNotice("Save or discard the current block edit before deleting its preset.");
			return;
		}
		setNotice(null);
		const outcome = await applyPromptPresetCommand(command);
		switch (outcome.outcome) {
			case "available":
				if (outcome.value.outcome === "applied" || outcome.value.outcome === "deleted") {
					await refreshWithNotice(successNotice?.(outcome) ?? null);
				} else setNotice(LIBRARY_UNREACHABLE_NOTICE);
				break;
			case "conflict":
				await refreshWithNotice(command.type === "delete" && outcome.reason === "deletion-impact"
					? presetDeletionImpactChangedNotice(outcome.current.name, outcome.current.conversationCount)
					: `That preset changed elsewhere. It is now "${outcome.current.name}".`);
				break;
			case "not-removable":
			case "invalid":
			case "unusable":
				setNotice(outcome.reason);
				break;
			case "not-found":
				setNotice("That preset is no longer in the Library.");
				break;
			default:
				setNotice(LIBRARY_UNREACHABLE_NOTICE);
		}
	});

	const exportSelectedPreset = (presetId: number, name: string) => run(async () => {
		setNotice(null);
		try {
			const native = await loadNativePromptPreset(presetId);
			if (signal.aborted) return;
			downloadNativePromptPreset(name, native);
			setNotice(`Exported "${name}".`);
		} catch {
			setNotice("The Prompt Preset could not be exported.");
		}
	});

	const importPresetFile = (file: File) => run(async () => {
		setNotice(null);
		try {
			const text = await file.text();
			if (signal.aborted) return;
			const native = parseNativePromptPreset(text);
			if (native !== null) {
				const outcome = await importNativePromptPreset(native);
				if (outcome.outcome !== "available") reportImportFailure(outcome);
				else if (outcome.value.outcome === "applied") {
					await refreshWithNotice(`Imported "${outcome.value.preset.name}" as a new preset.`);
				} else setNotice(LIBRARY_UNREACHABLE_NOTICE);
				return;
			}

			// @approved
			// SAFETY: The review route validates the JSON value.
			const source = JSON.parse(text) as SillyTavernJsonValue;
			const outcome = await reviewSillyTavernPromptPreset(source, file.name.replace(/\.json$/i, ""));
			if (outcome.outcome !== "available") reportImportFailure(outcome);
			else setReview({
				request: { source, name: outcome.value.name },
				preview: outcome.value,
				orderListId: outcome.value.selectedOrderId,
			});
		} catch {
			setNotice("The selected file is not valid Prompt Preset or SillyTavern JSON.");
		}
	});

	const commitSillyTavernReview = () => run(async () => {
		if (review === null) return;
		if (review.preview.requiresOrderSelection && review.orderListId === null) {
			setNotice("Choose an order list before importing.");
			return;
		}
		const outcome = await commitSillyTavernPromptPreset(review.request.source, review.request.name, review.orderListId ?? undefined);
		if (outcome.outcome !== "available") reportImportFailure(outcome);
		else {
			setReview(null);
			await refreshWithNotice(`Imported "${outcome.value.preset.name}" as a new preset.`);
		}
	});

	const selectSillyTavernOrder = (orderListId: string) => run(async () => {
		if (review === null || orderListId === "") return;
		const outcome = await reviewSillyTavernPromptPreset(review.request.source, review.request.name, orderListId);
		if (outcome.outcome !== "available") reportImportFailure(outcome);
		else setReview({ ...review, preview: outcome.value, orderListId });
	});

	return {
		review,
		runPresetCommand,
		exportSelectedPreset,
		importPresetFile,
		commitSillyTavernReview,
		selectSillyTavernOrder,
		cancelSillyTavernReview: () => setReview(null),
	};
}
