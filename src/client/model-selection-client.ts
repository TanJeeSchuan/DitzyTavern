import { api } from "./lib/eden";
import { requestData } from "./lib/request-outcome";
import { requestOutcome } from "./lib/request-route-outcome";
import { modelSelectionCommandResponse, modelSelectionReadResponse, type ModelSelectionCommand } from "../shared/contract/model-selection";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { followsChanges } from "./server-changes";
import { foldNewer } from "./lib/visit";

export const modelSelectionClient = (route: "image-model" | "describing-model") => ({
	load: () => requestData(api.api[route].get(), modelSelectionReadResponse[200]),
	save: (command: ModelSelectionCommand) => requestOutcome(api.api[route].commands.post(command), modelSelectionCommandResponse),
});

export const modelSelectionKey = (route: "image-model" | "describing-model") => ["model-selection", route] as const;
const imageModelClient = modelSelectionClient("image-model");
const imageModelKey = modelSelectionKey("image-model");
export const useImageModelSaving = () => useIsMutating({ mutationKey: imageModelKey }) > 0;

export function useImageModel() {
	const client = useQueryClient();
	const read = useQuery({ queryKey: imageModelKey, meta: followsChanges, queryFn: imageModelClient.load });
	const saving = useImageModelSaving();
	const selection = useMutation({
		mutationKey: imageModelKey,
		networkMode: "always",
		mutationFn: async (command: ModelSelectionCommand) => {
			const result = await imageModelClient.save(command);
			if (result.outcome === "available") {
				foldNewer(client, imageModelKey, result.value.settings, (settings) => settings.revision);
				return;
			}
			if (result.outcome === "conflict") {
				foldNewer(client, imageModelKey, result.current, (settings) => settings.revision);
				throw new Error("The Image Model changed elsewhere. Choose again.");
			}
			throw new Error(result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "The Image Model could not be saved.");
		},
	});
	const select = (profileId: number, model: string) => {
		if (read.data !== undefined && !saving) selection.mutate({ type: "apply", expectedRevision: read.data.revision, profileId, model });
	};
	return {
		selected: read.data, select, pending: read.isPending || saving, reload: () => { void read.refetch(); },
		error: selection.error?.message ?? (read.isError ? "The Image Model could not be loaded." : null),
	};
}
