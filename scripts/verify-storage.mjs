/**
 * Proves the storage lifecycle against whatever bucket this environment is
 * configured with. Run it once per environment, before trusting Files there.
 *
 *   npm run storage:verify
 *
 * It exists because every automated storage test runs against an in-process
 * S3-compatible server that accepts any signature. That proves the flow and
 * says nothing about whether a signed URL satisfies a real provider, whether
 * multipart behaves as S3 does, or whether these credentials work. **Only a
 * real bucket answers that, and this is what asks it.**
 *
 * Writes and deletes only under `verify/`, never `pending/` and never `w/`, so
 * it cannot touch a real file even if pointed at production by mistake. It
 * cleans up after itself and reports what it could not clean.
 *
 * Prints results, never values: no key contents, no credential, no signed URL.
 *
 * One check cannot pass against a test double: "the bucket is not public"
 * fetches without a signature and expects a refusal, and an unauthenticated
 * local stub has nothing to refuse with. Against a real private bucket it is
 * the most important line here.
 */

const PREFIX = "verify/";

async function main() {
  const missing = [
    "BUCKET_ENDPOINT",
    "BUCKET_NAME",
    "BUCKET_REGION",
    "BUCKET_ACCESS_KEY_ID",
    "BUCKET_SECRET_ACCESS_KEY",
  ].filter((key) => !process.env[key]?.trim());

  if (missing.length > 0) {
    console.error(`Storage is not configured here. Absent: ${missing.join(", ")}`);
    process.exit(1);
  }

  const { S3Client, PutObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand,
    CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
    GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

  const bucket = process.env.BUCKET_NAME.trim();
  const client = new S3Client({
    region: process.env.BUCKET_REGION.trim(),
    endpoint: process.env.BUCKET_ENDPOINT.trim().replace(/\/+$/, ""),
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.BUCKET_ACCESS_KEY_ID.trim(),
      secretAccessKey: process.env.BUCKET_SECRET_ACCESS_KEY.trim(),
    },
  });

  const run = String(Date.now());
  const source = `${PREFIX}${run}/source`;
  const target = `${PREFIX}${run}/target`;
  const big = `${PREFIX}${run}/multipart`;
  const created = [];
  const results = [];
  let failed = 0;

  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push(`  pass   ${name}${detail ? ` — ${detail}` : ""}`);
    } catch (cause) {
      failed += 1;
      const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown";
      results.push(`  FAIL   ${name} — ${message}`);
    }
  };

  const body = Buffer.from("storage verification payload");

  await check("presigned PUT accepted by the provider", async () => {
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: source, ContentType: "application/octet-stream" }),
      { expiresIn: 300 },
    );
    const response = await fetch(url, { method: "PUT", body });
    if (!response.ok) throw new Error(`provider answered ${response.status}`);
    created.push(source);
    return "the signature was honoured";
  });

  await check("authenticated HEAD reports the real size and an ETag", async () => {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: source }));
    if (head.ContentLength !== body.length) {
      throw new Error(`size ${head.ContentLength} is not ${body.length}`);
    }
    if (!head.ETag) throw new Error("no ETag");
    return `${head.ContentLength} bytes`;
  });

  await check("server-side CopyObject", async () => {
    await client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${source}`.split("/").map(encodeURIComponent).join("/"),
        Key: target,
      }),
    );
    created.push(target);
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: target }));
    if (head.ContentLength !== body.length) throw new Error("the copy is a different size");
    return "the permanent key is written by us, not by a browser";
  });

  await check("presigned GET returns the bytes, with a forced disposition", async () => {
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: target,
        ResponseContentDisposition: 'attachment; filename="verify.bin"',
        ResponseContentType: "application/octet-stream",
      }),
      { expiresIn: 60 },
    );
    const response = await fetch(url);
    if (!response.ok) throw new Error(`provider answered ${response.status}`);
    const text = await response.text();
    if (text !== body.toString()) throw new Error("different bytes came back");
    const disposition = response.headers.get("content-disposition") ?? "";
    if (!disposition.includes("attachment")) throw new Error("disposition was not honoured");
    return "attachment honoured";
  });

  await check("multipart upload, the path every file over 100 MB takes", async () => {
    const started = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: big }),
    );
    if (!started.UploadId) throw new Error("no upload id");
    created.push(big);

    // Two parts. A real part is 16 MiB; the shape is what is being proven, and
    // a provider that accepts these accepts those.
    const parts = [];
    for (let number = 1; number <= 2; number++) {
      const url = await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: big,
          UploadId: started.UploadId,
          PartNumber: number,
        }),
        { expiresIn: 300 },
      );
      const chunk = Buffer.alloc(5 * 1024 * 1024, number === 1 ? "a" : "b");
      const response = await fetch(url, { method: "PUT", body: chunk });
      if (!response.ok) throw new Error(`part ${number}: provider answered ${response.status}`);
      const etag = response.headers.get("etag");
      if (!etag) throw new Error(`part ${number}: no ETag returned`);
      parts.push({ PartNumber: number, ETag: etag });
    }

    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: big,
        UploadId: started.UploadId,
        MultipartUpload: { Parts: parts },
      }),
    );

    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: big }));
    if (head.ContentLength !== 10 * 1024 * 1024) {
      throw new Error(`assembled to ${head.ContentLength}, not 10485760`);
    }
    return "two presigned parts, completed server-side";
  });

  await check("DeleteObject, and a second delete is not an error", async () => {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: source }));
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: source }));
    created.splice(created.indexOf(source), 1);
    return "the sweep can be idempotent";
  });

  await check("a HEAD of something absent is a clean miss, not a crash", async () => {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: `${PREFIX}${run}/never` }));
    } catch (cause) {
      const status = cause?.$metadata?.httpStatusCode;
      if (status === 404 || cause?.name === "NotFound") return "404";
      throw cause;
    }
    throw new Error("a key that was never written reported as present");
  });

  await check("the bucket is not public", async () => {
    const endpoint = process.env.BUCKET_ENDPOINT.trim().replace(/\/+$/, "");
    const response = await fetch(`${endpoint}/${bucket}/${target}`);
    if (response.ok) throw new Error(`unsigned GET returned ${response.status} — THE BUCKET IS PUBLIC`);
    return `unsigned GET refused with ${response.status}`;
  });

  for (const key of created) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      results.push(`  note   could not clean up one verify/ object; remove it by hand`);
    }
  }

  console.log(`\nStorage verification — bucket "${bucket}"\n`);
  console.log(results.join("\n"));
  console.log(
    failed === 0
      ? "\nAll checks passed. This environment's Files routes can be trusted.\n"
      : `\n${failed} check(s) failed. Do not trust Files in this environment yet.\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((cause) => {
  console.error(cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error");
  process.exit(1);
});
