import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { testLorebookMatch } from "../lorebook-library";

export function useLoreMatchTester() {
	const client = useQueryClient();
	const [writing, setWriting] = useState("");
	const [submitted, setSubmitted] = useState<{ bookId: number; writing: string } | null>(null);
	const query = useQuery({
		queryKey: ["lorebook-match", submitted?.bookId, writing],
		queryFn: ({ signal }) => testLorebookMatch(submitted!.bookId, writing, signal),
		enabled: submitted !== null && submitted.writing === writing,
		staleTime: Infinity,
	});
	return {
		testWriting: writing, testResult: query.data ?? null, testError: query.error?.message ?? null,
		testPending: query.isFetching,
		reset: () => { void client.cancelQueries({ queryKey: ["lorebook-match"] }); setSubmitted(null); },
		setTestWriting: (value: string) => { void client.cancelQueries({ queryKey: ["lorebook-match"] }); setSubmitted(null); setWriting(value); },
		runMatchTest: (bookId: number) => { void client.invalidateQueries({ queryKey: ["lorebook-match", bookId, writing] }); setSubmitted({ bookId, writing }); },
	};
}

export type LoreMatchTesterController = ReturnType<typeof useLoreMatchTester>;
