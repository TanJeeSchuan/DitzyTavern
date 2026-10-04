import { createHash } from "node:crypto";
import { transformExif } from "@uwx/exif-be-gone-web";
import { MAX_IMAGE_BYTES } from "../../shared/contract/image";
import { InvalidImageError } from "./errors";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface IngestedImage {
	hash: string;
	bytes: Buffer;
	mediaType: ImageMediaType;
	width: number;
	height: number;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
	signature.every((byte, index) => bytes[offset + index] === byte);

const sniff = (bytes: Uint8Array): ImageMediaType | undefined => {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
	if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
	return undefined;
};

type Size = { width: number; height: number };

const jpegSize = (view: DataView): Size | undefined => {
	let offset = 2;
	while (offset + 9 <= view.byteLength) {
		if (view.getUint8(offset) !== 0xff) return undefined;
		const marker = view.getUint8(offset + 1);
		if (marker === 0xff) {
			offset += 1;
			continue;
		}
		const isFrameHeader = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isFrameHeader) return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
		offset += 2 + view.getUint16(offset + 2);
	}
	return undefined;
};

const webpSize = (view: DataView): Size | undefined => {
	if (view.byteLength < 30) return undefined;
	const chunk = String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15));
	if (chunk === "VP8 ") return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
	if (chunk === "VP8L") {
		const bits = view.getUint32(21, true);
		return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
	}
	if (chunk === "VP8X") {
		const read24 = (offset: number) => view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
		return { width: read24(24) + 1, height: read24(27) + 1 };
	}
	return undefined;
};

const readSize = (bytes: Uint8Array, mediaType: ImageMediaType): Size | undefined => {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (mediaType === "image/png") return view.byteLength < 24 ? undefined : { width: view.getUint32(16), height: view.getUint32(20) };
	if (mediaType === "image/gif") return view.byteLength < 10 ? undefined : { width: view.getUint16(6, true), height: view.getUint16(8, true) };
	return mediaType === "image/jpeg" ? jpegSize(view) : webpSize(view);
};

export const ingestImage = async (original: Uint8Array): Promise<IngestedImage> => {
	if (original.byteLength > MAX_IMAGE_BYTES) {
		throw new InvalidImageError("too-large", "Images may be at most 20 MB.");
	}
	const mediaType = sniff(original);
	if (mediaType === undefined) {
		throw new InvalidImageError("unsupported-type", "Only PNG, JPEG, WebP, and GIF images are accepted.");
	}
	const stripped = await transformExif(original).catch(() => {
		throw new InvalidImageError("malformed", "The image could not be read.");
	});
	const size = readSize(stripped, mediaType);
	if (size === undefined || size.width < 1 || size.height < 1) {
		throw new InvalidImageError("malformed", "The image dimensions could not be read.");
	}
	const bytes = Buffer.from(stripped);
	return { hash: createHash("sha256").update(bytes).digest("hex"), bytes, mediaType, ...size };
};

export const ingestUploads = async (uploads: readonly string[] | undefined): Promise<Map<string, IngestedImage>> => {
	const pool = new Map<string, IngestedImage>();
	for (const upload of uploads ?? []) {
		const image = await ingestImage(Buffer.from(upload, "base64"));
		pool.set(image.hash, image);
	}
	return pool;
};
