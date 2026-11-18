import { expect, test } from "bun:test";
import { requestDecisions } from ".";

test("Decision Model requests refuse credentialed redirects", async () => {
	let redirect: RequestRedirect | undefined;
	await requestDecisions({
		request: "{}", questions: { ping: { type: "noul", text: "Ready?" } },
		selection: { profileName: "Decision", model: "jev", stateTokenLimit: 16000, endpoint: "https://decision.test/systemone", credential: "secret", headers: {}, timeoutMs: 1000 },
		fetch: async (_input, init) => {
			redirect = init?.redirect;
			return Response.json({ answers: { ping: { type: "noul", noul: 0.9 } } });
		},
	});
	expect(redirect).toBe("error");
});
