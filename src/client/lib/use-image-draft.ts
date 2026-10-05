import { useEffect, useState } from "react";
import { ImageDraft } from "./image";

export function useImageDraft(hashes: readonly string[], retainBeforeRemoval = true) {
	const [draft] = useState(() => new ImageDraft(retainBeforeRemoval));
	useEffect(() => { draft.activate(); return () => draft.dispose(); }, [draft]);
	useEffect(() => draft.setHashes(hashes), [draft, hashes]);
	return draft;
}
