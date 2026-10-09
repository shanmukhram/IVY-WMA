using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ivy.Collectors.Files;

/// <summary>Per-volume USN position: journal id plus the next USN to read.</summary>
public sealed record UsnPosition(
    [property: JsonPropertyName("journalId")] ulong JournalId,
    [property: JsonPropertyName("nextUsn")] long NextUsn);

/// <summary>
/// The files collector's <c>collector_state.cursor</c> on Windows: <c>{"C:\\":{"journalId":..,"nextUsn":..}}</c>.
/// </summary>
public static class UsnCursor
{
    public static Dictionary<string, UsnPosition> Parse(string? cursor)
    {
        var d = new Dictionary<string, UsnPosition>(StringComparer.OrdinalIgnoreCase);
        if (string.IsNullOrEmpty(cursor) || cursor[0] != '{') return d;
        try
        {
            var parsed = JsonSerializer.Deserialize<Dictionary<string, UsnPosition>>(cursor);
            if (parsed is not null) foreach (var (k, v) in parsed) d[k] = v;
        }
        catch (JsonException) { }
        return d;
    }

    public static string Format(IReadOnlyDictionary<string, UsnPosition> positions) =>
        JsonSerializer.Serialize(positions.OrderBy(p => p.Key, StringComparer.OrdinalIgnoreCase).ToDictionary(p => p.Key, p => p.Value));
}
