export const renderMemoryClaim = (claim: { claim: string; attribution: string }): string =>
	`${claim.claim} (attribution: ${claim.attribution})`;
