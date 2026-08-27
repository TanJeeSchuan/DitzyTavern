// Ephemeral audit: how big is the conversations `commands`/`GET` response
// compared to the tiny command that produced it? Run with:
//   bun .scratch/audit-transport-sizes.ts
import { openDatabase } from "../src/server/database/database";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createConversationRoutes } from "../src/shared/contract";
import { chatTable } from "../src/server/database/schema";

const sampleCommand = `{"expectedRevision":15,"action":{"type":"assign-control","seat":"model","participantId":17}}`;

const database = openDatabase();
const app = createConversationRoutes(database);
const db = drizzle(database);
const rows = db.select({ id: chatTable.id, name: chatTable.name }).from(chatTable).orderBy(chatTable.id).all();

console.log(`command body: ${sampleCommand.length} bytes`);
console.log("");
console.log("conversation | response bytes (GET)");
for (const row of rows) {
	const response = await app.handle(new Request(`http://localhost/api/conversations/${row.id}`));
	const text = await response.text();
	console.log(`#${row.id} ${row.name.slice(0, 30).padEnd(30)} | ${String(Buffer.byteLength(text, "utf8")).padStart(9)} bytes`);
}

const largest = rows.at(-1);
if (largest !== undefined) {
	const response = await app.handle(new Request(`http://localhost/api/conversations/${largest.id}`));
	const getBytes = Buffer.byteLength(await response.text(), "utf8");
	console.log("");
	console.log(`Largest Chat #${largest.id}: GET /:id = ${getBytes} bytes for a ${sampleCommand.length}-byte command (${(getBytes / sampleCommand.length).toFixed(0)}x)`);
}

database.close();