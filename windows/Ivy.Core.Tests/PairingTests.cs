using Ivy.Core.Agent;
using Ivy.Core.KeyStore;
using Ivy.Core.Protocol;
using Ivy.Core.Records;
using Ivy.Core.Tests.Support;
using Microsoft.Extensions.Time.Testing;

namespace Ivy.Core.Tests;

public class PairingServiceTests : IDisposable
{
    private readonly TempDir _dir = new();
    private readonly MacSim _mac = new();
    private readonly FakeBucketServer _server = new();
    private readonly FakeTimeProvider _time = new(DateTimeOffset.Parse("2026-10-10T12:00:00Z"));
    public void Dispose() => _dir.Dispose();

    private (string PairingString, byte[] Secret, string PairingId) MacPrepares(string role = "windows", bool writeBootstrap = true, long? exp = null, string? fingerprint = null)
    {
        var secret = SystemRandomSource.Instance.Bytes(32);
        var pairingId = Bytes.ToHex(SystemRandomSource.Instance.Bytes(16));
        if (writeBootstrap)
        {
            var sealedBootstrap = PairingCodec.SealBootstrap(new BootstrapPayload { UpBucket = "ivy-up-windows", UpWriteToken = "up-key:up-secret", PairingId = pairingId }, secret);
            _server.Cmd[ObjectKeys.PairingBootstrap(pairingId)] = IvyJson.SerializeToUtf8(sealedBootstrap);
        }
        var payload = new PairingPayload
        {
            R2Endpoint = "http://127.0.0.1:1", Role = role, CmdBucket = "ivy-cmd-windows", UpBucket = "ivy-up-windows",
            CmdReadToken = "cmd-key:cmd-secret", MacPublicKey = _mac.PublicKeyB64, MacFingerprint = fingerprint ?? _mac.Fingerprint,
            PairingId = pairingId, Secret = Bytes.ToBase64(secret), Exp = exp ?? _time.GetUtcNow().AddMinutes(10).ToUnixTimeMilliseconds(),
        };
        return (PairingCodec.Encode(payload), secret, pairingId);
    }

    [Fact]
    public async Task Pairs_and_writes_device_object_wrapped_to_mac()
    {
        var keys = new FileKeyStore(_dir.Path);
        var factory = new FakeR2Factory(_server);
        var svc = new PairingService(keys, factory, _time);
        string? shown = null;
        svc.DeviceFingerprintAvailable += (_, fp) => shown = fp;
        var (s, _, pairingId) = MacPrepares();

        var result = await svc.PairAsync(s);

        Assert.True(svc.IsPaired);
        Assert.Equal(result.DeviceFingerprint, shown);
        Assert.Equal(_mac.Fingerprint, result.MacFingerprint);
        // tokens went to the right clients only
        Assert.Equal(new[] { ("cmd", "ivy-cmd-windows", "cmd-key"), ("up", "ivy-up-windows", "up-key") }, factory.Created);
        // the Mac decrypts pair/<id>/device
        var key = ObjectKeys.PairingDevice(pairingId);
        var rec = RecordJson.Parse<PairingDeviceRecord>(_mac.Open(key, _server.Up[key], Kind.PairingDevice));
        Assert.Equal(pairingId, rec.PairingId);
        Assert.Equal("windows", rec.Role);
        Assert.Equal(result.DeviceFingerprint, rec.Fingerprint);
        Assert.Equal(Fingerprint.OfBase64(rec.PublicKey), rec.Fingerprint);
        Assert.Equal(Bytes.FromBase64(rec.PublicKey), X25519.PublicKeyFromSecret(keys.LoadSecretKey()));
        var state = keys.LoadPairingState()!;
        Assert.Equal(result.DeviceId, state.DeviceId);
        Assert.Equal(rec.DeviceId, state.DeviceId);
        Assert.Equal(_mac.PublicKeyB64, state.MacPublicKey);
        Assert.Equal("up-key:up-secret", keys.LoadCredentials()!.UpWriteToken);
    }

    [Fact]
    public async Task Rejects_expired_wrong_fingerprint_wrong_role_and_missing_bootstrap()
    {
        var keys = new FileKeyStore(_dir.Path);
        var svc = new PairingService(keys, new FakeR2Factory(_server), _time);
        var other = new MacSim();
        await Assert.ThrowsAsync<PairingException>(() => svc.PairAsync(MacPrepares(exp: _time.GetUtcNow().AddSeconds(-1).ToUnixTimeMilliseconds()).PairingString));
        await Assert.ThrowsAsync<PairingException>(() => svc.PairAsync(MacPrepares(fingerprint: other.Fingerprint).PairingString));
        await Assert.ThrowsAsync<PairingException>(() => svc.PairAsync(MacPrepares(role: "android").PairingString));
        await Assert.ThrowsAsync<PairingException>(() => svc.PairAsync(MacPrepares(writeBootstrap: false).PairingString));
        await Assert.ThrowsAsync<PairingException>(() => svc.PairAsync("IVYPAIR2.abc"));
        await Assert.ThrowsAsync<PairingException>(() => svc.PairAsync("IVYPAIR1.!!!"));
        // tampered bootstrap
        var (s, _, id) = MacPrepares();
        var b = _server.Cmd[ObjectKeys.PairingBootstrap(id)];
        var sealedBootstrap = IvyJson.Deserialize<SealedBootstrap>(b);
        var ct = Bytes.FromBase64(sealedBootstrap.Ct);
        ct[3] ^= 1;
        _server.Cmd[ObjectKeys.PairingBootstrap(id)] = IvyJson.SerializeToUtf8(sealedBootstrap with { Ct = Bytes.ToBase64(ct) });
        await Assert.ThrowsAsync<PairingException>(() => svc.PairAsync(s));
        Assert.False(svc.IsPaired);
        Assert.Empty(_server.Up);
    }

    [Fact]
    public async Task Failed_device_upload_persists_nothing()
    {
        var keys = new FileKeyStore(_dir.Path);
        var failing = new FailingUpFactory(_server);
        var svc = new PairingService(keys, failing, _time);
        await Assert.ThrowsAsync<HttpRequestException>(() => svc.PairAsync(MacPrepares().PairingString));
        Assert.False(keys.HasSecretKey);
        Assert.Null(keys.LoadPairingState());
    }

    private sealed class FailingUpFactory : Ivy.Core.R2.IR2ClientFactory
    {
        private readonly FakeBucketServer _s;
        public FailingUpFactory(FakeBucketServer s) => _s = s;
        public Ivy.Core.R2.IUpBucketClient CreateUpClient(Ivy.Core.R2.R2Endpoint e, string b, Ivy.Core.R2.ScopedToken t) =>
            new FakeUpClient(_s) { BeforePut = _ => throw new HttpRequestException("offline") };
        public Ivy.Core.R2.ICmdBucketClient CreateCmdClient(Ivy.Core.R2.R2Endpoint e, string b, Ivy.Core.R2.ScopedToken t) => new FakeCmdClient(_s);
    }

    [Fact]
    public void Token_separation_is_structural()
    {
        var upMembers = typeof(Ivy.Core.R2.IUpBucketClient).GetMethods().Select(m => m.Name).ToList();
        var cmdMembers = typeof(Ivy.Core.R2.ICmdBucketClient).GetMethods().Select(m => m.Name).ToList();
        Assert.DoesNotContain(upMembers, n => n.Contains("Get") || n.Contains("List") || n.Contains("Delete") || n.Contains("Head"));
        Assert.DoesNotContain(cmdMembers, n => n.Contains("Put") || n.Contains("Upload") || n.Contains("Delete") || n.Contains("Multipart") || n.Contains("Write"));
        // each concrete client takes exactly one token
        foreach (var t in new[] { typeof(Ivy.Core.R2.S3UpBucketClient), typeof(Ivy.Core.R2.S3CmdBucketClient) })
            Assert.All(t.GetConstructors(), c => Assert.Single(c.GetParameters(), p => p.ParameterType == typeof(Ivy.Core.R2.ScopedToken)));
        Assert.Throws<FormatException>(() => Ivy.Core.R2.ScopedToken.Parse("CMD_READ_TOKEN_FIXED"));
        Assert.DoesNotContain("secret", Ivy.Core.R2.ScopedToken.Parse("id:secret").ToString());
    }
}
