import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

/**
 * Playable media for the Stage F browser tests — **test infrastructure only.**
 *
 * The HTTP fixture's files are a few bytes of text under a media content type:
 * enough to prove what a route answers, useless for proving that a player
 * seeks. These are real, small and deterministic, in formats the bundled
 * Chromium plays without proprietary codecs.
 *
 * - **PNG** and **WAV** are written here, byte by byte, because both are simple
 *   enough to need nothing else.
 * - **M4A** is one committed fixture, `tests/fixtures/six-seconds.m4a`: an
 *   MPEG-4 container (`ftyp isom`), 6.14 s of a quiet tone, recorded once by
 *   Chromium's `MediaRecorder`. Its audio is Opus rather than a phone's AAC,
 *   because the bundled Chromium has no AAC decoder; the container, the
 *   extension and the declared type are exactly a phone recording's.
 * - **WebM** is one committed fixture, `tests/fixtures/eight-seconds.webm`:
 *   8.00 s of VP8 at 320×180, four frames a second with a keyframe every
 *   second, each frame showing its own time. Rendered once in Chromium and
 *   encoded with Playwright's bundled ffmpeg; nothing at run time needs an
 *   encoder.
 */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A greyscale PNG of exactly `width` × `height`, a diagonal ramp so that a
 * marker is visibly somewhere on it in a screenshot.
 */
export function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = 0; // no filter
    for (let x = 0; x < width; x++) {
      rows[y * (width + 1) + 1 + x] = Math.round((255 * (x / width + y / height)) / 2);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** `seconds` of a quiet 440 Hz tone: 8 kHz, mono, 16-bit PCM. */
export function wav(seconds: number): Buffer {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(2000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8, "ascii");
  head.write("fmt ", 12, "ascii");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii");
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** Six seconds of MPEG-4 audio — see above. */
export function m4a(): Buffer {
  return readFileSync(new URL("../fixtures/six-seconds.m4a", import.meta.url));
}

/** Eight seconds of VP8 — see above. */
export function webm(): Buffer {
  return readFileSync(new URL("../fixtures/eight-seconds.webm", import.meta.url));
}
