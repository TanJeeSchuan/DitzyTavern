#!/usr/bin/env bash
set -euo pipefail
image="$1"
platform="$2"
build_number="$3"
revision="$4"
test "$(docker inspect -f '{{index .Config.Labels "io.ditzytavern.distribution"}}' "$image")" = official
test "$(docker inspect -f '{{index .Config.Labels "io.ditzytavern.build-number"}}' "$image")" = "$build_number"
test "$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$revision"
docker run --rm --platform "$platform" -e "EXPECTED_BUILD_NUMBER=$build_number" -e "EXPECTED_REVISION=$revision" "$image" bun -e '
  import { buildMetadata } from "./src/server/build-metadata.ts";
  if (buildMetadata.distribution !== "official" || buildMetadata.buildNumber !== Number(process.env.EXPECTED_BUILD_NUMBER) || buildMetadata.revision !== process.env.EXPECTED_REVISION) process.exit(1);
'
