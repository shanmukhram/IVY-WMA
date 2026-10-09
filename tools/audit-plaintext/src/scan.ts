export interface Hit {
  rule: string;
  offset: number;
  /** Printable, truncated evidence (escaped). */
  evidence: string;
}

export interface ScanOptions {
  /** Known plaintext strings (fixture content etc.). Matched as UTF-8 and UTF-16LE. */
  markers?: string[];
  /** Printable ASCII runs this long (or longer) are hits. Default 24. */
  minPrintableRun?: number;
  /** Bytes at the start of the buffer exempt from the printable-run rule. Default 64. */
  headerAllowance?: number;
  /** Disable the printable-run rule (used for TEXT columns, which are printable by nature). */
  skipPrintableRun?: boolean;
  /** Treat buffer as starting at file offset 0 (magic-at-start rules apply). Default true. */
  atStart?: boolean;
  maxHits?: number;
}

const GENERIC_MARKERS = ['"kind":', '"path":'];
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const esc = (b: Buffer) =>
  b.toString("latin1").replace(/[^\x20-\x7e]/g, (c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0"));
const isPrintable = (c: number) => c >= 0x20 && c <= 0x7e;

export function scanBuffer(buf: Buffer, opts: ScanOptions = {}): Hit[] {
  const hits: Hit[] = [];
  const max = opts.maxHits ?? 20;
  const add = (rule: string, offset: number, len: number) => {
    if (hits.length < max) hits.push({ rule, offset, evidence: esc(buf.subarray(offset, offset + Math.min(len, 40))) });
  };
  const findAll = (needle: Buffer, rule: string) => {
    if (needle.length === 0) return;
    let from = 0;
    for (;;) {
      const i = buf.indexOf(needle, from);
      if (i < 0 || hits.length >= max) return;
      add(rule, i, needle.length);
      from = i + needle.length;
    }
  };

  for (const m of opts.markers ?? []) {
    if (!m) continue;
    findAll(Buffer.from(m, "utf8"), `marker:${m.length > 60 ? m.slice(0, 57) + "..." : m}`);
    findAll(Buffer.from(m, "utf16le"), `marker-utf16:${m.length > 60 ? m.slice(0, 57) + "..." : m}`);
  }
  for (const m of GENERIC_MARKERS) findAll(Buffer.from(m, "utf8"), `generic:${m}`);
  findAll(Buffer.from("%PDF"), "magic:pdf");
  findAll(PNG, "magic:png");
  findAll(Buffer.from("JFIF\0"), "magic:jpeg-jfif");
  findAll(Buffer.from("Exif\0\0"), "magic:jpeg-exif");
  if ((opts.atStart ?? true) && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) add("magic:jpeg", 0, 4);

  if (!opts.skipPrintableRun) {
    const minRun = opts.minPrintableRun ?? 24;
    const header = (opts.atStart ?? true) ? (opts.headerAllowance ?? 64) : 0;
    let runStart = -1;
    for (let i = header; i <= buf.length && hits.length < max; i++) {
      const p = i < buf.length && isPrintable(buf[i]!);
      if (p) { if (runStart < 0) runStart = i; }
      else if (runStart >= 0) {
        if (i - runStart >= minRun) add(`printable-run:${i - runStart}`, runStart, i - runStart);
        runStart = -1;
      }
    }
  }
  return hits;
}
