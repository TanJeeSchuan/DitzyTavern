import { describe, expect, test } from "bun:test";
import {
	formatProviderError,
	snapshotProviderError,
	snapshotProviderResponse,
} from "./provider-errors";

/**
 * Wraps a Response so every body-consuming method is recorded and rejects. The
 * provider error path must decide from headers alone; buffering the untrusted
 * body is the regression this suite guards against.
 */
function responseTrackingBodyReads(body: BodyInit, init: ResponseInit) {
	const response = new Response(body, init);
	const bodyReads: string[] = [];
	for (const method of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"]) {
		Object.defineProperty(response, method, {
			value: () => {
				bodyReads.push(method);
				return Promise.reject(new Error(`provider error path consumed the body via ${method}()`));
			},
		});
	}
	return { response, bodyReads };
}

describe("snapshotProviderResponse", () => {
	test("never buffers the provider error body and omits the size without Content-Length", async () => {
		const { response, bodyReads } = responseTrackingBodyReads("secret provider body", {
			status: 503,
			headers: { "content-type": "application/json" },
		});

		const snapshot = await snapshotProviderResponse(response);

		expect(bodyReads).toEqual([]);
		expect(snapshot.status).toBe(503);
		expect(snapshot.contentType).toBe("application/json");
		expect(snapshot.bodyBytes).toBe(0);
		expect(formatProviderError(snapshot)).toBe("The provider request failed with HTTP 503.");
	});

	test("uses Content-Length as the body size without reading the body", async () => {
		const { response, bodyReads } = responseTrackingBodyReads("secret provider body", {
			status: 429,
			headers: { "content-type": "application/json", "content-length": "4096" },
		});

		const snapshot = await snapshotProviderResponse(response);

		expect(bodyReads).toEqual([]);
		expect(snapshot.bodyBytes).toBe(4096);
		expect(formatProviderError(snapshot)).toBe(
			"The provider request failed with HTTP 429 (4096-byte response body).",
		);
	});

	test("treats an unparsable Content-Length as absent", async () => {
		const { response, bodyReads } = responseTrackingBodyReads("secret provider body", {
			status: 502,
			headers: { "content-length": "not-a-number" },
		});

		const snapshot = await snapshotProviderResponse(response);

		expect(bodyReads).toEqual([]);
		expect(snapshot.bodyBytes).toBe(0);
		expect(formatProviderError(snapshot)).toBe("The provider request failed with HTTP 502.");
	});

	test("reports binary responses from headers alone", async () => {
		const sized = responseTrackingBodyReads(new Uint8Array([1, 2, 3, 4]), {
			status: 500,
			headers: { "content-type": "application/octet-stream", "content-length": "4" },
		});
		expect(formatProviderError(await snapshotProviderResponse(sized.response))).toBe(
			"The provider returned HTTP 500 with a binary response body (4 bytes).",
		);
		expect(sized.bodyReads).toEqual([]);

		const unsized = responseTrackingBodyReads(new Uint8Array([1, 2, 3, 4]), {
			status: 500,
			headers: { "content-type": "application/octet-stream" },
		});
		expect(formatProviderError(await snapshotProviderResponse(unsized.response))).toBe(
			"The provider returned HTTP 500 with a binary response body.",
		);
		expect(unsized.bodyReads).toEqual([]);
	});
});

describe("snapshotProviderError", () => {
	test("summarizes an already-buffered provider error without touching any Response", () => {
		const snapshot = snapshotProviderError({
			name: "APICallError",
			message: "provider rejected the request",
			statusCode: 401,
			responseHeaders: { "Content-Type": "application/json" },
			responseBody: "abcd",
		});

		expect(snapshot.status).toBe(401);
		expect(snapshot.contentType).toBe("application/json");
		expect(snapshot.body).toBe("abcd");
		expect(snapshot.bodyBytes).toBe(4);
		expect(formatProviderError(snapshot)).toBe(
			"The provider request failed with HTTP 401 (4-byte response body).",
		);
	});
});
