import { S3Client } from "@aws-sdk/client-s3";

import { bucketConfig } from "../env.ts";

/**
 * The bucket, as an S3 client.
 *
 * **Written against S3, not against a vendor.** Nothing in this file, or
 * anywhere above it, names who is holding the bytes — the adapter takes an
 * endpoint and a credential, so moving provider is configuration plus a bulk
 * copy rather than a rewrite. Today that endpoint belongs to a private Railway
 * Storage Bucket; the code has no opinion about that.
 *
 * Created on first use rather than at module load, for the same reason the
 * database connection is: `next build` runs with no runtime secrets, and a
 * module-level client would fail the build instead of the request. It also
 * means a page that never touches storage never constructs one.
 */

let client: S3Client | null = null;
let bucket: string | null = null;

function assertServer(): void {
  if (typeof window !== "undefined") {
    throw new Error("lib/storage may only be used on the server.");
  }
}

export function storage(): { client: S3Client; bucket: string } {
  assertServer();

  if (!client || !bucket) {
    const config = bucketConfig();
    bucket = config.bucket;
    client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      // Every S3-compatible provider that is not AWS itself addresses buckets
      // by path rather than by a virtual host, and signs accordingly.
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  return { client, bucket };
}

/** Drops the cached client. Tests point the adapter somewhere else with it. */
export function resetStorage(): void {
  client = null;
  bucket = null;
}
