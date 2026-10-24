import { engines, packageManager } from "../package.json";

const [task, ...args] = process.argv.slice(2);
if (task !== "check" && task !== "e2e") throw new Error("Expected check or e2e.");

const commands = {
	check: "bun run lint && bun run lint:rules && bun run check:contracts && bun run typecheck && bun run typecheck:tools && bun run test && bun run test:e2e:harness",
	e2e: "bunx --no-install playwright test",
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = [commands[task], ...args.map(quote)].join(" ");
const bunVersion = packageManager.slice("bun@".length);
const nodeVersion = engines.node;
const image = "docker://gcr.io/flame-public/rbe-ubuntu24-04" +
	"@sha256:f7db0d4791247f032fdb4451b7c3ba90e567923a341cc6dc43abfc283436791a";

const script = `set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
if [[ ! -x "$HOME/.local/bin/node" ]] || [[ "$(node --version)" != "v${nodeVersion}" ]]; then
  mkdir -p "$HOME/.local"
  curl -fsSL https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-x64.tar.xz | tar -xJ --strip-components=1 -C "$HOME/.local"
fi
if [[ ! -x "$HOME/.bun/bin/bun" ]] || [[ "$(bun --version)" != "${bunVersion}" ]]; then
  curl -fsSL https://bun.com/install | bash -s -- bun-v${bunVersion}
fi
bun install --frozen-lockfile
${task === "check" ? "bun run build\n" : `bunx --no-install playwright install --with-deps chromium
trap 'if [[ -d .scratch/e2e-report ]]; then tar -czf "$BUILDBUDDY_ARTIFACTS_DIRECTORY/playwright-report.tar.gz" -C .scratch e2e-report; fi' EXIT
`}${command}`;

const remote = !process.env.LOCAL && Bun.spawnSync(["git", "config", "--get", "buildbuddy.api-key"]).exitCode === 0;
const child = Bun.spawn(remote ? [
	"bb", "remote",
	"--os=linux", "--arch=amd64",
	`--container_image=${image}`,
	"--runner_exec_properties=EstimatedCPU=4",
	"--runner_exec_properties=EstimatedMemory=16GB",
	"--timeout=30m",
	`--script=${script}`,
] : ["bun", "exec", command], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
