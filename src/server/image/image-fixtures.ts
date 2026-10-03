import { crc32, deflateSync } from "node:zlib";

const concat = (...parts: Uint8Array[]) => Buffer.concat(parts);
const ascii = (text: string) => Buffer.from(text, "latin1");
const u16be = (value: number) => Buffer.from([value >> 8, value & 0xff]);
const u32be = (value: number) => Buffer.from([value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
const u16le = (value: number) => Buffer.from([value & 0xff, value >> 8]);
const u32le = (value: number) => Buffer.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24]);

const pngChunk = (type: string, data: Uint8Array) => {
	const body = concat(ascii(type), data);
	return concat(u32be(data.byteLength), body, u32be(crc32(body)));
};

export const pngFixture = (options: { card?: string; width?: number; height?: number } = {}) => {
	const { width = 3, height = 2 } = options;
	const rows = Buffer.alloc(height * (1 + width * 3), 0x7f);
	for (let row = 0; row < height; row += 1) rows[row * (1 + width * 3)] = 0;
	return concat(
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", concat(u32be(width), u32be(height), Buffer.from([8, 2, 0, 0, 0]))),
		options.card === undefined ? Buffer.alloc(0) : pngChunk("tEXt", ascii(`chara\0${options.card}`)),
		pngChunk("IDAT", deflateSync(rows)),
		pngChunk("IEND", Buffer.alloc(0)),
	);
};

const jpegSegment = (marker: number, data: Uint8Array) => concat(Buffer.from([0xff, marker]), u16be(data.byteLength + 2), data);

export const jpegFixture = (options: { gps?: boolean; width?: number; height?: number } = {}) => {
	const { width = 5, height = 4 } = options;
	const exif = concat(ascii("Exif\0\0"), ascii("II*\0GPS-LATITUDE-48.8584N GPS-LONGITUDE-2.2945E"));
	return concat(
		Buffer.from([0xff, 0xd8]),
		jpegSegment(0xe0, concat(ascii("JFIF\0"), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0]))),
		options.gps ? jpegSegment(0xe1, exif) : Buffer.alloc(0),
		jpegSegment(0xc0, concat(Buffer.from([8]), u16be(height), u16be(width), Buffer.from([1, 1, 0x11, 0]))),
		jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
		Buffer.from([0x12, 0x34, 0x56, 0x78, 0xff, 0xd9]),
	);
};

const riffChunk = (type: string, data: Uint8Array) =>
	concat(ascii(type), u32le(data.byteLength), data, data.byteLength % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0));

export const webpFixture = (options: { xmp?: boolean; width?: number; height?: number } = {}) => {
	const { width = 6, height = 4 } = options;
	const vp8x = Buffer.concat([
		Buffer.from([options.xmp ? 0x04 : 0, 0, 0, 0]),
		u32le(width - 1).subarray(0, 3),
		u32le(height - 1).subarray(0, 3),
	]);
	const pixels = Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x11, 0x22, 0x33]);
	const body = concat(
		ascii("WEBP"),
		riffChunk("VP8X", vp8x),
		riffChunk("VP8L", pixels),
		options.xmp ? riffChunk("XMP ", ascii("<x:xmpmeta>GPS 48.8584N</x:xmpmeta>")) : Buffer.alloc(0),
	);
	return concat(ascii("RIFF"), u32le(body.byteLength), body);
};

export const gifFixture = (options: { comment?: string } = {}) => {
	const frame = (delay: number, color: number) =>
		concat(
			Buffer.from([0x21, 0xf9, 4, 0]), u16le(delay), Buffer.from([0, 0]),
			Buffer.from([0x2c]), u16le(0), u16le(0), u16le(2), u16le(2), Buffer.from([0]),
			Buffer.from([2, 2, 0x44, color, 0]),
		);
	return concat(
		ascii("GIF89a"), u16le(2), u16le(2), Buffer.from([0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255]),
		Buffer.from([0x21, 0xff, 11]), ascii("NETSCAPE2.0"), Buffer.from([3, 1, 0, 0, 0]),
		options.comment === undefined ? Buffer.alloc(0) : concat(Buffer.from([0x21, 0xfe, options.comment.length]), ascii(options.comment), Buffer.from([0])),
		frame(10, 0x01),
		frame(20, 0x02),
		Buffer.from([0x3b]),
	);
};

export const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
