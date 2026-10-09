using System.Globalization;

namespace Ivy.Core.Protocol;

public enum KeyArea { Up, Cmd, Pair }

public sealed record ParsedKey(KeyArea Area, Kind? Kind = null, string? Oid = null, string? PairingId = null,
    bool IsManifest = false, int? ChunkIndex = null);

/// <summary>Object-key builders and parser (PROTOCOL.md §4).</summary>
public static class ObjectKeys
{
    public const int ChunkIndexPad = 8;

    /// <summary><c>up/&lt;prefix&gt;/&lt;oid&gt;</c> for a capture record kind.</summary>
    public static string Up(Kind kind, string oid)
    {
        if (kind is Kind.Manifest or Kind.BlobChunk or Kind.PairingDevice or Kind.Command)
            throw new ArgumentException($"use the dedicated builder for kind {kind.WireName()}", nameof(kind));
        return $"up/{kind.Prefix()}/{oid}";
    }

    /// <summary>The prefix (<c>up/&lt;prefix&gt;</c>) under which records of <paramref name="kind"/> live.</summary>
    public static string UpPrefix(Kind kind)
    {
        if (kind is Kind.Manifest or Kind.BlobChunk or Kind.PairingDevice or Kind.Command)
            throw new ArgumentException($"kind {kind.WireName()} has no record prefix", nameof(kind));
        return $"up/{kind.Prefix()}";
    }

    public static string BlobManifest(string oid) => $"up/blob/{oid}/manifest";

    public static string BlobChunk(string oid, int index)
    {
        if (index < 0) throw new ArgumentOutOfRangeException(nameof(index));
        return $"up/blob/{oid}/p/{index.ToString(CultureInfo.InvariantCulture).PadLeft(ChunkIndexPad, '0')}";
    }

    public static string CommandStatus(string oid) => $"up/cstat/{oid}";
    public static string DeviceReport(string oid) => $"up/status/{oid}";
    public static string PairingDevice(string pairingId) => $"pair/{pairingId}/device";
    public static string Command(string oid) => $"cmd/{oid}";
    public static string PairingBootstrap(string pairingId) => $"pair/{pairingId}";

    public const string CommandPrefix = "cmd/";

    public static ParsedKey Parse(string key)
    {
        var parts = key.Split('/');
        if (parts[0] == "pair")
        {
            if (parts.Length == 2 && parts[1].Length > 0) return new ParsedKey(KeyArea.Pair, PairingId: parts[1]);
            if (parts.Length == 3 && parts[1].Length > 0 && parts[2] == "device")
                return new ParsedKey(KeyArea.Pair, Kind.PairingDevice, PairingId: parts[1]);
            throw new FormatException($"unrecognised pair key: {key}");
        }
        if (parts[0] == "cmd" && parts.Length == 2 && parts[1].Length > 0)
            return new ParsedKey(KeyArea.Cmd, Kind.Command, Oid: parts[1]);
        if (parts[0] == "up" && parts.Length >= 3)
        {
            if (parts[1] == "blob")
            {
                var oid = parts[2];
                if (parts.Length == 4 && parts[3] == "manifest")
                    return new ParsedKey(KeyArea.Up, Kind.Manifest, oid, IsManifest: true);
                if (parts.Length == 5 && parts[3] == "p" &&
                    int.TryParse(parts[4], NumberStyles.None, CultureInfo.InvariantCulture, out var idx))
                    return new ParsedKey(KeyArea.Up, Kind.BlobChunk, oid, ChunkIndex: idx);
                throw new FormatException($"unrecognised blob key: {key}");
            }
            var kind = Kinds.FromRecordPrefix(parts[1]);
            if (kind is not null && parts.Length == 3 && parts[2].Length > 0)
                return new ParsedKey(KeyArea.Up, kind, parts[2]);
        }
        throw new FormatException($"unrecognised object key: {key}");
    }
}
