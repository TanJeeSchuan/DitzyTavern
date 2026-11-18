import { store } from "../lib/store";
import type { PromptChannels } from "../../shared/contract/prompt-schema";

/** @approved A Definition a Box drafted for the writer: its name and Prompt channels. */
export type DefinitionDraft = { readonly name: string; readonly prompt: PromptChannels };
/** @approved A draft on its way to the Characters panel: the Chat it belongs to, and the Cast member it may replace. */
export type DefinitionDraftRequest = { readonly draft: DefinitionDraft; readonly conversationId: number; readonly replaces?: number };

// @approved
//  A Box asks for a draft to open; the workspace opens the Characters panel
// for it through the unsaved-changes guard and hands it on as `opened`,
// which the panel takes into its own view, so a draft lives only while its
// editor is open.
export const requestedDefinitionDraft = store<DefinitionDraftRequest | null>(null);
export const openedDefinitionDraft = store<DefinitionDraftRequest | null>(null);

/** @approved Opens the core Definition editor on a draft for this Chat, offering Add to Cast and Save as Character, and with `replaces`, Replace that Cast member's Definition. Closing the editor discards it. */
export const openDefinitionDraft = (draft: DefinitionDraft, { conversationId, replaces }: { readonly conversationId: number; readonly replaces?: number }) =>
	requestedDefinitionDraft.set({ draft, conversationId, replaces });
