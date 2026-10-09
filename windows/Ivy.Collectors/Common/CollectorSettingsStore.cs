using System.Text.Json;
using System.Text.Json.Nodes;
using Ivy.Core.Storage;

namespace Ivy.Collectors.Common;

/// <summary>
/// Persists collector settings and small collector state blobs in Ivy.Core's <c>agent_settings</c> table
/// under <c>collector.&lt;name&gt;.&lt;key&gt;</c>.
/// </summary>
public sealed class CollectorSettingsStore
{
    private readonly VaultDb _db;
    public CollectorSettingsStore(VaultDb db) => _db = db;

    public static string Key(string collector, string key) => $"collector.{collector}.{key}";

    public JsonObject? LoadSettings(string collector) => LoadJson(collector, "settings") as JsonObject;

    public void SaveSettings(string collector, JsonObject settings) => SaveJson(collector, "settings", settings);

    public JsonNode? LoadJson(string collector, string key)
    {
        var s = _db.GetSetting(Key(collector, key));
        if (string.IsNullOrEmpty(s)) return null;
        try { return JsonNode.Parse(s); }
        catch (JsonException) { return null; }
    }

    public void SaveJson(string collector, string key, JsonNode? value) =>
        _db.SetSetting(Key(collector, key), value?.ToJsonString() ?? "null");

    public T? Load<T>(string collector, string key) where T : class
    {
        var s = _db.GetSetting(Key(collector, key));
        if (string.IsNullOrEmpty(s) || s == "null") return null;
        try { return JsonSerializer.Deserialize<T>(s, SettingsJson.Options); }
        catch (JsonException) { return null; }
    }

    public void Save<T>(string collector, string key, T? value) where T : class =>
        _db.SetSetting(Key(collector, key), value is null ? "null" : JsonSerializer.Serialize(value, SettingsJson.Options));
}

public static class SettingsJson
{
    /// <summary>camelCase; unknown setting names are rejected so a typo in a collector_config command is an error, not a no-op.</summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow,
        WriteIndented = false,
    };
}
