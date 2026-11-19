import type { ConversationDatabase } from "../internal";
import { readProfileApiFormat } from "../../connection-settings/persistence";
import { updateConversationModelSelection } from "../generation-settings";
import { InvalidConversationCommandError } from "../errors";

export interface SetGenerationModelInput {
	conversationId: number;
	connectionProfileId: number;
	modelId: string;
}

// @approved
//  The focused model-selection command: the client submits only the model ID,
// and this handler merges it into the stored Generation Settings inside the
// command transaction. The merge happens server-side so a model selection is
// structurally unable to rewrite any other editor's settings fields the way
// a second client-side full-object writer could.
export function setGenerationModel(
	db: ConversationDatabase,
	input: SetGenerationModelInput,
) {
	const modelId = input.modelId.trim();
	if (modelId.length === 0) throw new InvalidConversationCommandError("A model ID is required.");
	const apiFormat = readProfileApiFormat(db, input.connectionProfileId);
	if (apiFormat === undefined) throw new InvalidConversationCommandError("The selected Connection Profile is unavailable.");
	if (apiFormat === "images") throw new InvalidConversationCommandError("An Images connection cannot write Messages. Choose a chat model.");
	if (apiFormat === "embeddings") throw new InvalidConversationCommandError("An Embeddings connection cannot write Messages. Choose a chat model.");
	if (apiFormat === "system-one") throw new InvalidConversationCommandError("A System One connection cannot write Messages. Choose a chat model.");
	updateConversationModelSelection(db, input.conversationId, { connectionProfileId: input.connectionProfileId, modelId });
}
