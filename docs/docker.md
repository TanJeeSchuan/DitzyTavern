# Docker and GHCR

The image runs Bun 1.3.14 as the unprivileged `bun` user, serves the built frontend and API on port 3000, and stores the database and imported files under `/app/data`. Both `linux/amd64` and `linux/arm64` are built. No model runs inside this container; connection profiles point to your providers.

## Publishing from GitHub

The **Check** workflow runs the existing build and checks, then builds an AMD64 container and verifies its HTTP endpoint, frontend JavaScript, database migrations, data persistence across container replacement, and graceful shutdown. It builds both architectures afterward. Pull requests run these steps without uploading an image.

Successful pushes to `master` or tags beginning with `v` publish to:

```text
ghcr.io/tanjeeschuan/ditzytavern
```

| Tag | Published from |
| --- | --- |
| `latest` | A successful `master` push |
| `sha-<full-commit-sha>` | Every successful `master` or version-tag push |
| `v1.0.0`, for example | A push of that exact Git tag |

Version-tag builds do not move `latest`. Use a commit tag or image digest when you want a fixed version. Treat version tags as permanent.

No Actions secret needs to be added. The workflow uses `GITHUB_TOKEN` with `packages: write`; repository or organization policy must allow GitHub Actions and this permission. Merge these files into `master` to trigger the first publication, then inspect **Actions → Check → container**. A completed code-check job alone does not mean the image has been published.

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

Publishing an image does not deploy it. Pull the desired tag, stop the old container with a 10-second grace period, and recreate it with the same data volume and encryption key. Starting the new image migrates the database automatically. Back up before upgrading; returning to an older image does not undo database migrations.

Back up all of `/app/data` and the encryption key. Stop the container before copying the directory so SQLite, including any WAL files, and imported artifacts are consistent. Losing the key makes saved provider credentials unreadable. Deleting the data volume deletes your stories.

## Local image build

```sh
docker build -t ditzytavern:local .
```

Use `ditzytavern:local` in the reference run command to test before publishing. The Docker build context admits only build inputs; `.env`, local databases, tooling credentials, and generated files are excluded. The final image contains production dependencies, the built frontend, and server/shared source with database migrations.
