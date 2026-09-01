// ==[HUMAN APPROVED]== Shared synthetic fixtures for the SillyTavern import tests. Raw parsed
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

// ==[HUMAN APPROVED]== A generated assistant record carrying Swipes. The row-level payload
// (`mes`, `extra`, `gen_started`, `gen_finished`) duplicates the saved
// alternative and must never be promoted by the projection; only `swipes`
// and the matching `swipe_info` entries feed the native Variants. The
// swipes include a deliberate duplicate text and a deliberate empty
// alternative; swipe 3 carries no `extra`, and swipe 2 records an empty
// reasoning with a null signature.
export const swipeRecordFixture = {
	name: "TANJS",
	is_user: false,
	is_system: false,
	send_date: "2026-08-08T13:04:55.256Z",
	mes: "Second alternative, still saved",
	title: "",
	force_avatar: "/thumbnail?type=avatar&file=TANJS1.png",
	original_avatar: "TANJS1.png",
	gen_started: "2026-08-08T13:04:52.000Z",
	gen_finished: "2026-08-08T13:04:54.000Z",
	extra: {
		api: "duplicate-api",
		model: "duplicate-model",
		gen_id: 999999,
		reasoning: "duplicate reasoning that must never be promoted",
		reasoning_signature: null,
		reasoning_duration: 1,
		reasoning_type: "model",
		time_to_first_token: 1,
	},
	swipes: [
		"First alternative text",
		"Second alternative, still saved",
		"Second alternative, still saved",
		"",
	],
	swipe_id: 1,
	swipe_info: [
		{
			send_date: "2026-08-08T13:04:50.000Z",
			gen_started: "2026-08-08T13:04:48.000Z",
			gen_finished: "2026-08-08T13:04:49.500Z",
			extra: {
				api: "custom",
				model: "deepseek-v4-flash",
				gen_id: 1786194665138,
				time_to_first_token: 1235,
				duration: 1500,
				finish_reason: "stop",
				reasoning_duration: 25407,
				reasoning_type: "model",
				reasoning: "reasoning for the first alternative",
				reasoning_signature: "signature-abc",
			},
		},
		{
			send_date: "2026-08-08T13:04:55.256Z",
			gen_started: "2026-08-08T13:04:52.000Z",
			gen_finished: "2026-08-08T13:04:54.000Z",
			extra: {
				api: "custom",
				model: "deepseek-v4-flash",
				gen_id: 1786194665138,
				time_to_first_token: 1256,
				reasoning_duration: 76921,
				reasoning_type: "model",
				reasoning: "reasoning for the saved alternative",
				reasoning_signature: null,
			},
		},
		{
			send_date: "2026-08-08T13:04:57.000Z",
			extra: {
				api: "custom",
				model: "deepseek-v4-flash",
				reasoning: "",
				reasoning_signature: null,
			},
		},
		{
			send_date: "2026-08-08T13:05:00.000Z",
		},
	],
};

// ==[HUMAN APPROVED]== A payload-only record carrying row-level generation provenance; the
// projection attaches it to the single selected Variant.
export const provenancedPayloadFixture = {
	name: "Writer",
	is_user: true,
	send_date: "2026-08-08T13:30:00.000Z",
	mes: "A payload-only message with row provenance",
	gen_started: "2026-08-08T13:29:58.000Z",
	gen_finished: "2026-08-08T13:30:00.000Z",
	extra: {
		api: "custom",
		model: "deepseek-v4-flash",
		gen_id: 1786194665138,
		time_to_first_token: 100,
		duration: 2000,
		finish_reason: "length",
		reasoning_duration: 500,
		reasoning_type: "model",
		reasoning: "row-level reasoning text",
		reasoning_signature: "signature-row",
	},
};

export const jsonl = (records: unknown[]) =>
	records.map((record) => JSON.stringify(record)).join("\n");
