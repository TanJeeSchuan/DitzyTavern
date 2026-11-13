import { useEffect, useRef, useState } from "react";
import { createParser } from "eventsource-parser";
import { decodeWirePayload } from "./lib/wire-decode";
import { generationEvent } from "../shared/contract/generation-events";
import { clientFormattingContext } from "./lib/formatting-context";
import { briefErrors, type BriefRequest } from "../shared/contract/painting";

export function useWriteBrief(conversationId: number, onText: (text: string) => void) {
	const controller = useRef<AbortController | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => () => { controller.current?.abort(); }, [conversationId]);
	const write = async (request: BriefRequest) => {
		if (controller.current) return;
		const active = new AbortController();
		controller.current = active;
		setPending(true);
		setError(null);
		try {
			const response = await fetch(`/api/conversations/${conversationId}/brief`, {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...clientFormattingContext(), ...request }), signal: active.signal,
			});
			if (!response.ok) {
				const failure = decodeWirePayload(briefErrors, await response.json().catch(() => null));
				throw new Error(failure && "reason" in failure ? failure.reason : failure?.outcome === "not-found" ? "The Chat is no longer available." : "The Brief request could not start. Try again.");
			}
			if (!response.body) throw new Error("The Brief request could not start. Try again.");
			let text = "";
			let finished = false;
			const parser = createParser({ onEvent: ({ data }) => {
				const event = decodeWirePayload(generationEvent, JSON.parse(data));
				if (event === null) throw new Error("The Brief stream returned an invalid response. Try again.");
				if (event.type === "failed") throw new Error(event.message);
				if (event.type === "finished") finished = true;
				if (event.type === "content") { text += event.text; onText(text); }
			} });
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			try {
				while (true) {
					const next = await reader.read();
					parser.feed(decoder.decode(next.value, { stream: !next.done }));
					if (next.done) break;
				}
			} finally { await reader.cancel(); reader.releaseLock(); }
			if (!finished) throw new Error("The Brief stream ended before it finished. Try again.");
		} catch (error) {
			if (!active.signal.aborted) setError(error instanceof Error ? error.message : "The Brief could not be written.");
		} finally {
			active.abort();
			controller.current = null;
			setPending(false);
		}
	};
	return { write, pending, error, stop: () => controller.current?.abort() };
}
