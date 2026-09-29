import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * An S3-compatible object store, in this process, for tests.
 *
 * It exists because the alternative is a mock of our own adapter, which would
 * test that the mock agrees with itself. This speaks real HTTP, so the real AWS
 * SDK builds the real requests, the real presigner produces real URLs, and the
 * real verbs arrive: PUT, GET, HEAD, DELETE, CopyObject and the three multipart
 * calls.
 *
 * **What it does not do is verify SigV4.** It accepts any signature, so these
 * tests prove the flow and the authorization that surrounds it, and prove
 * nothing about whether a signed URL would satisfy a real provider. Only the
 * beta bucket can answer that, and the report says so rather than implying
 * otherwise.
 *
 * **It does honour a presigned URL's lifetime (F6.1)**, because a signed view
 * URL expiring mid-session is exactly what Stage F6 recovers from. A request
 * carrying `X-Amz-Date` and `X-Amz-Expires` after that moment is refused with
 * 403 and S3's own *Request has expired*, measured against `now()` — the real
 * clock unless a test moves it. Requests the SDK signs with an `Authorization`
 * header carry neither, and are unaffected.
 */

type StoredObject = { body: Buffer; contentType: string; etag: string };

export class S3Stub {
  readonly objects = new Map<string, StoredObject>();
  private readonly uploads = new Map<string, Map<number, Buffer>>();
  private server: Server | null = null;
  private port = 0;

  /** Every request this stub saw, so a test can assert what was never asked. */
  readonly seen: { method: string; key: string }[] = [];

  /** The stub's clock, in milliseconds. A test moves it to expire a URL at once. */
  now: () => number = () => Date.now();

  /**
   * F6.2: every presigned URL dated in a whole second before this instant has
   * run out of time, whatever its `X-Amz-Expires` says — its lifetime passed,
   * as far as this bucket is concerned. Unlike moving `now`, it leaves a URL
   * signed afterwards valid, which is what a recovery needs to prove.
   */
  expiredBefore = 0;

  /** Keys containing any of these answer every GET with 500: a fault that persists. */
  readonly failing = new Set<string>();

  /**
   * Keys containing any of these send their first `TRUNCATE_AT` bytes and then
   * drop the connection, and every later range is dropped before a byte: a
   * network failure **after data arrived but before the player could read its
   * metadata** — the one case that is a network error yet never loaded.
   */
  readonly truncating = new Set<string>();

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://stub");
      if (url.pathname.startsWith("/__control/")) return void this.control(url, response);
      // Path style: /{bucket}/{key...}
      const key = decodeURIComponent(url.pathname.replace(/^\/[^/]+\//, ""));
      const method = request.method ?? "GET";
      this.seen.push({ method, key });

      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        try {
          this.handle(method, key, url, Buffer.concat(chunks), request.headers, response);
        } catch {
          response.writeHead(500).end();
        }
      });
    });

    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server!.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }

  /**
   * Test controls, over HTTP, for a stub running in another process — the one
   * a local server is pointed at. Test infrastructure only: this stub is never
   * anywhere but a test run.
   *
   * - `/__control/expire`: every URL signed so far has expired.
   * - `/__control/fail?key=…`: GETs for keys containing that fail with 500.
   * - `/__control/truncate?key=…`: GETs for those keys break off early.
   * - `/__control/reset`: none of these.
   */
  private control(url: URL, response: import("node:http").ServerResponse): void {
    const action = url.pathname.slice("/__control/".length);
    if (action === "expire") this.expiredBefore = Date.now();
    else if (action === "fail" && url.searchParams.get("key")) this.failing.add(url.searchParams.get("key")!);
    else if (action === "truncate" && url.searchParams.get("key")) this.truncating.add(url.searchParams.get("key")!);
    else if (action === "reset") {
      this.expiredBefore = 0;
      this.failing.clear();
      this.truncating.clear();
    } else return void response.writeHead(404).end();
    response.writeHead(204).end();
  }

  /** Puts bytes there without going through the API, to set a test up. */
  place(key: string, body: Buffer | string, contentType = "application/octet-stream"): void {
    const buffer = typeof body === "string" ? Buffer.from(body) : body;
    this.objects.set(key, { body: buffer, contentType, etag: md5(buffer) });
  }

  private handle(
    method: string,
    key: string,
    url: URL,
    body: Buffer,
    headers: Record<string, string | string[] | undefined>,
    response: import("node:http").ServerResponse,
  ): void {
    if (presignedExpired(url, this.now()) || signedBefore(url, this.expiredBefore)) {
      response
        .writeHead(403, { "content-type": "application/xml" })
        .end('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>');
      return;
    }

    const uploadId = url.searchParams.get("uploadId");
    const partNumber = url.searchParams.get("partNumber");

    if (method === "POST" && url.searchParams.has("uploads")) {
      const id = randomUUID();
      this.uploads.set(id, new Map());
      response
        .writeHead(200, { "content-type": "application/xml" })
        .end(
          `<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      return;
    }

    if (method === "PUT" && uploadId && partNumber) {
      const parts = this.uploads.get(uploadId);
      if (!parts) return void response.writeHead(404).end();
      parts.set(Number(partNumber), body);
      response.writeHead(200, { etag: `"${md5(body)}"` }).end();
      return;
    }

    if (method === "POST" && uploadId) {
      const parts = this.uploads.get(uploadId);
      if (!parts) return void response.writeHead(404).end();
      const assembled = Buffer.concat(
        [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part),
      );
      // A multipart ETag is not an MD5 of the content. Shaped like the
      // convention, because the application must treat it as opaque either way.
      const etag = `${md5(Buffer.concat([...parts.values()].map((p) => Buffer.from(md5(p), "hex"))))}-${parts.size}`;
      this.objects.set(key, { body: assembled, contentType: "application/octet-stream", etag });
      this.uploads.delete(uploadId);
      response
        .writeHead(200, { "content-type": "application/xml" })
        .end(`<?xml version="1.0"?><CompleteMultipartUploadResult><ETag>"${etag}"</ETag></CompleteMultipartUploadResult>`);
      return;
    }

    const copySource = headers["x-amz-copy-source"];
    if (method === "PUT" && typeof copySource === "string") {
      const from = decodeURIComponent(copySource.replace(/^\/?[^/]+\//, ""));
      const source = this.objects.get(from);
      if (!source) return void response.writeHead(404).end();
      this.objects.set(key, { ...source });
      response
        .writeHead(200, { "content-type": "application/xml" })
        .end(`<?xml version="1.0"?><CopyObjectResult><ETag>"${source.etag}"</ETag></CopyObjectResult>`);
      return;
    }

    if (method === "PUT") {
      const contentType = String(headers["content-type"] ?? "application/octet-stream");
      this.objects.set(key, { body, contentType, etag: md5(body) });
      response.writeHead(200, { etag: `"${md5(body)}"` }).end();
      return;
    }

    if (method === "HEAD") {
      const object = this.objects.get(key);
      if (!object) return void response.writeHead(404).end();
      response
        .writeHead(200, {
          "content-length": String(object.body.length),
          etag: `"${object.etag}"`,
          "content-type": object.contentType,
        })
        .end();
      return;
    }

    if (method === "GET" && [...this.failing].some((part) => key.includes(part))) {
      return void response.writeHead(500).end();
    }

    if (method === "GET" && [...this.truncating].some((part) => key.includes(part))) {
      const object = this.objects.get(key);
      if (!object) return void response.writeHead(404).end();
      const range = /^bytes=(\d+)-/.exec(String(headers["range"] ?? ""));
      const start = range ? Number(range[1]) : 0;
      const size = object.body.length;
      response.writeHead(range ? 206 : 200, {
        "content-length": String(size - start),
        ...(range ? { "content-range": `bytes ${start}-${size - 1}/${size}` } : {}),
        "accept-ranges": "bytes",
      });
      const head = start < TRUNCATE_AT ? object.body.subarray(start, TRUNCATE_AT) : Buffer.alloc(0);
      return void response.write(head, () => response.socket?.destroy());
    }

    if (method === "GET") {
      const object = this.objects.get(key);
      if (!object) return void response.writeHead(404).end();

      // Range requests, because a video player and a PDF viewer open a file by
      // asking for pieces of it. Without this the stub would answer 200 to
      // every seek and the tests would say playback works when the real
      // provider's behaviour had never been exercised at all.
      const range = headers["range"];
      if (typeof range === "string") {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (match) {
          const size = object.body.length;
          const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2] || 0));
          const end = match[1] ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1) : size - 1;
          if (start > end || start >= size) {
            return void response
              .writeHead(416, { "content-range": `bytes */${size}` })
              .end();
          }
          const slice = object.body.subarray(start, end + 1);
          const disposition = url.searchParams.get("response-content-disposition");
          const type = url.searchParams.get("response-content-type");
          return void response
            .writeHead(206, {
              "content-length": String(slice.length),
              "content-range": `bytes ${start}-${end}/${size}`,
              "accept-ranges": "bytes",
              etag: `"${object.etag}"`,
              ...(disposition ? { "content-disposition": disposition } : {}),
              ...(type ? { "content-type": type } : {}),
            })
            .end(slice);
        }
      }
      // Response header overrides, which is how the download route forces an
      // attachment. Honoured here so the tests exercise the same mechanism a
      // real provider applies rather than assuming it works.
      const disposition = url.searchParams.get("response-content-disposition");
      const type = url.searchParams.get("response-content-type");
      response
        .writeHead(200, {
          "content-length": String(object.body.length),
          "accept-ranges": "bytes",
          etag: `"${object.etag}"`,
          ...(disposition ? { "content-disposition": disposition } : {}),
          ...(type ? { "content-type": type } : {}),
        })
        .end(object.body);
      return;
    }

    if (method === "DELETE") {
      this.objects.delete(key);
      response.writeHead(204).end();
      return;
    }

    response.writeHead(405).end();
  }
}

function md5(buffer: Buffer): string {
  return createHash("md5").update(buffer).digest("hex");
}

/** Points the application's storage adapter at a stub for the current test. */
/**
 * Whether a presigned URL is past its lifetime at `now`: `X-Amz-Date` (as
 * `YYYYMMDDTHHMMSSZ`) plus `X-Amz-Expires` seconds. A URL without both is not a
 * presigned one and never expires here. One that names a date it cannot parse
 * is treated as expired, as a real provider refuses it.
 */
export function presignedExpired(url: URL, now: number): boolean {
  const date = url.searchParams.get("X-Amz-Date");
  const expires = url.searchParams.get("X-Amz-Expires");
  if (date === null || expires === null) return false;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  const seconds = Number(expires);
  if (!match || !Number.isInteger(seconds) || seconds <= 0) return true;
  const [, y, mo, d, h, mi, s] = match.map(Number) as number[];
  const signedAt = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
  return now > signedAt + seconds * 1000;
}

/** Where a truncating object breaks off: short of any media format's header. */
const TRUNCATE_AT = 16;

/**
 * Whether a presigned URL was dated in a whole second before `cutoff`. A URL
 * signed in the same second as the cutoff, or after, is not: the date has
 * one-second resolution, and a recovery's fresh URL is signed after the test
 * expired the old ones.
 */
export function signedBefore(url: URL, cutoff: number): boolean {
  if (cutoff <= 0) return false;
  const date = url.searchParams.get("X-Amz-Date");
  const match = date && /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  if (!match) return false;
  const [, y, mo, d, h, mi, s] = match.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) + 1000 <= cutoff;
}

export function useStub(endpoint: string): void {
  process.env.BUCKET_ENDPOINT = endpoint;
  process.env.BUCKET_NAME = "test-bucket";
  process.env.BUCKET_REGION = "auto";
  process.env.BUCKET_ACCESS_KEY_ID = "test";
  process.env.BUCKET_SECRET_ACCESS_KEY = "test-secret-not-a-real-credential";
}
