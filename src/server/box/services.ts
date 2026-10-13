import type { Database } from "bun:sqlite";
import { requestDecisions } from "../decision-model";
import { embedMemoryTexts } from "../memory/indexing";
import { createModelClient } from "../model-client";
import type { ModelFetch } from "../model-client/types";
import type { BoxContext, BoxServices } from "./contract";

/** @approved Every host service, sending its requests through `fetch` and aborting with `signal`. */
export const boxServices = (database: Database, fetch: ModelFetch | undefined, signal: AbortSignal): BoxContext<keyof BoxServices> => ({
	signal,
	llm: (options) => createModelClient({ ...options, fetch }),
	decide: (request) => requestDecisions({ ...request, fetch, signal }),
	embed: (texts, configuration) => embedMemoryTexts(database, texts, configuration, fetch, signal),
});
