import type { Portrait } from "../../shared/contract/image";
import type { PromptChannels } from "../../shared/contract/prompt-schema";
import type { PortraitColumnRow, PromptChannelRow } from "../database/schema";

// @approved
//  Storage codec for the Prompt channels and Portrait columns that
//  character_prompt and participant_prompt both store. Character Definitions
//  and Conversation Participants map through this one declaration, so their
//  rows can never drift apart.

export const fromPortraitColumns = (row: PortraitColumnRow | undefined): Portrait | undefined =>
	row?.portrait_hash == null
		? undefined
		: { hash: row.portrait_hash, focalX: row.portrait_focal_x!, focalY: row.portrait_focal_y! };

export const toPromptChannelRow = (prompt: PromptChannels): PromptChannelRow => ({
	system_instruction: prompt.systemInstruction,
	identity: prompt.identity,
	scenario: prompt.scenario,
	example_dialogue: prompt.exampleDialogue,
	post_history_instruction: prompt.postHistoryInstruction,
});

export const toPromptChannels = (row: PromptChannelRow): PromptChannels => ({
	systemInstruction: row.system_instruction,
	identity: row.identity,
	scenario: row.scenario,
	exampleDialogue: row.example_dialogue,
	postHistoryInstruction: row.post_history_instruction,
});
