import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveMacKeyPair, fingerprint, fromBase64, toBase64, toHex, fromHex } from "@ivy/protocol";
import { Keystore, KeystoreError } from "../src/keystore/keystore.ts";
import { tempDir, rm, PASS } from "./helpers/harness.ts";

const vectors = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../docs/test-vectors/argon2id.json"), "utf8"));

let dir: string;
let path: string;
let clock = 0;
const ks = (o: Partial<ConstructorParameters<typeof Keystore>[0]> = {}) => new Keystore({ path, autoLockMinutes: 30, now: () => clock, ...o });

beforeEach(() => { dir = tempDir("ivy-ks-"); path = join(dir, "identity.json"); clock = 1_000_000; });
afterEach(() => rm(dir));

describe("key store (S8, PROTOCOL §3)", () => {
  it("starts uninitialized and refuses to hand out a key", async () => {
    const k = ks();
    expect(k.state()).toBe("uninitialized");
    expect(() => k.secretKey()).toThrow(KeystoreError);
  });

  it("derives the identity from passphrase + stored salt with the protocol's Argon2id", async () => {
    const k = ks();
    const r = await k.initialize(PASS);
    expect(k.state()).toBe("unlocked");
    const f = JSON.parse(readFileSync(path, "utf8"));
    const kp = deriveMacKeyPair(PASS, fromBase64(f.salt));
    expect(toBase64(kp.publicKey)).toBe(f.publicKey);
    expect(r.fingerprint).toBe(fingerprint(kp.publicKey));
    expect(toHex(k.secretKey())).toBe(toHex(kp.secretKey));
    expect(f.kdf).toMatchObject({ memoryKiB: 65536, iterations: 3, parallelism: 1, saltLen: 16, outputLen: 32, variant: "argon2id", version: 19 });
  });

  it("reproduces the cross-port Argon2id vector (docs/test-vectors/argon2id.json)", async () => {
    const k = ks();
    const r = await k.initialize(vectors.passphrase, toBase64(fromHex(vectors.saltHex)));
    expect(r.restored).toBe(true);
    expect(toHex(k.secretKey())).toBe(vectors.derivedSecretKeyHex);
    expect(r.fingerprint).toBe(vectors.fingerprint);
  });

  it("never writes the private key in the clear (only the §3.3 sealed blob)", async () => {
    const k = ks();
    await k.initialize(PASS);
    const raw = readFileSync(path, "utf8");
    const sk = k.secretKey();
    expect(raw).not.toContain(toHex(sk));
    expect(raw).not.toContain(toBase64(sk));
    const f = JSON.parse(raw);
    expect(f.sealed).toMatchObject({ v: 1 });
    expect(Buffer.from(f.sealed.blob, "base64").subarray(0, 5).toString()).toBe("IVYK1");
    expect(f.sealed.salt).not.toBe(f.salt); // at-rest salt is independent of the identity salt
  });

  it("lock zeroes the in-memory key; unlock with the right passphrase restores the same identity", async () => {
    const k = ks();
    const { fingerprint: fp } = await k.initialize(PASS);
    const held = k.secretKey();
    k.lock("manual", { full: true });
    expect(k.state()).toBe("locked");
    expect(held.every((b) => b === 0)).toBe(true);
    expect(() => k.secretKey()).toThrow(/locked/);
    const k2 = ks(); // a fresh process
    expect(k2.state()).toBe("locked");
    expect((await k2.unlock(PASS)).fingerprint).toBe(fp);
  });

  it("rejects a wrong passphrase and stays locked", async () => {
    const k = ks();
    await k.initialize(PASS);
    k.lock();
    await expect(k.unlock("not the passphrase")).rejects.toThrow(expect.objectContaining({ code: "wrong_passphrase" }));
    expect(k.state()).toBe("locked");
  });

  it("cools down after five wrong passphrases", async () => {
    const k = ks();
    await k.initialize(PASS);
    k.lock();
    for (let i = 0; i < 5; i++) await expect(k.unlock("wrong wrong")).rejects.toThrow(expect.objectContaining({ code: "wrong_passphrase" }));
    await expect(k.unlock(PASS)).rejects.toThrow(expect.objectContaining({ code: "cooldown" }));
    clock += 31_000;
    expect((await k.unlock(PASS)).fingerprint).toBeTruthy();
  });

  it("change passphrase re-seals the SAME key: devices stay paired", async () => {
    const k = ks();
    const { fingerprint: fp } = await k.initialize(PASS);
    const before = toHex(k.secretKey());
    await k.changePassphrase(PASS, "a brand new passphrase");
    k.lock("manual", { full: true });
    await expect(k.unlock(PASS)).rejects.toThrow(expect.objectContaining({ code: "wrong_passphrase" }));
    expect((await k.unlock("a brand new passphrase")).fingerprint).toBe(fp);
    expect(toHex(k.secretKey())).toBe(before);
    expect(JSON.parse(readFileSync(path, "utf8")).derivedFrom).toBe("original-passphrase");
  });

  it("change passphrase requires the current one", async () => {
    const k = ks();
    await k.initialize(PASS);
    await expect(k.changePassphrase("nope nope nope", "another passphrase")).rejects.toThrow(expect.objectContaining({ code: "wrong_passphrase" }));
  });

  it("restores the identity from the salt file + same passphrase (re-pair after restore)", async () => {
    const k = ks();
    const { fingerprint: fp } = await k.initialize(PASS);
    const salt = JSON.parse(readFileSync(path, "utf8")).salt;
    const dir2 = tempDir("ivy-ks2-");
    try {
      const p2 = join(dir2, "identity.json");
      writeFileSync(p2, JSON.stringify({ v: 1, salt })); // only the backed-up salt
      const k2 = new Keystore({ path: p2, autoLockMinutes: 30 });
      expect(k2.state()).toBe("uninitialized");
      expect(k2.status().saltPresent).toBe(true);
      const r = await k2.initialize(PASS);
      expect(r.restored).toBe(true);
      expect(r.fingerprint).toBe(fp);
      // a different passphrase with the same salt is a different identity
      const p3 = join(dir2, "other.json");
      writeFileSync(p3, JSON.stringify({ v: 1, salt }));
      expect((await new Keystore({ path: p3, autoLockMinutes: 30 }).initialize("different passphrase")).fingerprint).not.toBe(fp);
    } finally { rm(dir2); }
  });

  it("auto-locks after the idle period and activity postpones it", async () => {
    const k = ks({ autoLockMinutes: 30 });
    await k.initialize(PASS);
    clock += 29 * 60_000;
    expect(k.checkIdle()).toBe(false);
    k.touch();
    clock += 29 * 60_000;
    expect(k.checkIdle()).toBe(false);
    clock += 2 * 60_000;
    expect(k.checkIdle()).toBe(true);
    expect(k.state()).toBe("locked");
    expect(k.status().lockReason).toBe("idle");
  });

  it("auto-lock 0 means never", async () => {
    const k = ks({ autoLockMinutes: 0 });
    await k.initialize(PASS);
    clock += 365 * 86400_000;
    expect(k.checkIdle()).toBe(false);
    expect(k.isUnlocked()).toBe(true);
  });

  it("refuses weak passphrases, bad salts and a second initialize", async () => {
    const k = ks();
    await expect(k.initialize("short")).rejects.toThrow(expect.objectContaining({ code: "weak_passphrase" }));
    await expect(k.initialize(PASS, "AAAA")).rejects.toThrow(expect.objectContaining({ code: "bad_salt" }));
    await k.initialize(PASS);
    expect(existsSync(path)).toBe(true);
    await expect(k.initialize(PASS)).rejects.toThrow(expect.objectContaining({ code: "already_initialized" }));
  });

  it("emits lock/unlock events", async () => {
    const seen: string[] = [];
    const k = ks({ onEvent: (t) => seen.push(t) });
    await k.initialize(PASS);
    k.lock();
    await k.unlock(PASS);
    expect(seen).toEqual(["keystore.initialized", "keystore.locked", "keystore.unlocked"]);
  });
  it("a UI lock keeps the key in memory (ingest continues) and still needs the passphrase to leave", async () => {
    const seen: Array<[string, Record<string, unknown>]> = [];
    const k = ks({ onEvent: (t, d) => seen.push([t, d]) });
    await k.initialize(PASS);
    const before = toHex(k.secretKey());
    k.lock();
    expect(k.state()).toBe("locked");
    expect(k.status()).toMatchObject({ state: "locked", locked: true, uiLocked: true, keyInMemory: true });
    expect(k.isUnlocked()).toBe(true); // ingest still has the key
    expect(k.contentUnlocked()).toBe(false);
    expect(toHex(k.secretKey())).toBe(before);
    await expect(k.unlock("wrong passphrase")).rejects.toThrow(expect.objectContaining({ code: "wrong_passphrase" }));
    expect(k.isUiLocked()).toBe(true);
    await k.unlock(PASS);
    expect(k.status()).toMatchObject({ state: "unlocked", locked: false, uiLocked: false });
    expect(toHex(k.secretKey())).toBe(before);
    // a full lock on top of a UI lock drops the key
    k.lock();
    const held = k.secretKey();
    k.lock("manual", { full: true });
    expect(held.every((b) => b === 0)).toBe(true);
    expect(k.status()).toMatchObject({ locked: true, uiLocked: false, keyInMemory: false });
    expect(seen.filter(([t]) => t === "keystore.locked").map(([, d]) => d.full)).toEqual([false, false, true]);
    expect(seen.filter(([t]) => t === "keystore.unlocked").map(([, d]) => d.fromUiLock)).toEqual([true]);
  });

  it("auto-lock performs a UI lock by default and a full lock with autoLockMode full", async () => {
    const k = ks({ autoLockMinutes: 1 });
    await k.initialize(PASS);
    expect(k.getAutoLockMode()).toBe("ui");
    clock += 61_000;
    expect(k.checkIdle()).toBe(true);
    expect(k.status()).toMatchObject({ uiLocked: true, keyInMemory: true, lockReason: "idle" });
    expect(k.checkIdle()).toBe(false); // already UI-locked
    k.setAutoLockMode("full");
    expect(k.checkIdle()).toBe(true); // escalates to a full lock
    expect(k.status()).toMatchObject({ keyInMemory: false, uiLocked: false });
    expect(() => k.setAutoLockMode("sometimes" as never)).toThrow();
  });

  it("Argon2id runs off the main thread: timers keep firing during an unlock", async () => {
    const k = ks();
    await k.initialize(PASS);
    k.lock("manual", { full: true });
    let ticks = 0;
    const t = setInterval(() => ticks++, 10);
    const t0 = Date.now();
    await k.unlock(PASS);
    const ms = Date.now() - t0;
    clearInterval(t);
    expect(k.isUnlocked()).toBe(true);
    // a derivation that blocked the loop would let at most one tick through
    expect(ticks).toBeGreaterThanOrEqual(Math.min(5, Math.floor(ms / 10) - 5));
    expect(ticks).toBeGreaterThan(3);
  });

  it("concurrent unlocks share one derivation at a time and both succeed", async () => {
    const k = ks();
    await k.initialize(PASS);
    k.lock("manual", { full: true });
    const [a, b] = await Promise.all([k.unlock(PASS), k.unlock(PASS)]);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(k.isUnlocked()).toBe(true);
  });
});
