import { describe, it, expect } from "vitest";
import {
  deriveMacKeyPair,
  generateMacSalt,
  sealPrivateKey,
  openPrivateKey,
  fingerprint,
  generateKeyPair,
  newPairingSecret,
  newPairingId,
  encodePairingString,
  decodePairingString,
  encryptPairingBootstrap,
  decryptPairingBootstrap,
  fingerprintFromB64,
  toBase64,
  fromBase64,
  type PairingPayload,
  type BootstrapPayload,
} from "../src/index.js";

describe("passphrase-derived Mac keypair", () => {
  it("is deterministic in passphrase + salt", () => {
    const salt = generateMacSalt();
    const a = deriveMacKeyPair("correct horse battery staple", salt);
    const b = deriveMacKeyPair("correct horse battery staple", salt);
    expect(Buffer.from(a.secretKey).equals(Buffer.from(b.secretKey))).toBe(true);
    expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(true);
  });

  it("changes with the passphrase and with the salt", () => {
    const salt1 = generateMacSalt();
    const salt2 = generateMacSalt();
    const a = deriveMacKeyPair("pass-one", salt1);
    const b = deriveMacKeyPair("pass-two", salt1);
    const c = deriveMacKeyPair("pass-one", salt2);
    expect(Buffer.from(a.publicKey).equals(Buffer.from(b.publicKey))).toBe(false);
    expect(Buffer.from(a.publicKey).equals(Buffer.from(c.publicKey))).toBe(false);
  });

  it("re-pairing after restore reproduces the identity", () => {
    const salt = generateMacSalt();
    const original = deriveMacKeyPair("vault passphrase", salt);
    // simulate restore: only passphrase + salt survive
    const restored = deriveMacKeyPair("vault passphrase", salt);
    expect(fingerprint(original.publicKey)).toBe(fingerprint(restored.publicKey));
  });
});

describe("private key at rest", () => {
  it("round-trips and never stores the key in the clear", () => {
    const kp = generateKeyPair();
    const sealed = sealPrivateKey(kp.secretKey, "pw");
    expect(JSON.stringify(sealed)).not.toContain(Buffer.from(kp.secretKey).toString("base64"));
    const opened = openPrivateKey(sealed, "pw");
    expect(Buffer.from(opened).equals(Buffer.from(kp.secretKey))).toBe(true);
  });

  it("rejects the wrong passphrase", () => {
    const kp = generateKeyPair();
    const sealed = sealPrivateKey(kp.secretKey, "pw");
    expect(() => openPrivateKey(sealed, "wrong")).toThrow();
  });
});

describe("fingerprint", () => {
  it("is stable, grouped, and matches the base64 helper", () => {
    const kp = generateKeyPair();
    const fp = fingerprint(kp.publicKey);
    expect(fp).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(fingerprintFromB64(toBase64(kp.publicKey))).toBe(fp);
  });
});

describe("pairing", () => {
  const mac = generateKeyPair();

  function payload(exp: number): PairingPayload {
    return {
      v: 1,
      r2Endpoint: "https://acct.r2.cloudflarestorage.com",
      role: "windows",
      cmdBucket: "ivy-cmd-windows",
      upBucket: "ivy-up-windows",
      cmdReadToken: "cmd-read-token-xyz",
      macPublicKey: toBase64(mac.publicKey),
      macFingerprint: fingerprint(mac.publicKey),
      pairingId: newPairingId(),
      secret: toBase64(newPairingSecret()),
      exp,
    };
  }

  it("encodes and decodes a pairing string", () => {
    const p = payload(Date.now() + 60_000);
    const s = encodePairingString(p);
    expect(s.startsWith("IVYPAIR1.")).toBe(true);
    const back = decodePairingString(s, { now: Date.now() });
    expect(back).toEqual(p);
    // the device verifies the fingerprint matches the embedded key
    expect(fingerprintFromB64(back.macPublicKey)).toBe(back.macFingerprint);
  });

  it("rejects an expired pairing string", () => {
    const p = payload(1000);
    const s = encodePairingString(p);
    expect(() => decodePairingString(s, { now: 2000 })).toThrow(/expired/);
  });

  it("bootstrap: Mac seals the up-write token to the secret; device opens it", () => {
    const p = payload(Date.now() + 60_000);
    const secret = fromBase64(p.secret);
    const boot: BootstrapPayload = {
      v: 1,
      upBucket: p.upBucket,
      upWriteToken: "up-write-token-abc",
      pairingId: p.pairingId,
    };
    const sealed = encryptPairingBootstrap(boot, secret);
    expect(JSON.stringify(sealed)).not.toContain("up-write-token-abc");
    const opened = decryptPairingBootstrap(sealed, secret, p.pairingId);
    expect(opened.upWriteToken).toBe("up-write-token-abc");
  });

  it("bootstrap rejects a wrong secret", () => {
    const p = payload(Date.now() + 60_000);
    const boot: BootstrapPayload = {
      v: 1, upBucket: p.upBucket, upWriteToken: "t", pairingId: p.pairingId,
    };
    const sealed = encryptPairingBootstrap(boot, fromBase64(p.secret));
    expect(() => decryptPairingBootstrap(sealed, newPairingSecret(), p.pairingId)).toThrow();
  });
});
