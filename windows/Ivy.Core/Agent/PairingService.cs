using System.Security.Cryptography;
using System.Text.Json;
using Ivy.Core.KeyStore;
using Ivy.Core.Protocol;
using Ivy.Core.R2;
using Ivy.Core.Records;
using Ivy.Core.Storage;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Ivy.Core.Agent;

public sealed record PairingResult(string DeviceId, string PairingId, string DeviceFingerprint, string MacFingerprint);

/// <summary>
/// Device side of pairing (PROTOCOL.md §7, PLAN decision 1): decode the pasted string, check version,
/// expiry and the Mac fingerprint, fetch <c>pair/&lt;id&gt;</c> with the cmd read token, open the bootstrap,
/// generate the device keypair into the key store, and write <c>pair/&lt;id&gt;/device</c> (wrapped to the Mac)
/// with the up write token. State is persisted only after the device object was accepted.
/// </summary>
public sealed class PairingService
{
    private readonly IDeviceKeyStore _keys;
    private readonly IR2ClientFactory _factory;
    private readonly TimeProvider _time;
    private readonly IRandomSource _random;
    private readonly ActivityLog? _activity;
    private readonly ILogger _logger;

    public PairingService(IDeviceKeyStore keys, IR2ClientFactory factory, TimeProvider? time = null, IRandomSource? random = null,
        ActivityLog? activity = null, ILogger<PairingService>? logger = null)
    {
        _keys = keys;
        _factory = factory;
        _time = time ?? TimeProvider.System;
        _random = random ?? SystemRandomSource.Instance;
        _activity = activity;
        _logger = (ILogger?)logger ?? NullLogger.Instance;
    }

    /// <summary>Role this device pairs as.</summary>
    public string Role { get; init; } = "windows";

    /// <summary>Raised with the device fingerprint as soon as the keypair exists, for the UI to display.</summary>
    public event EventHandler<string>? DeviceFingerprintAvailable;

    public bool IsPaired => _keys.HasSecretKey && _keys.LoadPairingState() is not null && _keys.LoadCredentials() is not null;

    public async Task<PairingResult> PairAsync(string pairingString, CancellationToken ct = default)
    {
        var payload = PairingCodec.Decode(pairingString, _time.GetUtcNow());
        if (payload.Role != Role) throw new PairingException($"pairing code is for role '{payload.Role}', this device is '{Role}'");
        var macPub = PairingCodec.VerifyMacFingerprint(payload);
        byte[] secret;
        try { secret = Bytes.FromBase64(payload.Secret); }
        catch (FormatException e) { throw new PairingException("pairing secret is not base64", e); }

        ScopedToken cmdToken;
        try { cmdToken = ScopedToken.Parse(payload.CmdReadToken); }
        catch (FormatException e) { throw new PairingException("cmd read token is malformed", e); }
        var endpoint = new R2Endpoint(payload.R2Endpoint);
        var cmd = _factory.CreateCmdClient(endpoint, payload.CmdBucket, cmdToken);

        BootstrapPayload bootstrap;
        try
        {
            var sealedBytes = await cmd.GetAsync(ObjectKeys.PairingBootstrap(payload.PairingId), ct).ConfigureAwait(false)
                              ?? throw new PairingException("pairing bootstrap not found (already used or not yet written)");
            SealedBootstrap sealedBootstrap;
            try { sealedBootstrap = IvyJson.Deserialize<SealedBootstrap>(sealedBytes); }
            catch (JsonException e) { throw new PairingException("pairing bootstrap is malformed", e); }
            bootstrap = PairingCodec.OpenBootstrap(sealedBootstrap, secret, payload.PairingId);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(secret);
            (cmd as IDisposable)?.Dispose();
        }
        if (bootstrap.UpBucket != payload.UpBucket) throw new PairingException("bootstrap up-bucket does not match the pairing code");

        ScopedToken upToken;
        try { upToken = ScopedToken.Parse(bootstrap.UpWriteToken); }
        catch (FormatException e) { throw new PairingException("up write token is malformed", e); }

        var (sk, pk) = X25519.GenerateKeyPair(_random);
        try
        {
            var deviceFp = Fingerprint.Of(pk);
            DeviceFingerprintAvailable?.Invoke(this, deviceFp);
            var deviceId = Guid.NewGuid().ToString();
            var now = IvyTime.Now(_time);
            var record = new PairingDeviceRecord
            {
                DeviceId = deviceId,
                EventTime = now,
                CaptureTime = now,
                Role = Role,
                PairingId = payload.PairingId,
                PublicKey = Bytes.ToBase64(pk),
                Fingerprint = deviceFp,
            };
            record.Validate();
            var key = ObjectKeys.PairingDevice(payload.PairingId);
            var json = IvyJson.SerializeToUtf8(record);
            byte[] envelope;
            try { envelope = Envelope.Encrypt(macPub, Kind.PairingDevice, key, json, _random); }
            finally { CryptographicOperations.ZeroMemory(json); }

            var up = _factory.CreateUpClient(endpoint, payload.UpBucket, upToken);
            try
            {
                using var ms = new MemoryStream(envelope, writable: false);
                await up.PutAsync(key, ms, envelope.Length, ct).ConfigureAwait(false);
            }
            finally { (up as IDisposable)?.Dispose(); }

            _keys.StoreSecretKey(sk);
            _keys.StoreCredentials(new DeviceCredentials { CmdReadToken = payload.CmdReadToken, UpWriteToken = bootstrap.UpWriteToken });
            _keys.StorePairingState(new PairingState
            {
                DeviceId = deviceId,
                Role = Role,
                PairingId = payload.PairingId,
                R2Endpoint = payload.R2Endpoint,
                UpBucket = payload.UpBucket,
                CmdBucket = payload.CmdBucket,
                MacPublicKey = payload.MacPublicKey,
                MacFingerprint = payload.MacFingerprint,
                DevicePublicKey = Bytes.ToBase64(pk),
                DeviceFingerprint = deviceFp,
                PairedAt = now,
            });
            _logger.LogInformation("paired as {DeviceId}; device fingerprint {Fingerprint}", deviceId, deviceFp);
            _activity?.Append(null, ActivityEvents.Paired, $"pairing {payload.PairingId} device {deviceFp} mac {payload.MacFingerprint}");
            return new PairingResult(deviceId, payload.PairingId, deviceFp, payload.MacFingerprint);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(sk);
        }
    }
}
