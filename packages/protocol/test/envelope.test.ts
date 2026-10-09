import { describe, it, expect } from "vitest";
import {
  encryptEnvelope,
  decryptEnvelope,
  generateKeyPair,
  utf8,
  fromUtf8,
} from "../src/index.js";

const RECIPIENT = generateKeyPair();

function makeEnvelope(objectKey = "up/file/01HZZZ", kind = "file_meta" as const) {
  const plaintext = utf8("hello ivy — a secret record");
  const env = encryptEnvelope({
    recipientPublicKey: RECIPIENT.publicKey,
    kind,
    objectKey,
    plaintext,
  });
  return { env, plaintext, objectKey, kind };
}

describe("single-shot envelope", () => {
  it("round-trips", () => {
    const { env, plaintext, objectKey } = makeEnvelope();
    const out = decryptEnvelope({ recipientSecretKey: RECIPIENT.secretKey, objectKey, envelope: env });
    expect(out.kind).toBe("file_meta");
    expect(fromUtf8(out.plaintext)).toBe(fromUtf8(plaintext));
  });

  it("rejects a flipped byte in the header (ephemeral key region)", () => {
    const { env, objectKey } = makeEnvelope();
    const tampered = env.slice();
    tampered[10] ^= 0x01; // inside epk
    expect(() =>
      decryptEnvelope({ recipientSecretKey: RECIPIENT.secretKey, objectKey, envelope: tampered }),
    ).toThrow();
  });

  it("rejects a flipped byte in the ciphertext body", () => {
    const { env, objectKey } = makeEnvelope();
    const tampered = env.slice();
    tampered[tampered.length - 20] ^= 0x01;
    expect(() =>
      decryptEnvelope({ recipientSecretKey: RECIPIENT.secretKey, objectKey, envelope: tampered }),
    ).toThrow();
  });

  it("rejects the magic being corrupted", () => {
    const { env, objectKey } = makeEnvelope();
    const tampered = env.slice();
    tampered[0] ^= 0xff;
    expect(() =>
      decryptEnvelope({ recipientSecretKey: RECIPIENT.secretKey, objectKey, envelope: tampered }),
    ).toThrow(/magic/);
  });

  it("rejects replay under a different object key (AAD binding)", () => {
    const { env } = makeEnvelope("up/file/01HZZZ");
    expect(() =>
      decryptEnvelope({
        recipientSecretKey: RECIPIENT.secretKey,
        objectKey: "up/file/01OTHER",
        envelope: env,
      }),
    ).toThrow();
  });

  it("rejects relabelling under a different kind (expectedKind + AAD)", () => {
    const { env, objectKey } = makeEnvelope();
    // header still says file_meta; asserting screenshot must throw
    expect(() =>
      decryptEnvelope({
        recipientSecretKey: RECIPIENT.secretKey,
        objectKey,
        envelope: env,
        expectedKind: "screenshot",
      }),
    ).toThrow(/kind/);
  });

  it("rejects the wrong recipient", () => {
    const { env, objectKey } = makeEnvelope();
    const wrong = generateKeyPair();
    expect(() =>
      decryptEnvelope({ recipientSecretKey: wrong.secretKey, objectKey, envelope: env }),
    ).toThrow();
  });

  it("produces different ciphertext each time (fresh keys/nonces)", () => {
    const a = makeEnvelope().env;
    const b = makeEnvelope().env;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("leaks no plaintext bytes into the envelope", () => {
    const secret = "COLLABORATION-OFFER-ROBOTICS";
    const env = encryptEnvelope({
      recipientPublicKey: RECIPIENT.publicKey,
      kind: "file_meta",
      objectKey: "up/file/01HZZZ",
      plaintext: utf8(secret),
    });
    expect(Buffer.from(env).toString("latin1")).not.toContain(secret);
  });
});
