using System.Text.Json;
using System.Text.Json.Nodes;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Tests.Support;

namespace Ivy.Core.Tests;

/// <summary>Reproduces every file in docs/test-vectors byte-for-byte (PROTOCOL.md §9).</summary>
public class VectorTests
{
    private static JsonElement Load(string name) => JsonDocument.Parse(File.ReadAllText(TestPaths.Vector(name))).RootElement;
    private static byte[] Hex(JsonElement e, string prop) => Bytes.FromHex(e.GetProperty(prop).GetString()!);
    private static string Str(JsonElement e, string prop) => e.GetProperty(prop).GetString()!;

    [Fact]
    public void Every_vector_file_is_covered()
    {
        var files = Directory.GetFiles(TestPaths.VectorsDir, "*.json").Select(Path.GetFileName).OrderBy(f => f).ToArray();
        Assert.Equal(new[] { "argon2id.json", "envelope-chunked.json", "envelope-single.json", "keys.json", "pairing.json" }, files);
    }

    [Fact]
    public void Keys_public_key_and_fingerprint()
    {
        var v = Load("keys.json");
        var pub = X25519.PublicKeyFromSecret(Hex(v, "macSecretKeyHex"));
        Assert.Equal(Str(v, "macPublicKeyHex"), Bytes.ToHex(pub));
        Assert.Equal(Str(v, "macPublicKeyB64"), Bytes.ToBase64(pub));
        Assert.Equal(Str(v, "fingerprint"), Fingerprint.Of(pub));
        Assert.Equal("CF0A-77FB-0DA6-ACE6", Fingerprint.OfBase64(Str(v, "macPublicKeyB64")));
    }

    [Fact(Skip = "Argon2id is not implemented on Windows by design: device keys are random X25519 keys (PROTOCOL.md §3.2); only the Mac derives keys from a passphrase.")]
    public void Argon2id_passphrase_keypair()
    {
    }

    [Fact]
    public void Argon2id_vector_public_half_is_consistent()
    {
        // The X25519 + fingerprint half of argon2id.json needs no Argon2id: secret -> public -> fingerprint.
        var v = Load("argon2id.json");
        var pub = X25519.PublicKeyFromSecret(Hex(v, "derivedSecretKeyHex"));
        Assert.Equal(Str(v, "derivedPublicKeyHex"), Bytes.ToHex(pub));
        Assert.Equal(Str(v, "fingerprint"), Fingerprint.Of(pub));
    }

    [Fact]
    public void Envelope_single_reproduces_envelopeHex()
    {
        var v = Load("envelope-single.json");
        var inputs = v.GetProperty("inputs");
        var kind = Kinds.FromWireName(Str(v, "kind"));
        var plaintext = Hex(v, "plaintextHex");
        Assert.Equal(Str(v, "plaintextUtf8"), Bytes.Utf8.GetString(plaintext));
        Assert.Equal(Str(inputs, "ephemeralPublicKeyHex"), Bytes.ToHex(X25519.PublicKeyFromSecret(Hex(inputs, "ephemeralSecretKeyHex"))));

        var env = Envelope.Encrypt(Hex(v, "recipientPublicKeyHex"), kind, Str(v, "objectKey"), plaintext, new EnvelopeTestInputs(
            Hex(inputs, "ephemeralSecretKeyHex"), Hex(inputs, "contentKeyHex"), Hex(inputs, "wrapNonceHex"), Hex(inputs, "bodyNonceHex")));
        Assert.Equal(Str(v, "envelopeHex"), Bytes.ToHex(env));
        Assert.Equal(Envelope.SizeFor(plaintext.Length), env.Length);

        var dec = Envelope.Decrypt(Hex(v, "recipientSecretKeyHex"), Str(v, "objectKey"), Hex(v, "envelopeHex"), kind);
        Assert.Equal(kind, dec.Kind);
        Assert.Equal(plaintext, dec.Plaintext);
    }

    [Fact]
    public void Envelope_single_objectKey_oid_matches_reference_makeOid()
    {
        // gen-vectors.ts: OID1 = makeOid(1_760_000_000_000, 00..01); objectKey = upKey("file_meta", OID1)
        var oid = Oids.Make(1_760_000_000_000, Bytes.FromHex("00000000000000000001"));
        Assert.Equal(Str(Load("envelope-single.json"), "objectKey"), ObjectKeys.Up(Kind.FileMeta, oid));
        Assert.Equal(1_760_000_000_000, Oids.TimestampMs(oid));
    }

    [Fact]
    public void Envelope_chunked_reproduces_parts_and_manifest()
    {
        var v = Load("envelope-chunked.json");
        var inputs = v.GetProperty("inputs");
        var oid = Str(v, "oid");
        // gen-vectors.ts: OID2 = makeOid(1_760_000_111_000, 00..02)
        Assert.Equal(oid, Oids.Make(1_760_000_111_000, Bytes.FromHex("00000000000000000002")));
        var plaintext = Enumerable.Range(0, v.GetProperty("plaintextLen").GetInt32()).Select(i => (byte)(i % 256)).ToArray();

        var result = Chunked.Encrypt(Hex(v, "recipientPublicKeyHex"), oid, Hex(v, "objectIdHex"), Kinds.FromWireName(Str(v, "payloadKind")),
            plaintext, v.GetProperty("chunkSize").GetInt32(), new ChunkedTestInputs(
                Hex(inputs, "objectContentKeyHex"), Hex(inputs, "manifestEphemeralSecretKeyHex"), Hex(inputs, "manifestContentKeyHex"),
                Hex(inputs, "manifestWrapNonceHex"), Hex(inputs, "manifestBodyNonceHex")));

        var parts = v.GetProperty("parts").EnumerateArray().ToList();
        Assert.Equal(parts.Count, result.Parts.Count);
        for (var i = 0; i < parts.Count; i++)
        {
            Assert.Equal(parts[i].GetProperty("index").GetInt32(), result.Parts[i].Index);
            Assert.Equal(Str(parts[i], "key"), result.Parts[i].ObjectKey);
            Assert.Equal(Str(parts[i], "bytesHex"), Bytes.ToHex(result.Parts[i].Bytes));
        }

        // The manifest JSON is byte-identical to the reference's JSON.stringify.
        Assert.Equal(v.GetProperty("manifest").GetRawText().Replace(" ", "").Replace("\n", "").Replace("\r", ""),
            IvyJson.Serialize(result.Manifest));
        Assert.True(JsonNode.DeepEquals(JsonNode.Parse(v.GetProperty("manifest").GetRawText()), JsonNode.Parse(IvyJson.Serialize(result.Manifest))));
        Assert.Equal(Str(v, "manifestKey"), result.ManifestKey);
        Assert.Equal(Str(v, "manifestEnvelopeHex"), Bytes.ToHex(result.ManifestEnvelope));

        var decrypted = Chunked.Decrypt(Hex(v, "recipientSecretKeyHex"), Str(v, "manifestKey"), Hex(v, "manifestEnvelopeHex"),
            parts.ToDictionary(p => p.GetProperty("index").GetInt32(), p => Hex(p, "bytesHex")));
        Assert.Equal(plaintext, decrypted.Plaintext);
        Assert.Equal("screenshot", decrypted.Manifest.PayloadKind);
    }

    [Fact]
    public void Pairing_string_decodes_and_reencodes()
    {
        var v = Load("pairing.json");
        var expected = v.GetProperty("pairingPayload");
        var s = Str(v, "pairingString");
        var notExpired = DateTimeOffset.FromUnixTimeMilliseconds(expected.GetProperty("exp").GetInt64() - 1000);

        var p = PairingCodec.Decode(s, notExpired);
        Assert.Equal(1, p.V);
        Assert.Equal(Str(expected, "r2Endpoint"), p.R2Endpoint);
        Assert.Equal(Str(expected, "role"), p.Role);
        Assert.Equal(Str(expected, "cmdBucket"), p.CmdBucket);
        Assert.Equal(Str(expected, "upBucket"), p.UpBucket);
        Assert.Equal(Str(expected, "cmdReadToken"), p.CmdReadToken);
        Assert.Equal(Str(expected, "macPublicKey"), p.MacPublicKey);
        Assert.Equal(Str(expected, "macFingerprint"), p.MacFingerprint);
        Assert.Equal(Str(expected, "pairingId"), p.PairingId);
        Assert.Equal(Str(expected, "secret"), p.Secret);
        Assert.Equal(expected.GetProperty("exp").GetInt64(), p.Exp);
        Assert.Equal(Bytes.FromHex(Str(v.GetProperty("bootstrapInputs"), "secretHex")), Bytes.FromBase64(p.Secret));

        PairingCodec.VerifyMacFingerprint(p);
        Assert.Equal(s, PairingCodec.Encode(p));

        var expired = DateTimeOffset.FromUnixTimeMilliseconds(p.Exp + 1);
        Assert.Throws<PairingException>(() => PairingCodec.Decode(s, expired));
    }

    [Fact]
    public void Pairing_sealed_bootstrap_reproduces_and_unseals()
    {
        var v = Load("pairing.json");
        var inputs = v.GetProperty("bootstrapInputs");
        var plain = v.GetProperty("bootstrapPlaintext");
        var secret = Hex(inputs, "secretHex");
        var payload = new BootstrapPayload
        {
            UpBucket = Str(plain, "upBucket"),
            UpWriteToken = Str(plain, "upWriteToken"),
            PairingId = Str(plain, "pairingId"),
        };
        var expected = v.GetProperty("sealedBootstrap");

        var sealedBootstrap = PairingCodec.SealBootstrap(payload, secret, Hex(inputs, "nonceHex"));
        Assert.Equal(1, sealedBootstrap.V);
        Assert.Equal(Str(expected, "nonce"), sealedBootstrap.Nonce);
        Assert.Equal(Str(expected, "ct"), sealedBootstrap.Ct);

        var fromVector = IvyJson.Deserialize<SealedBootstrap>(expected.GetRawText());
        var opened = PairingCodec.OpenBootstrap(fromVector, secret, payload.PairingId);
        Assert.Equal(payload, opened);

        var wrongSecret = (byte[])secret.Clone();
        wrongSecret[0] ^= 1;
        Assert.Throws<PairingException>(() => PairingCodec.OpenBootstrap(fromVector, wrongSecret, payload.PairingId));
        Assert.Throws<PairingException>(() => PairingCodec.OpenBootstrap(fromVector, secret, "ffffffffffffffffffffffffffffffff"));
    }
}
