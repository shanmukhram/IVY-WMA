using Ivy.Core.Protocol;

namespace Ivy.App.Core;

/// <summary>A pairing failure as the pairing page shows it: what went wrong, inline under the field, and how to fix it.</summary>
public sealed record PairingError(string Message, string Hint);

/// <summary>
/// Maps pairing failures (<see cref="PairingException"/> messages from PairingCodec/PairingService, or transport
/// errors) to a plain sentence and a fix hint. The raw reason stays in the status line and the log.
/// </summary>
public static class PairingErrors
{
    public const string FreshStringHint = "On the Mac, add the Windows device again and paste the new pairing string.";

    public static PairingError Empty() =>
        new("Paste the pairing string first.", "On the Mac, add a Windows device, copy the pairing string and paste it here.");

    public static PairingError Describe(Exception e)
    {
        if (e is not PairingException) return Transport(e);
        var m = e.Message;
        bool Has(string s) => m.Contains(s, StringComparison.OrdinalIgnoreCase);

        if (Has("not an IVY pairing string") || Has("malformed pairing string") || Has("not base64") || Has("is malformed") || Has("must be 32 bytes"))
            return new("That is not a complete IVY pairing string.",
                "Copy the whole string from the Mac (it starts with IVYPAIR1.) and paste it again. Line breaks are fine.");
        if (Has("expired"))
            return new("This pairing string has expired.", "Pairing strings are short-lived. " + FreshStringHint);
        if (Has("not found"))
            return new("This pairing string was already used, or the Mac has not finished preparing it.",
                "Wait a few seconds and press Pair again. If it still fails: " + FreshStringHint);
        if (Has("role"))
            return new("This pairing string is for a different kind of device.", "On the Mac, choose to add a Windows device, then paste that string.");
        if (Has("unsupported"))
            return new("This pairing string comes from a different IVY version.", "Update IVY on the Mac and on this PC so they match, then pair again.");
        if (Has("authentication failed") || Has("mismatch") || Has("does not match"))
            return new("The pairing string does not match what the Mac prepared.", FreshStringHint);
        return new("Pairing failed: " + m, FreshStringHint);
    }

    private static PairingError Transport(Exception e) => e switch
    {
        HttpRequestException or IOException or TimeoutException or TaskCanceledException =>
            new("Could not reach the IVY bucket.", "Check this PC's internet connection (and any proxy or firewall), then press Pair again."),
        _ => new("Pairing failed: " + e.GetType().Name + ": " + e.Message, FreshStringHint),
    };
}
