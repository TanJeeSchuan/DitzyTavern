# Docker and GHCR

The image runs Bun 1.3.14 as the unprivileged `bun` user, serves the built frontend and API on port 3000, and stores the database and imported files under `/app/data`. Both `linux/amd64` and `linux/arm64` are built. No model runs inside this container; connection profiles point to your providers.

## Publishing from GitHub

The **Check** workflow runs the frontend build and ordinary checks for pull requests and master pushes. Only successful master pushes enter the `container` job. PRs do not build or publish Docker images, and Git version tags do not trigger this workflow.

Master publication builds an AMD64 container and verifies startup, frontend JavaScript, database migrations, persistence across replacement, and graceful shutdown. It verifies runtime build metadata and platform labels on both AMD64 and ARM64 before publishing the multi-architecture image to:

```text
ghcr.io/tanjeeschuan/ditzytavern
```

| Tag | Meaning |
| --- | --- |
| `build-142`, for example | Immutable image for Check workflow run number 142 |
| `latest` | Exact index digest of the greatest build whose promotion completed |

Pin `build-N` or its digest when you want a fixed artifact. SHA and version tags are no longer published. A new workflow run receives a new number, even at the same commit. Reruns retain their number and reuse an existing numbered digest without rebuilding. PRs and failed runs consume numbers, so gaps are normal.

The runtime identity is embedded at image build time in `src/server/build-metadata.json`. Official images identify `distribution=official`, their positive build number, and full source revision. Index annotations and platform labels use `io.ditzytavern.distribution`, `io.ditzytavern.build-number`, and `org.opencontainers.image.revision`. Ordinary source and local Docker builds identify as custom and do not check for updates. Metadata identifies the artifact; supplying official build arguments yourself does not prove its origin.

Keep the existing `.github/workflows/check.yml` workflow and its run-number sequence. Replacing its allocator with a new workflow requires an explicit numbering transition that preserves existing immutable identities and greater numeric ordering before publication. Never silently restart at build 1.

The `container` job owns one repository-wide publication concurrency group. Its active owner is not cancelled by newer runs, and there is no enclosing workflow cancellation. Numbered-tag lookup, first publication, and fresh `latest` comparison all happen inside that lock. Pending order is not assumed to be FIFO. Registry network/authentication failures fail the job; only explicit registry not-found responses allow creating a numbered tag. Older candidates leave `latest` alone. Equal numbers with different digests fail.

Numbered publication and `latest` promotion are separate operations. A failed or interrupted promotion reports failure and can leave an immutable `build-N` available while `latest` still points to an older build. Rerun the failed `container` job to reuse its numbered digest and repair promotion. If a greater build already reached `latest`, the rerun leaves it alone. Promotion copies the numbered index by digest without annotation changes and verifies exact digest equality afterward.

### First numbered rollout

The existing unnumbered `latest` cannot be compared to numbered builds. Before the first numbered promotion, an operator must explicitly retire that old alias through GHCR package administration so a registry lookup confirms it is absent. Inspect every tag attached to its package version before deleting that version; deleting a manifest/package version can remove other aliases to the same digest. Do not issue a raw manifest deletion assuming it deletes only `latest`. Preserve any old image needed for deployment or rollback separately before making this change.

This is a rollout prerequisite, not an automatic migration. Publication deliberately fails on unnumbered or malformed `latest` metadata. It may already have published `build-N` before detecting this condition; after the operator transition, rerun the failed job to promote that existing index. No live package changes are performed by the implementation.

No Actions secret needs to be added. The workflow uses `GITHUB_TOKEN` with `packages: write`; repository or organization policy must allow GitHub Actions and this permission. Inspect **Actions > Check > container** after a master push. A completed code-check job alone does not mean the image has been published.

GitHub creates the GHCR package on its first successful push. New packages are private by default. To allow unauthenticated pulls, open the package under your GitHub profile, choose **Package settings → Change visibility → Public**. Package visibility is separate from repository visibility. The image carries the repository source label so GitHub can associate the package with this repo.

For a private package, log Docker in with a personal access token that has `read:packages` and access to the package:

```sh
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

The server's pull token is separate from Actions' temporary publishing token. Never put either token in the Dockerfile or commit it.

## Runtime configuration

| Setting | Value |
| --- | --- |
| Image | `ghcr.io/tanjeeschuan/ditzytavern:latest` |
| Container port | `3000` |
| Persistent volume | `/app/data` |
| Required environment | `CONNECTION_SECRET_KEY`, exactly 32 random bytes encoded as Base64 |
| Listening address | `HOST=0.0.0.0`, already set in the image |
| Health endpoint | `/api/health`, also used by the image's health check |
| Shutdown grace period | At least 10 seconds |

Supply the encryption key at runtime and preserve it across updates. For an existing installation, use its current `CONNECTION_SECRET_KEY` and migrate its whole `data/` directory while the old process is stopped. For a new installation, generate a key once, store it securely, and reuse it:

```sh
umask 077
printf 'CONNECTION_SECRET_KEY=%s\n' "$(openssl rand -base64 32)" > ditzytavern.env
```

The image expects the key to be injected; its application directory is not writable by the runtime user, so it cannot bootstrap a new `.env` there. The persistent data directory is writable. A named volume takes the image directory's ownership on first use; a bind mount must be writable by the image's `bun` user, UID/GID 1000.

This is a reference command for your own deployment. It publishes only on host loopback:

```sh
docker run -d --name ditzytavern --restart unless-stopped \
  --env-file ditzytavern.env \
  --mount type=volume,source=ditzytavern-data,target=/app/data \
  -p 127.0.0.1:3000:3000 \
  ghcr.io/tanjeeschuan/ditzytavern:latest
```

The app has no login or user isolation. Restrict access through your network or an authenticated proxy. A proxy must pass through `/api` and support unbuffered server-sent events for streaming replies. Docker's `EXPOSE` declaration does not publish a host port by itself.

Provider URLs are resolved from inside the container. `127.0.0.1` in a connection profile means this container, so use the reachable address of your model service.

## Updates and backups

Settings only reports update availability and links here. DitzyTavern does not pull images or restart itself. Pull the desired `build-N` tag or `latest`, stop the old container with a 10-second grace period, remove that stopped container, and recreate it using the reference run command with the same data volume, port mapping, and encryption key. Starting the new image migrates the database automatically. Back up before upgrading; returning to an older image does not undo database migrations.

Back up all of `/app/data` and the encryption key. Stop the container before copying the directory so SQLite, including any WAL files, and imported artifacts are consistent. Losing the key makes saved provider credentials unreadable. Deleting the data volume deletes your stories.

## Local image build

```sh
docker build -t ditzytavern:local .
```

Use `ditzytavern:local` in the reference run command to test before publishing. The Docker build context admits only build inputs; `.env`, local databases, tooling credentials, and generated files are excluded. The final image contains production dependencies, the built frontend, and server/shared source with database migrations.
