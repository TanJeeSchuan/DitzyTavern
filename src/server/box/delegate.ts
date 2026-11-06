/* eslint-disable anti-slop/no-unknown-parameters -- libfx hands the tool the model's arguments as unknown JSON, which it checks against the operations schema first. */
import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createFxAgent, memory } from "libfx/node";
import { delegateApplyInput } from "../../shared/contract/box-descriptor";
import type { BoxValue } from "../../shared/contract/box-value";
import type { GenerationJsonValue } from "../../shared/generation-json";
import type { LibfxOptions } from "../authoring/provider";

/** @approved The steps one delegate run may take: model requests and tool calls count against the same cap. */
export const DELEGATE_STEPS = 10;
/** @approved The most a delegate's prompt may hold; structured state is never cut short to fit. */
export const DELEGATE_PROMPT_BYTES = 64 * 1024;

const instructions = (label: string, summary: string) => [
	`You are the delegate of the ${label} Box, a story feature: ${summary}`,
	"Someone writing the story asked for a change to the Box in a passage. Turn the request into one batch of the Box's operations and call apply once with it; the apply tool's schema describes each operation.",
	"Read the state to see what is there before the passage. Propose only what the request asks for. Once apply succeeds, end your turn without another call. You have no other tools.",
];

/** @approved What one delegate run is handed: the Box's name and summary, its operations schema, the passage and the request it holds, and the state before the passage. */
export type DelegateCall = {
	readonly options: LibfxOptions;
	readonly label: string;
	readonly summary: string;
	readonly operations: TSchema;
	readonly passage: string;
	readonly request: string;
	readonly state: GenerationJsonValue | undefined;
	readonly signal: AbortSignal;
};

// @approved
//  One delegate run: a libfx agent on the Wasm backend, built for this run
// and closed with it, whose only tool is `apply(batch)`, checked against the
// Box's operations. An invalid batch goes back to the model as a tool error,
// so the first valid call is the batch; a second call after it, an agent
// that ends without one, a model failure and the step cap each fail the run
// with their reason. The job's signal cancels the turn and its fetches.
// Nothing reaches the agent but the prompt and the schema: no read view, Box
// values, Library, Characters or database.
export const runDelegateAgent = async ({ options, label, summary, operations, passage, request, state, signal }: DelegateCall): Promise<readonly BoxValue[]> => {
	const prompt = `Passage:\n${passage}\n\nRequest:\n${request}\n\nState before the passage, as JSON:\n${JSON.stringify(state ?? null)}`;
	if (Buffer.byteLength(prompt) > DELEGATE_PROMPT_BYTES) throw new Error(`The delegate's prompt is over its ${DELEGATE_PROMPT_BYTES / 1024} KiB limit, and its state is not cut short to fit.`);
	const input = delegateApplyInput(operations);
	const turn = new AbortController();
	const aborted = AbortSignal.any([signal, turn.signal]);
	let failure: string | undefined;
	let refusal: string | undefined;
	let batch: readonly BoxValue[] | undefined;
	let steps = 0;
	const fail = (reason: string): never => {
		failure ??= reason;
		turn.abort();
		throw new Error(reason);
	};
	const step = () => {
		steps += 1;
		if (steps > DELEGATE_STEPS) fail(`The delegate passed its ${DELEGATE_STEPS}-step limit.`);
	};
	const agent = createFxAgent({
		backend: "wasm", durability: memory(), name: "delegate", instructions: instructions(label, summary),
		tools: [{
			name: "apply", description: "Applies one batch of the Box's operations. Call it once.", idempotent: true, writes: true,
			inputSchema: JSON.parse(JSON.stringify(input)),
			execute: (proposed: unknown) => {
				step();
				if (batch !== undefined) fail("The delegate called apply a second time.");
				// @approved
				// libfx parsed the arguments from JSON, so a batch that passes the operations schema is JSON.
				if (Value.Check(input, proposed)) {
					batch = proposed.operations;
					return "Applied. End your turn.";
				}
				const error = Value.Errors(input, proposed).First();
				refusal = `The delegate's batch is invalid${error === undefined ? "" : ` at ${error.path || "/"}: ${error.message}`}.`;
				return { type: "libfx.tool-result", text: refusal, images: [], isError: true };
			},
		}],
		...options,
		fetch: async (input: string, init: RequestInit) => {
			step();
			return await options.fetch(input, { ...init, signal: init.signal === undefined || init.signal === null ? aborted : AbortSignal.any([init.signal, aborted]) });
		},
	});
	try {
		const result = await agent.session().prompt(prompt, { signal: aborted }).result.catch((error: unknown) => ({ stopReason: "error" as const, error: { message: error instanceof Error ? error.message : String(error) } }));
		signal.throwIfAborted();
		if (failure !== undefined) throw new Error(failure);
		if (result.stopReason === "error") throw new Error(`The delegate's model request failed: ${result.error?.message ?? "no reason given"}`);
		if (result.stopReason !== "end_turn") throw new Error(`The delegate's turn ended without finishing (${result.stopReason}).`);
		if (batch === undefined) throw new Error(refusal ?? "The delegate ended without calling apply.");
		return batch;
	} finally {
		await agent.close().catch(() => undefined);
	}
};
