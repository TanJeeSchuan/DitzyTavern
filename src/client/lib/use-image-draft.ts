import { useEffect, useState } from "react";
import { ImageDraft } from "./image";

export function useImageDraft(hashes: readonly string[]) {
	const [draft] = useState(() => new ImageDraft());
	useEffect(() => { draft.activate(); return () => draft.dispose(); }, [draft]);
	useEffect(() => draft.setHashes(hashes), [draft, hashes]);
	return draft;
}
