// @approved
//  Infrastructure failure of the managed artifact store. Distinct from the
// nonfatal cleaned-up outcome: a store error means the deployment cannot
// place or read artifact bytes, whereas a missing or corrupt stored file is
// reported through the typed availability result.
export class ArtifactStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArtifactStoreError";
	}
}