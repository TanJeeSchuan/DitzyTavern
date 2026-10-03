import { transformExif } from "@uwx/exif-be-gone-web";

export interface PreparedImage {
	hash: string;
	data: string;
}

const localUrls = new Map<string, string>();

export const imageSrc = (hash: string) => localUrls.get(hash) ?? `/api/images/${hash}`;

const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const toBase64 = (bytes: Uint8Array) => {
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
};

export const prepareImage = async (file: File): Promise<PreparedImage> => {
	const original = new Uint8Array(await file.arrayBuffer());
	const hash = toHex(await crypto.subtle.digest("SHA-256", new Uint8Array(await transformExif(original))));
	if (!localUrls.has(hash)) localUrls.set(hash, URL.createObjectURL(file));
	return { hash, data: toBase64(original) };
};
