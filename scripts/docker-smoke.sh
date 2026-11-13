#!/usr/bin/env bash
set -euo pipefail
# Per-run names, so cleanup never reaches a deployment's `ditzytavern` container or a concurrent run.
name="ditzytavern-smoke-$(openssl rand -hex 4)"
trap 'docker logs "$name" || true; docker rm -f "$name" || true; docker volume rm "$name" || true' EXIT
test_key="$(openssl rand -base64 32)"
echo "::add-mask::$test_key"
docker run -d --name "$name" -p 127.0.0.1:3000:3000 \
  -e "CONNECTION_SECRET_KEY=$test_key" -v "$name:/app/data" ditzytavern:ci
wait_for_server() {
  for attempt in {1..30}; do
    if curl -fsS http://127.0.0.1:3000/api/health; then return; fi
    sleep 1
  done
  return 1
}
wait_for_server
docker exec "$name" bun -e '
  const html = await (await fetch("http://127.0.0.1:3000/")).text();
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  if (!asset || !(await fetch(new URL(asset, "http://127.0.0.1:3000"))).ok) process.exit(1);
'
curl -fsS http://127.0.0.1:3000/api/workspace
docker exec "$name" bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database("data/ditzytavern.sqlite");
  db.exec("CREATE TABLE container_probe (value TEXT)");
  db.query("INSERT INTO container_probe VALUES (?)").run("persisted");
  db.close();
'
docker stop --timeout 10 "$name"
docker inspect -f 'Shutdown exit code: {{.State.ExitCode}}' "$name"
test "$(docker inspect -f '{{.State.ExitCode}}' "$name")" = 0
docker rm "$name"
docker run -d --name "$name" -p 127.0.0.1:3000:3000 \
  -e "CONNECTION_SECRET_KEY=$test_key" -v "$name:/app/data" ditzytavern:ci
wait_for_server
docker exec "$name" bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database("data/ditzytavern.sqlite");
  if (db.query("SELECT value FROM container_probe").get()?.value !== "persisted") process.exit(1);
  if (db.query("PRAGMA quick_check").get()?.quick_check !== "ok") process.exit(1);
  db.close();
'
