export type Operation =
  | "CreateBucket"
  | "HeadBucket"
  | "PutObject"
  | "GetObject"
  | "HeadObject"
  | "DeleteObject"
  | "DeleteObjects"
  | "ListObjectsV2"
  | "CreateMultipartUpload"
  | "UploadPart"
  | "ListParts"
  | "CompleteMultipartUpload"
  | "AbortMultipartUpload";

/** bucket "*" and operation "*" are wildcards. */
export interface Scope {
  bucket: string;
  operations: Array<Operation | "*">;
}

/** access key id -> allowed scopes. Keys absent from the map are denied (403). */
export type Policy = Record<string, Scope | Scope[]>;

export interface MockOptions {
  port?: number;
  host?: string;
  root: string;
  policy?: Policy;
  /** Buckets to pre-create (bypasses policy). */
  buckets?: string[];
}

export interface RequestRecord {
  accessKeyId: string | null;
  operation: Operation | "Unknown";
  bucket: string | null;
  key: string | null;
  method: string;
  status: number;
}

export interface ObjectInfo {
  key: string;
  size: number;
  etag: string;
  lastModified: string;
}

export interface MockServer {
  url: string;
  port: number;
  root: string;
  stop(): Promise<void>;
  listAll(bucket: string): ObjectInfo[];
  readRaw(bucket: string, key: string): Buffer;
  /** Every request seen, in order, with the SigV4 access key id used. */
  requests(): RequestRecord[];
  clearRequests(): void;
  /** Distinct access key ids seen, optionally restricted to one bucket. */
  accessKeysSeen(bucket?: string): string[];
  setPolicy(policy: Policy | undefined): void;
}
