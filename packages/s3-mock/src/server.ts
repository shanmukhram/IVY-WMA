import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "./store.ts";
import type { MockOptions, MockServer, Operation, Policy, RequestRecord, Scope } from "./types.ts";

const MIN_PART = 5 * 1024 * 1024;

class S3Error extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

const xmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const xmlUnesc = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
const q = (s: string) => `"${s}"`;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Decode SigV4 streaming / aws-chunked payloads (chunk-signature and trailers ignored). */
function decodeAwsChunked(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf("\r\n", pos);
    if (nl < 0) throw new S3Error(400, "IncompleteBody", "bad aws-chunked framing");
    const header = buf.subarray(pos, nl).toString("latin1");
    const size = parseInt(header.split(";")[0]!, 16);
    if (Number.isNaN(size)) throw new S3Error(400, "IncompleteBody", "bad chunk size");
    pos = nl + 2;
    if (size === 0) break;
    if (pos + size > buf.length) throw new S3Error(400, "IncompleteBody", "truncated chunk");
    out.push(buf.subarray(pos, pos + size));
    pos += size + 2;
  }
  return Buffer.concat(out);
}

function parseAccessKey(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    const m = /Credential=([^/,\s]+)\//.exec(auth);
    if (m) return decodeURIComponent(m[1]!);
  }
  const c = url.searchParams.get("X-Amz-Credential");
  if (c) return c.split("/")[0]!;
  return null;
}

function allowed(policy: Policy | undefined, ak: string | null, op: Operation, bucket: string | null): boolean {
  if (!policy) return true;
  if (ak === null) return false;
  const entry = policy[ak];
  if (!entry) return false;
  const scopes: Scope[] = Array.isArray(entry) ? entry : [entry];
  return scopes.some((s) =>
    (s.bucket === "*" || s.bucket === bucket) && (s.operations.includes("*") || s.operations.includes(op)));
}

function parseRange(h: string, size: number): { start: number; end: number } | "invalid" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m) return null; // malformed -> ignore, serve whole object like S3
  let start: number, end: number;
  if (m[1] === "") {
    if (m[2] === "") return null;
    const n = parseInt(m[2]!, 10);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = parseInt(m[1]!, 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2]!, 10), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

export async function startMock(opts: MockOptions): Promise<MockServer> {
  const store = new Store(opts.root);
  for (const b of opts.buckets ?? []) store.createBucket(b);
  let policy = opts.policy;
  const log: RequestRecord[] = [];

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const accessKeyId = parseAccessKey(req, url);
    const segs = url.pathname.replace(/^\//, "");
    const slash = segs.indexOf("/");
    const bucket = segs === "" ? null : decodeURIComponent(slash < 0 ? segs : segs.slice(0, slash));
    const keyRaw = slash < 0 ? "" : segs.slice(slash + 1);
    const key = keyRaw === "" ? null : decodeURIComponent(keyRaw);
    const sp = url.searchParams;
    const record: RequestRecord = { accessKeyId, operation: "Unknown", bucket, key, method, status: 0 };
    log.push(record);

    const send = (status: number, body?: string | Buffer, headers: Record<string, string | number> = {}) => {
      record.status = status;
      res.writeHead(status, headers);
      res.end(method === "HEAD" ? undefined : body);
    };
    const xml = (status: number, body: string, headers: Record<string, string> = {}) =>
      send(status, `<?xml version="1.0" encoding="UTF-8"?>\n${body}`, { "Content-Type": "application/xml", ...headers });

    try {
      // ---- route ----
      let op: Operation | null = null;
      if (bucket && !key) {
        if (method === "PUT") op = "CreateBucket";
        else if (method === "HEAD") op = "HeadBucket";
        else if (method === "GET") op = "ListObjectsV2";
        else if (method === "POST" && sp.has("delete")) op = "DeleteObjects";
      } else if (bucket && key) {
        if (method === "PUT" && sp.has("uploadId") && sp.has("partNumber")) op = "UploadPart";
        else if (method === "PUT") op = "PutObject";
        else if (method === "GET" && sp.has("uploadId")) op = "ListParts";
        else if (method === "GET") op = "GetObject";
        else if (method === "HEAD") op = "HeadObject";
        else if (method === "DELETE" && sp.has("uploadId")) op = "AbortMultipartUpload";
        else if (method === "DELETE") op = "DeleteObject";
        else if (method === "POST" && sp.has("uploads")) op = "CreateMultipartUpload";
        else if (method === "POST" && sp.has("uploadId")) op = "CompleteMultipartUpload";
      }
      if (!op) throw new S3Error(501, "NotImplemented", `${method} ${url.pathname} not supported by mock`);
      record.operation = op;

      if (!allowed(policy, accessKeyId, op, bucket)) {
        // consume body so the client sees the response cleanly
        await readBody(req).catch(() => undefined);
        throw new S3Error(403, "AccessDenied", "Access Denied");
      }

      // Read body for ops that carry one.
      let body: Buffer = Buffer.alloc(0);
      if (method === "PUT" || method === "POST") {
        body = await readBody(req);
        const sha = String(req.headers["x-amz-content-sha256"] ?? "");
        const enc = String(req.headers["content-encoding"] ?? "");
        if (sha.startsWith("STREAMING-") || /aws-chunked/.test(enc)) body = decodeAwsChunked(body);
      }

      const b = bucket!;
      if (op !== "CreateBucket" && !store.hasBucket(b)) throw new S3Error(404, "NoSuchBucket", "The specified bucket does not exist");

      switch (op) {
        case "CreateBucket": {
          if (!store.createBucket(b)) throw new S3Error(409, "BucketAlreadyOwnedByYou", "Your previous request to create the named bucket succeeded and you already own it.");
          return send(200, undefined, { Location: `/${b}`, "Content-Length": 0 });
        }
        case "HeadBucket":
          return send(200, undefined, { "x-amz-bucket-region": "auto" });

        case "PutObject": {
          const userMeta = collectUserMeta(req);
          const m = store.put(b, key!, body, String(req.headers["content-type"] ?? "binary/octet-stream"), userMeta);
          return send(200, undefined, { ETag: q(m.etag), "Content-Length": 0 });
        }
        case "HeadObject":
        case "GetObject": {
          const m = store.head(b, key!);
          if (!m) throw new S3Error(404, "NoSuchKey", "The specified key does not exist.");
          const headers: Record<string, string | number> = {
            ETag: q(m.etag), "Last-Modified": new Date(m.lastModified).toUTCString(),
            "Content-Type": m.contentType, "Accept-Ranges": "bytes",
          };
          for (const [k, v] of Object.entries(m.userMeta)) headers[`x-amz-meta-${k}`] = v;
          const rangeH = req.headers.range;
          if (rangeH) {
            const r = parseRange(String(rangeH), m.size);
            if (r === "invalid") {
              throw new S3Error(416, "InvalidRange", "The requested range is not satisfiable");
            }
            if (r) {
              headers["Content-Range"] = `bytes ${r.start}-${r.end}/${m.size}`;
              headers["Content-Length"] = r.end - r.start + 1;
              return send(206, op === "GetObject" ? store.read(b, key!).subarray(r.start, r.end + 1) : undefined, headers);
            }
          }
          headers["Content-Length"] = m.size;
          return send(200, op === "GetObject" ? store.read(b, key!) : undefined, headers);
        }
        case "DeleteObject": {
          store.delete(b, key!);
          return send(204);
        }
        case "DeleteObjects": {
          const text = body.toString("utf8");
          const quiet = /<Quiet>\s*true\s*<\/Quiet>/i.test(text);
          const keys = [...text.matchAll(/<Object>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Object>/g)].map((m) => xmlUnesc(m[1]!));
          for (const k of keys) store.delete(b, k);
          const items = quiet ? "" : keys.map((k) => `<Deleted><Key>${xmlEsc(k)}</Key></Deleted>`).join("");
          return xml(200, `<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${items}</DeleteResult>`);
        }
        case "ListObjectsV2":
          return listObjects(b);

        case "CreateMultipartUpload": {
          const id = store.createUpload(b, key!, String(req.headers["content-type"] ?? "binary/octet-stream"), collectUserMeta(req));
          return xml(200, `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${xmlEsc(b)}</Bucket><Key>${xmlEsc(key!)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
        }
        case "UploadPart": {
          const id = sp.get("uploadId")!;
          if (!store.uploadMeta(b, id, key!)) throw new S3Error(404, "NoSuchUpload", "The specified upload does not exist.");
          const n = parseInt(sp.get("partNumber")!, 10);
          if (!(n >= 1 && n <= 10000)) throw new S3Error(400, "InvalidArgument", "Part number must be an integer between 1 and 10000");
          const etag = store.putPart(b, id, n, body);
          return send(200, undefined, { ETag: q(etag), "Content-Length": 0 });
        }
        case "ListParts": {
          const id = sp.get("uploadId")!;
          if (!store.uploadMeta(b, id, key!)) throw new S3Error(404, "NoSuchUpload", "The specified upload does not exist.");
          const marker = parseInt(sp.get("part-number-marker") ?? "0", 10);
          const max = Math.min(parseInt(sp.get("max-parts") ?? "1000", 10), 1000);
          const all = store.listParts(b, id).filter((p) => p.partNumber > marker);
          const page = all.slice(0, max);
          const trunc = all.length > page.length;
          const parts = page.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><LastModified>${p.lastModified}</LastModified><ETag>${xmlEsc(q(p.etag))}</ETag><Size>${p.size}</Size></Part>`).join("");
          return xml(200, `<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>${xmlEsc(b)}</Bucket><Key>${xmlEsc(key!)}</Key><UploadId>${id}</UploadId><PartNumberMarker>${marker}</PartNumberMarker>${trunc ? `<NextPartNumberMarker>${page[page.length - 1]!.partNumber}</NextPartNumberMarker>` : ""}<MaxParts>${max}</MaxParts><IsTruncated>${trunc}</IsTruncated>${parts}</ListPartsResult>`);
        }
        case "CompleteMultipartUpload": {
          const id = sp.get("uploadId")!;
          if (!store.uploadMeta(b, id, key!)) throw new S3Error(404, "NoSuchUpload", "The specified upload does not exist.");
          const text = body.toString("utf8");
          const parts = [...text.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map((m) => ({
            partNumber: parseInt(/<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(m[1]!)?.[1] ?? "0", 10),
            etag: xmlUnesc(/<ETag>([\s\S]*?)<\/ETag>/.exec(m[1]!)?.[1] ?? ""),
          }));
          const r = store.completeUpload(b, id, parts, MIN_PART);
          if (!r.ok) throw new S3Error(r.code === "MalformedXML" ? 400 : 400, r.code, r.message);
          return xml(200, `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>${xmlEsc(`${urlBase}/${b}/${key}`)}</Location><Bucket>${xmlEsc(b)}</Bucket><Key>${xmlEsc(key!)}</Key><ETag>${xmlEsc(q(r.meta.etag))}</ETag></CompleteMultipartUploadResult>`);
        }
        case "AbortMultipartUpload": {
          const id = sp.get("uploadId")!;
          if (!store.uploadMeta(b, id, key!)) throw new S3Error(404, "NoSuchUpload", "The specified upload does not exist.");
          store.abortUpload(b, id);
          return send(204);
        }
      }
    } catch (e) {
      const err = e instanceof S3Error ? e : new S3Error(500, "InternalError", String((e as Error)?.stack ?? e));
      if (method === "HEAD") return send(err.status);
      return xml(err.status, `<Error><Code>${err.code}</Code><Message>${xmlEsc(err.message)}</Message><Resource>${xmlEsc(url.pathname)}</Resource><RequestId>mock</RequestId></Error>`);
    }

    function listObjects(b: string) {
      const prefix = sp.get("prefix") ?? "";
      const delimiter = sp.get("delimiter") ?? "";
      const max = Math.min(Math.max(parseInt(sp.get("max-keys") ?? "1000", 10), 0), 1000);
      const ct = sp.get("continuation-token");
      const startAfterParam = sp.get("start-after") ?? "";
      const encUrl = sp.get("encoding-type") === "url";
      const enc = (s: string) => xmlEsc(encUrl ? encodeURIComponent(s) : s);
      let after = startAfterParam;
      if (ct) {
        try { after = Buffer.from(ct, "base64url").toString("utf8"); }
        catch { throw new S3Error(400, "InvalidArgument", "The continuation token provided is incorrect"); }
      }
      // Walk keys in order, collapsing common prefixes; each content/prefix counts as one entry.
      const contents: string[] = [];
      const prefixes = new Set<string>();
      let count = 0, truncated = false, last = "";
      for (const m of store.sortedKeys(b)) {
        if (!m.key.startsWith(prefix)) continue;
        if (after && Buffer.compare(Buffer.from(m.key), Buffer.from(after)) <= 0) continue;
        let cp: string | null = null;
        if (delimiter) {
          const i = m.key.indexOf(delimiter, prefix.length);
          if (i >= 0) cp = m.key.slice(0, i + delimiter.length);
        }
        if (cp !== null) {
          if (prefixes.has(cp)) { last = m.key; continue; }
          if (count >= max) { truncated = true; break; }
          prefixes.add(cp); count++; last = m.key;
          // skip remaining keys within this prefix: set cursor past the whole group
          last = cp + "￿";
          continue;
        }
        if (count >= max) { truncated = true; break; }
        contents.push(`<Contents><Key>${enc(m.key)}</Key><LastModified>${m.lastModified}</LastModified><ETag>${xmlEsc(q(m.etag))}</ETag><Size>${m.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`);
        count++; last = m.key;
      }
      // when a prefix group was the last entry, "last" cursor must skip the group's keys
      const next = truncated ? `<NextContinuationToken>${Buffer.from(last, "utf8").toString("base64url")}</NextContinuationToken>` : "";
      const cps = [...prefixes].map((p) => `<CommonPrefixes><Prefix>${enc(p)}</Prefix></CommonPrefixes>`).join("");
      return xml(200, `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEsc(b)}</Name><Prefix>${enc(prefix)}</Prefix>${delimiter ? `<Delimiter>${enc(delimiter)}</Delimiter>` : ""}${startAfterParam ? `<StartAfter>${enc(startAfterParam)}</StartAfter>` : ""}${ct ? `<ContinuationToken>${xmlEsc(ct)}</ContinuationToken>` : ""}<KeyCount>${count}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${encUrl ? "<EncodingType>url</EncodingType>" : ""}${next}${contents.join("")}${cps}</ListBucketResult>`);
    }
  };

  const server = createServer((req, res) => { handler(req, res).catch((e) => { res.statusCode = 500; res.end(String(e)); }); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const urlBase = `http://${opts.host ?? "127.0.0.1"}:${port}`;

  return {
    url: urlBase,
    port,
    root: opts.root,
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
    listAll: (bucket) => store.sortedKeys(bucket).map(({ key, size, etag, lastModified }) => ({ key, size, etag, lastModified })),
    readRaw: (bucket, key) => {
      if (!store.head(bucket, key)) throw new Error(`no such object ${bucket}/${key}`);
      return store.read(bucket, key);
    },
    requests: () => log.map((r) => ({ ...r })),
    clearRequests: () => { log.length = 0; },
    accessKeysSeen: (bucket) => [...new Set(log.filter((r) => !bucket || r.bucket === bucket).map((r) => r.accessKeyId).filter((k): k is string => k !== null))],
    setPolicy: (p) => { policy = p; },
  };
}

function collectUserMeta(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith("x-amz-meta-") && typeof v === "string") out[k.slice(11)] = v;
  }
  return out;
}
