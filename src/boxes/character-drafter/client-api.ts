import { useQuery } from "@tanstack/react-query";
import { Value } from "@sinclair/typebox/value";
import { createParser } from "eventsource-parser";
import { useEffect, useRef, useState } from "react";
import { boxApi, requestData, type ConversationSummary } from "@/box-sdk/client";
import { draftEvent, drafterRead, type CharacterDraft, type DraftActivity, type DraftRequest } from "./contract";
import descriptor from "./shared-descriptor";
import type { DrafterRoutes } from "./server-routes";

const drafter = boxApi<DrafterRoutes>(descriptor.id);

/** @approved The people Memory knows in this Chat and why a draft cannot start, read again whenever the Chat changes. */
export const useDrafterRead = (conversation: ConversationSummary) => useQuery({
	queryKey: ["box", descriptor.id, conversation.id, conversation.revision],
	queryFn: ({ signal }) => requestData(drafter.conversations({ id: String(conversation.id) }).get({ fetch: { signal } }), drafterRead),
	placeholderData: (previous) => previous,
});

/** @approved One draft as the writer watches it: the steps the agent ran, and how it ended once it has. */
export type DraftRun =
	| { readonly status: "idle" }
	| { readonly status: "running" | "cancelled"; readonly activities: readonly DraftActivity[] }
	| { readonly status: "drafted"; readonly activities: readonly DraftActivity[]; readonly draft: CharacterDraft }
	| { readonly status: "failed"; readonly activities: readonly DraftActivity[]; readonly reason: string };

const activitiesOf = (run: DraftRun) => run.status === "idle" ? [] : run.activities;

// @approved
//  Starts a draft and follows its stream: each step joins the feed, and the
// draft or the failure ends it. Cancelling, starting again or unmounting
// closes the stream, which cancels the run on the server; a closed stream's
// late frames have nowhere to land.
export function useDraftRun(onDraft?: (draft: CharacterDraft) => void) {
	const controller = useRef<AbortController | null>(null);
	const [run, setRun] = useState<DraftRun>({ status: "idle" });
	useEffect(() => () => controller.current?.abort(), []);
	const start = async (request: DraftRequest) => {
		controller.current?.abort();
		const active = new AbortController();
		controller.current = active;
		const update = (next: (run: DraftRun) => DraftRun) => { if (controller.current === active) setRun(next); };
		setRun({ status: "running", activities: [] });
		let ended = false;
		try {
			const response = await fetch(`/api/boxes/${descriptor.id}/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: active.signal });
			if (!response.ok || response.body === null) throw new Error("The draft could not start. Try again.");
			const parser = createParser({ onEvent: ({ data }) => {
				const event: unknown = JSON.parse(data);
				if (!Value.Check(draftEvent, event)) throw new Error("The draft stream sent something unreadable. Try again.");
				if (event.type === "activity") return update((current) => ({ status: "running", activities: [...activitiesOf(current), event.activity] }));
				ended = true;
				if (event.type === "failed") return update((current) => ({ status: "failed", activities: activitiesOf(current), reason: event.message }));
				update((current) => ({ status: "drafted", activities: activitiesOf(current), draft: event.draft }));
				if (controller.current === active) onDraft?.(event.draft);
			} });
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			try {
				for (let next = await reader.read(); !next.done; next = await reader.read()) parser.feed(decoder.decode(next.value, { stream: true }));
			} finally { reader.releaseLock(); }
			if (!ended) throw new Error("The draft stream ended before the draft. Try again.");
		} catch (error) {
			if (!active.signal.aborted) update((current) => ({ status: "failed", activities: activitiesOf(current), reason: error instanceof Error ? error.message : String(error) }));
		} finally {
			if (controller.current === active) controller.current = null;
		}
	};
	const cancel = () => {
		controller.current?.abort();
		controller.current = null;
		setRun((current) => ({ status: "cancelled", activities: activitiesOf(current) }));
	};
	return { run, start, cancel };
}
