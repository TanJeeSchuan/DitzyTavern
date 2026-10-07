import { Type } from "@sinclair/typebox";

export const registryPullToken = Type.Object({ token: Type.String({ minLength: 1 }) });
export const publishedBuildIndex = Type.Object({
	schemaVersion: Type.Literal(2),
	mediaType: Type.Union([Type.Literal("application/vnd.oci.image.index.v1+json"), Type.Literal("application/vnd.docker.distribution.manifest.list.v2+json")]),
	annotations: Type.Object({
		"io.ditzytavern.distribution": Type.Literal("official"),
		"io.ditzytavern.build-number": Type.String({ pattern: "^[1-9]\\d*$" }),
		"org.opencontainers.image.revision": Type.String({ pattern: "^[a-f0-9]{40}$" }),
	}),
});
