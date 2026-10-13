import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noBoxBoundaryImportsRule } from "./no-box-boundary-imports.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("no-box-boundary-imports", noBoxBoundaryImportsRule, {
	valid: [
		{ filename: "src/boxes/race/server.ts", code: 'import { raceSetup } from "./contract"; import { type Box } from "@/box-sdk/server"; import { imageHash } from "@/box-sdk/shared";' },
		{ filename: "src/boxes/race/server-engine.ts", code: 'import { boxReference } from "@/box-sdk/server.ts";' },
		{ filename: "src/boxes/race/client-window.tsx", code: 'import { Button } from "@/box-sdk/client"; import { imageHash } from "@/box-sdk/shared"; import { Flag } from "lucide-react";' },
		{ filename: "src/boxes/race/contract.ts", code: 'import { imageHash } from "@/box-sdk/shared"; import { Type } from "@sinclair/typebox";' },
		{ filename: "src/boxes/race/shared-descriptor.ts", code: 'import { describeSetup } from "@/box-sdk/shared"; import { raceSetup } from "./contract";' },
		{ filename: "src/boxes/race/shared-data.ts", code: 'import type { RaceSetup } from "./contract";' },
		{ filename: "src/boxes/race/server-cast.test.ts", code: 'import { openInitializedDatabase } from "../../server/database/database"; import { stripThoughts } from "../thought/shared";' },
		{ filename: "src/client/box-windows/registry.tsx", code: 'export { AuthorNotePanel } from "../../boxes/author-note/client";' },
		{ filename: "src/server/contract/box-window.test.ts", code: 'import { advanceRace } from "../../boxes/race/server-engine";' },
		{ filename: "scripts/seed-race-avatars.ts", code: 'import { raceRoster } from "../src/boxes/race/shared-data";' },
	],
	invalid: [
		{ filename: "src/boxes/phone/server.ts", code: 'import { raceBox } from "../race/server";', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/boxes/phone/client.tsx", code: 'import { Button } from "@/components/ui/button";', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/boxes/phone/server.ts", code: 'import { readMessageMoves } from "../../server/box/moves";', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/boxes/phone/server.ts", code: 'import { Button } from "@/box-sdk/client";', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/boxes/phone/client.tsx", code: 'import type { Box } from "@/box-sdk/server";', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/boxes/phone/shared.ts", code: 'import { boxReference } from "@/box-sdk/server";', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/boxes/race/contract.ts", code: 'import { Button } from "@/box-sdk/client";', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/boxes/race/server.ts", code: 'import { type Box } from "../../box-sdk/server";', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/boxes/race/server.ts", code: 'import { raceSetup } from "@/boxes/race/contract";', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/server/box/registry.ts", code: 'import raceBox from "../../boxes/race/server";', errors: [{ messageId: "coreImport" }] },
		{ filename: "src/shared/contract/box.ts", code: 'import { raceSetup } from "../../boxes/race/contract";', errors: [{ messageId: "coreImport" }] },
		{ filename: "src/boxes/race/server.ts", code: 'export { boxIds } from "../../shared/contract/box";', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/boxes/race/server.ts", code: 'export * from "../mood/shared";', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/boxes/race/client.tsx", code: 'const window = import("../phone/client");', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/server/generation-plan/compiler.ts", code: 'import { memoryItems } from "../../boxes/memory/server-prompt";', errors: [{ messageId: "coreImport" }] },
		{ filename: "src/client/workspace/PrimaryPanelView.tsx", code: 'import { AuthorNotePanel } from "@/boxes/author-note/client";', errors: [{ messageId: "coreImport" }] },
		{ filename: "src/box-sdk/server.ts", code: 'export { raceBox } from "../boxes/race/server";', errors: [{ messageId: "coreImport" }] },
		{ filename: "src/boxes/race/server.ts", code: 'import { stripPhoneTexts } from "@/boxes/race/../phone/shared";', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/server/app.ts", code: 'import { raceSetup } from "@/shared/../boxes/race/contract";', errors: [{ messageId: "coreImport" }] },
		{ filename: "src/boxes/race/server.ts", code: 'import { phoneBox } from "/home/tan/Projects/DitzyTavern/src/boxes/phone/server";', errors: [{ messageId: "boxImport" }] },
		{ filename: "src/server/app.ts", code: 'import { phoneBox } from "/home/tan/Projects/DitzyTavern/src/boxes/phone/server.ts";', errors: [{ messageId: "coreImport" }] },
		{ filename: "src/boxes/race/client.tsx", code: "const window = import(`../phone/client`);", errors: [{ messageId: "boxImport" }] },
	],
});
