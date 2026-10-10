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
  it("starts uninitialized and refuses to hand out a key", () => {
    const k = ks();
    expect(k.state()).toBe("uninitialized");
    expect(() => k.secretKey()).toThrow(KeystoreError);
  });

  it("derives the identity from passphrase + stored salt with the protocol's Argon2id", () => {
    const k = ks();
    const r = k.initialize(PASS);
    expect(k.state()).toBe("unlocked");
    const f = JSON.parse(readFileSync(path, "utf8"));
    const kp = deriveMacKeyPair(PASS, fromBase64(f.salt));
    expect(toBase64(kp.publicKey)).toBe(f.publicKey);
    expect(r.fingerprint).toBe(fingerprint(kp.publicKey));
    expect(toHex(k.secretKey())).toBe(toHex(kp.secretKey));
    expect(f.kdf).toMatchObject({ memoryKiB: 65536, iterations: 3, parallelism: 1, saltLen: 16, outputLen: 32, variant: "argon2id", version: 19 });
  });

  it("reproduces the cross-port Argon2id vector (docs/test-vectors/argon2id.json)", () => {
    const k = ks();
    const r = k.initialize(vectors.passphrase, toBase64(fromHex(vectors.saltHex)));
    expect(r.restored).toBe(true);
    expect(toHex(k.secretKey())).toBe(vectors.derivedSecretKeyHex);
    expect(r.fingerprint).toBe(vectors.fingerprint);
  });

  it("never writes the private key in the clear (only the §3.3 sealed blob)", () => {
    const k = ks();
    k.initialize(PASS);
    const raw = readFileSync(path, "utf8");
    const sk = k.secretKey();
    expect(raw).not.toContain(toHex(sk));
    expect(raw).not.toContain(toBase64(sk));
    const f = JSON.parse(raw);
    expect(f.sealed).toMatchObject({ v: 1 });
    expect(Buffer.from(f.sealed.blob, "base64").subarray(0, 5).toString()).toBe("IVYK1");
    expect(f.sealed.salt).not.toBe(f.salt); // at-rest salt is independent of the identity salt
  });

  it("lock zeroes the in-memory key; unlock with the right passphrase restores the same identity", () => {
    const k = ks();
    const { fingerprint: fp } = k.initialize(PASS);
    const held = k.secretKey();
    k.lock();
    expect(k.state()).toBe("locked");
    expect(held.every((b) => b === 0)).toBe(true);
    expect(() => k.secretKey()).toThrow(/locked/);
    const k2 = ks(); // a fresh process
    expect(k2.state()).toBe("locked");
    expect(k2.unlock(PASS).fingerprint).toBe(fp);
  });

  it("rejects a wrong passphrase and stays locked", () => {
    const k = ks();
    k.initialize(PASS);
    k.lock();
    expect(() => k.unlock("not the passphrase")).toThrow(expect.objectContaining({ code: "wrong_passphrase" }));
    expect(k.state()).toBe("locked");
  });

  it("cools down after five wrong passphrases", () => {
    const k = ks();
    k.initialize(PASS);
    k.lock();
    for (let i = 0; i < 5; i++) expect(() => k.unlock("wrong wrong")).toThrow(expect.objectContaining({ code: "wrong_passphrase" }));
    expect(() => k.unlock(PASS)).toThrow(expect.objectContaining({ code: "cooldown" }));
    clock += 31_000;
    expect(k.unlock(PASS).fingerprint).toBeTruthy();
  });

  it("change passphrase re-seals the SAME key: devices stay paired", () => {
    const k = ks();
    const { fingerprint: fp } = k.initialize(PASS);
    const before = toHex(k.secretKey());
    k.changePassphrase(PASS, "a brand new passphrase");
    k.lock();
    expect(() => k.unlock(PASS)).toThrow(expect.objectContaining({ code: "wrong_passphrase" }));
    expect(k.unlock("a brand new passphrase").fingerprint).toBe(fp);
    expect(toHex(k.secretKey())).toBe(before);
    expect(JSON.parse(readFileSync(path, "utf8")).derivedFrom).toBe("original-passphrase");
  });

  it("change passphrase requires the current one", () => {
    const k = ks();
    k.initialize(PASS);
    expect(() => k.changePassphrase("nope nope nope", "another passphrase")).toThrow(expect.objectContaining({ code: "wrong_passphrase" }));
  });

  it("restores the identity from the salt file + same passphrase (re-pair after restore)", () => {
    const k = ks();
    const { fingerprint: fp } = k.initialize(PASS);
    const salt = JSON.parse(readFileSync(path, "utf8")).salt;
    const dir2 = tempDir("ivy-ks2-");
    try {
      const p2 = join(dir2, "identity.json");
      writeFileSync(p2, JSON.stringify({ v: 1, salt })); // only the backed-up salt
      const k2 = new Keystore({ path: p2, autoLockMinutes: 30 });
      expect(k2.state()).toBe("uninitialized");
      expect(k2.status().saltPresent).toBe(true);
      const r = k2.initialize(PASS);
      expect(r.restored).toBe(true);
      expect(r.fingerprint).toBe(fp);
      // a different passphrase with the same salt is a different identity
      const p3 = join(dir2, "other.json");
      writeFileSync(p3, JSON.stringify({ v: 1, salt }));
      expect(new Keystore({ path: p3, autoLockMinutes: 30 }).initialize("different passphrase").fingerprint).not.toBe(fp);
    } finally { rm(dir2); }
  });

  it("auto-locks after the idle period and activity postpones it", () => {
    const k = ks({ autoLockMinutes: 30 });
    k.initialize(PASS);
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

  it("auto-lock 0 means never", () => {
    const k = ks({ autoLockMinutes: 0 });
    k.initialize(PASS);
    clock += 365 * 86400_000;
    expect(k.checkIdle()).toBe(false);
    expect(k.isUnlocked()).toBe(true);
  });

  it("refuses weak passphrases, bad salts and a second initialize", () => {
    const k = ks();
    expect(() => k.initialize("short")).toThrow(expect.objectContaining({ code: "weak_passphrase" }));
    expect(() => k.initialize(PASS, "AAAA")).toThrow(expect.objectContaining({ code: "bad_salt" }));
    k.initialize(PASS);
    expect(existsSync(path)).toBe(true);
    expect(() => k.initialize(PASS)).toThrow(expect.objectContaining({ code: "already_initialized" }));
  });

  it("emits lock/unlock events", () => {
    const seen: string[] = [];
    const k = ks({ onEvent: (t) => seen.push(t) });
    k.initialize(PASS);
    k.lock();
    k.unlock(PASS);
    expect(seen).toEqual(["keystore.initialized", "keystore.locked", "keystore.unlocked"]);
  });
});
