import { transformExif } from "@uwx/exif-be-gone-web";
import { MAX_IMAGE_BYTES } from "../../shared/contract/image";

export interface PreparedImage {
	hash: string;
	data: string;
}

export const imageAccept = "image/png,image/jpeg,image/webp,image/gif";

const localUrls = new Map<string, string>();
export const missingImages = new Set<string>();
const pendingBytes = new Map<string, string>();

export const imageSrc = (hash: string) => localUrls.get(hash) ?? `/api/images/${hash}`;

const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const toBase64 = (bytes: Uint8Array) => {
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
};

export const prepareImage = async (file: File): Promise<PreparedImage> => {
	if (file.size > MAX_IMAGE_BYTES) throw new Error("Images may be at most 20 MB.");
	const original = new Uint8Array(await file.arrayBuffer());
	const hash = toHex(await crypto.subtle.digest("SHA-256", new Uint8Array(await transformExif(original))));
	const data = toBase64(original);
	if (!localUrls.has(hash)) localUrls.set(hash, URL.createObjectURL(file));
	pendingBytes.set(hash, data);
	missingImages.delete(hash);
	return { hash, data };
};

const hashesIn = (payloadJson: string) => new Set(payloadJson.match(/[0-9a-f]{64}/g) ?? []);

export const withInlineImages = async <Result extends { error: unknown }>(
	payloadJson: string,
	send: (images: string[] | undefined) => Promise<Result>,
): Promise<Result> => {
	const hashes = [...hashesIn(payloadJson)].filter((hash) => pendingBytes.has(hash));
	const images = hashes.map((hash) => pendingBytes.get(hash)!);
	const result = await send(images.length === 0 ? undefined : images);
	if (!result.error) for (const hash of hashes) pendingBytes.delete(hash);
	return result;
};
