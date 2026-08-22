// Shared synthetic fixtures for the SillyTavern import tests. Raw parsed
// records are deliberately minimal; unknown fields exercise value-lossless
// archiving.

export const headerFixture = {
	chat_metadata: { integrity: "9543f21f-8aab-42c8-92a4-1f6453d4b63c" },
	user_name: "TANJS",
	character_name: "Rulership",
};

export const writerFixture = {
	name: "Writer",
	is_user: true,
	is_system: false,
	send_date: "2026-08-08T12:53:02.008Z",
	mes: "tanjs is a kinda new junior trainer",
	extra: { isSmallSys: false, reasoning: "" },
	future_field: { nested: [1, 2] },
};

export const rulershipFixture = {
	name: "Rulership",
	is_user: false,
	send_date: "2026-08-08T13:04:55.256Z",
	mes: "Rulership watches the track in silence.",
	title: "",
};

export const blankNameFixture = {
	name: "",
	is_user: true,
	send_date: "2026-08-08T13:10:00.000Z",
	mes: "🔥 Wait, truly?",
};

export const emptyContentFixture = {
	name: "Writer",
	is_user: true,
	send_date: "2026-08-08T13:20:00.000Z",
	mes: "",
};

export const jsonl = (records: unknown[]) =>
	records.map((record) => JSON.stringify(record)).join("\n");