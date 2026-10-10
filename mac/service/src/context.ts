/** Shared service context passed to every module. */
import type { DB } from "./db/index.ts";
import type { ServiceConfig } from "./config.ts";
import type { Keystore } from "./keystore/keystore.ts";
import type { EventBus } from "./events.ts";
import { R2, R2ConfigSchema, type R2Config } from "./r2/config.ts";
import { readSealed, writeSealed, hasSealed } from "./keystore/sealed-settings.ts";

export interface Thumbnailer {
  /** Write a JPEG thumbnail of `src` to `dest`; resolve false when it cannot. */
  make(src: string, dest: string): Promise<boolean>;
}

export interface OcrProvider {
  /** Extract text from an image. Extension point for mac/ocr (Vision). */
  recognize(imagePath: string): Promise<string>;
}

export class Ctx {
  readonly db: DB;
  readonly config: ServiceConfig;
  readonly keystore: Keystore;
  readonly events: EventBus;
  thumbnailer: Thumbnailer | null = null;
  ocr: OcrProvider | null = null;
  /** called when a media original is in place (thumbnail + OCR post-processing) */
  mediaReady: ((mediaId: string, path: string) => void) | null = null;
  private r2cache: R2 | null = null;

  constructor(db: DB, config: ServiceConfig, keystore: Keystore, events: EventBus) {
    this.db = db;
    this.config = config;
    this.keystore = keystore;
    this.events = events;
  }

  r2Configured(): boolean { return hasSealed(this.db, "r2"); }

  /** The R2 clients; null when locked or not configured. */
  r2(): R2 | null {
    if (!this.keystore.isUnlocked()) { this.dropR2(); return null; }
    if (this.r2cache) return this.r2cache;
    const c = readSealed<R2Config>(this.db, this.keystore.secretKey(), "r2");
    if (!c) return null;
    this.r2cache = new R2(R2ConfigSchema.parse(c));
    return this.r2cache;
  }

  setR2Config(input: unknown): R2Config {
    const c = R2ConfigSchema.parse(input);
    writeSealed(this.db, this.keystore.secretKey(), "r2", c);
    this.dropR2();
    return c;
  }

  dropR2(): void {
    this.r2cache?.close();
    this.r2cache = null;
  }
}
