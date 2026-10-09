namespace Ivy.Core.Protocol;

/// <summary>Record kinds (PROTOCOL.md §5). The numeric value is the AAD kind id byte. Append-only.</summary>
public enum Kind : byte
{
    FileMeta = 0x01,
    Screenshot = 0x02,
    UsageEvent = 0x03,
    WindowsNotification = 0x04,
    AndroidNotification = 0x05,
    Call = 0x06,
    MessageBatch = 0x07,
    Manifest = 0x08,
    BlobChunk = 0x09,
    Command = 0x0a,
    CommandStatus = 0x0b,
    DeviceReport = 0x0c,
    PairingDevice = 0x0d,
}

public static class Kinds
{
    private static readonly (Kind Kind, string Name, string Prefix)[] Table =
    {
        (Kind.FileMeta, "file_meta", "file"),
        (Kind.Screenshot, "screenshot", "scr"),
        (Kind.UsageEvent, "usage_event", "usg"),
        (Kind.WindowsNotification, "windows_notification", "wnotif"),
        (Kind.AndroidNotification, "android_notification", "anotif"),
        (Kind.Call, "call", "call"),
        (Kind.MessageBatch, "message_batch", "msg"),
        (Kind.Manifest, "manifest", "blob"),
        (Kind.BlobChunk, "blob_chunk", "blob"),
        (Kind.Command, "command", "cmd"),
        (Kind.CommandStatus, "command_status", "cstat"),
        (Kind.DeviceReport, "device_report", "status"),
        (Kind.PairingDevice, "pairing_device", "pair"),
    };

    public static byte Id(this Kind kind) => (byte)kind;

    /// <summary>Wire name, e.g. <c>file_meta</c>.</summary>
    public static string WireName(this Kind kind)
    {
        foreach (var t in Table) if (t.Kind == kind) return t.Name;
        throw new ArgumentOutOfRangeException(nameof(kind), $"unknown kind {kind}");
    }

    /// <summary>Object-key prefix segment, e.g. <c>file</c>.</summary>
    public static string Prefix(this Kind kind)
    {
        foreach (var t in Table) if (t.Kind == kind) return t.Prefix;
        throw new ArgumentOutOfRangeException(nameof(kind), $"unknown kind {kind}");
    }

    public static Kind FromId(byte id)
    {
        foreach (var t in Table) if ((byte)t.Kind == id) return t.Kind;
        throw new IvyCryptoException($"unknown kind id 0x{id:x2}");
    }

    public static Kind FromWireName(string name)
    {
        foreach (var t in Table) if (t.Name == name) return t.Kind;
        throw new ArgumentException($"unknown kind '{name}'", nameof(name));
    }

    public static bool TryFromWireName(string name, out Kind kind)
    {
        foreach (var t in Table)
        {
            if (t.Name == name) { kind = t.Kind; return true; }
        }
        kind = default;
        return false;
    }

    /// <summary>Record kinds that live at <c>up/&lt;prefix&gt;/&lt;oid&gt;</c>.</summary>
    internal static Kind? FromRecordPrefix(string prefix) => prefix switch
    {
        "file" => Kind.FileMeta,
        "scr" => Kind.Screenshot,
        "usg" => Kind.UsageEvent,
        "wnotif" => Kind.WindowsNotification,
        "anotif" => Kind.AndroidNotification,
        "call" => Kind.Call,
        "msg" => Kind.MessageBatch,
        "cstat" => Kind.CommandStatus,
        "status" => Kind.DeviceReport,
        _ => null,
    };
}
