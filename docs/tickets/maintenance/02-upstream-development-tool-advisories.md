# Update development tools when upstream security fixes are available

Status: BLOCKED

## Evidence

After the dependency refresh on 2026-10-15, `bun audit` reports two remaining development-tool advisories:

- `shadcn@4.21.5` → `fast-glob` → `micromatch` → `braces@3.0.3`: [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), high severity. `bun audit fix --dry-run` reports no published fixed version.
- `drizzle-kit@0.31.11` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils@3.3.2` → `esbuild@0.18.20`: [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), moderate severity. The parent requires `esbuild@~0.18.20`, excluding the fixed versions.

Both root tools are development dependencies. A clean `bun install --frozen-lockfile --production` excludes `shadcn`, `drizzle-kit`, and `braces`. The application builds its CSS before assembling the production image.

## Work

- [ ] Check for a published `braces` fix and a stable Drizzle Kit release that removes the old esbuild dependency.
- [ ] Update through supported dependency ranges, without overrides or compatibility patches.
- [ ] Run `bun audit`, `bun run check`, `bun run test:publication`, and `bun run test:e2e`.
- [ ] Close this ticket once both advisories are absent.
