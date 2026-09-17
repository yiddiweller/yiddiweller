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
 */

type StoredObject = { body: Buffer; contentType: string; etag: string };

export class S3Stub {
  readonly objects = new Map<string, StoredObject>();
  private readonly uploads = new Map<string, Map<number, Buffer>>();
  private server: Server | null = null;
  private port = 0;

  /** Every request this stub saw, so a test can assert what was never asked. */
  readonly seen: { method: string; key: string }[] = [];

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://stub");
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

    if (method === "GET") {
      const object = this.objects.get(key);
      if (!object) return void response.writeHead(404).end();
      // Response header overrides, which is how the download route forces an
      // attachment. Honoured here so the tests exercise the same mechanism a
      // real provider applies rather than assuming it works.
      const disposition = url.searchParams.get("response-content-disposition");
      const type = url.searchParams.get("response-content-type");
      response
        .writeHead(200, {
          "content-length": String(object.body.length),
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
export function useStub(endpoint: string): void {
  process.env.BUCKET_ENDPOINT = endpoint;
  process.env.BUCKET_NAME = "test-bucket";
  process.env.BUCKET_REGION = "auto";
  process.env.BUCKET_ACCESS_KEY_ID = "test";
  process.env.BUCKET_SECRET_ACCESS_KEY = "test-secret-not-a-real-credential";
}
