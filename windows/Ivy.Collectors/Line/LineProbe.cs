using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;

namespace Ivy.Collectors.Line;

/// <summary>How a file's first bytes classify (the probe reads no row content, PRD WL1 "reads no message content").</summary>
public enum LineFileKind
{
    Empty,
    /// <summary>Plain SQLite (header <c>SQLite format 3\0</c>): its table/column names are listed.</summary>
    Sqlite,
    /// <summary>SQLite side-car (<c>-wal</c>/<c>-shm</c>).</summary>
    SqliteSidecar,
    Json,
    LevelDb,
    Text,
    /// <summary>Binary we cannot classify (could be SQLCipher/wxSQLite3, protobuf, or anything).</summary>
    Binary,
}

/// <summary>One enumerated file in a probe report (metadata + first-16-bytes only).</summary>
public sealed class LineProbeFile
{
    [JsonPropertyName("relativePath")] public required string RelativePath { get; init; }
    [JsonPropertyName("size")] public long Size { get; init; }
    [JsonPropertyName("mtime")] public required string Mtime { get; init; }
    /// <summary>First up-to-16 bytes, hex. The SQLite magic and random/encrypted headers are told apart here.</summary>
    [JsonPropertyName("head16Hex")] public required string Head16Hex { get; init; }
    [JsonPropertyName("kind")] public required string Kind { get; init; }
    /// <summary>True for a db-like file (by pattern) whose header is not SQLite — a likely encrypted store.</summary>
    [JsonPropertyName("looksEncrypted")] public bool LooksEncrypted { get; init; }
    /// <summary>Plain-SQLite tables (names + column names only, no rows); null for everything else.</summary>
    [JsonPropertyName("tables")] public IReadOnlyList<LineProbeTable>? Tables { get; init; }
    /// <summary>Set when listing tables failed (e.g. the file is locked).</summary>
    [JsonPropertyName("note")] public string? Note { get; init; }
}

public sealed class LineProbeTable
{
    [JsonPropertyName("name")] public required string Name { get; init; }
    [JsonPropertyName("columns")] public required IReadOnlyList<string> Columns { get; init; }
}

public sealed class LineProbeLocation
{
    [JsonPropertyName("label")] public required string Label { get; init; }
    [JsonPropertyName("path")] public required string Path { get; init; }
    [JsonPropertyName("exists")] public bool Exists { get; init; }
    [JsonPropertyName("files")] public required IReadOnlyList<LineProbeFile> Files { get; init; }
}

public sealed class LineProbeSummary
{
    [JsonPropertyName("totalFiles")] public int TotalFiles { get; init; }
    /// <summary>Plain SQLite files plus likely-encrypted store files.</summary>
    [JsonPropertyName("databases")] public int Databases { get; init; }
    /// <summary>Plain SQLite files we could open and list (candidates the adapter can read today).</summary>
    [JsonPropertyName("readable")] public int Readable { get; init; }
}

/// <summary>The full probe report, written to <c>%LOCALAPPDATA%\IVY\line-probe-&lt;version&gt;.json</c>.</summary>
public sealed class LineProbeReport
{
    [JsonPropertyName("schema")] public int Schema { get; init; } = 1;
    [JsonPropertyName("generatedAt")] public required string GeneratedAt { get; init; }
    [JsonPropertyName("lineVersion")] public required string LineVersion { get; init; }
    [JsonPropertyName("locations")] public required IReadOnlyList<LineProbeLocation> Locations { get; init; }
    [JsonPropertyName("summary")] public required LineProbeSummary Summary { get; init; }

    [JsonIgnore] private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public string ToJson() => JsonSerializer.Serialize(this, Json);

    /// <summary>"Probe complete: N files, M databases, K readable" (PRD WL1 UI line).</summary>
    public string HumanSummary() =>
        $"Probe complete: {Summary.TotalFiles} files, {Summary.Databases} databases, {Summary.Readable} readable";
}

/// <summary>A candidate LINE data location to enumerate.</summary>
public sealed record LineProbeRoot(string Label, string Path, string DbPattern = "*.edb");

/// <summary>
/// Probe layer (PRD WL1, runs first on the PC, reads no message content). It locates the LINE for Windows
/// data folders, walks the tree recording file names, sizes, mtimes and the first 16 bytes of each file (to
/// tell SQLite / encrypted-random / LevelDB / JSON apart), and for any *plain* SQLite file lists its table
/// and column names only. The report is what tells us the real layout, so it must be safe to run blind.
/// Nothing here is Windows-specific, so the tests drive it over a synthetic tree.
/// </summary>
public sealed class LineStoreProbe
{
    private static readonly byte[] SqliteMagic = Encoding.ASCII.GetBytes("SQLite format 3\0");

    private readonly IReadOnlyList<LineProbeRoot> _roots;

    public LineStoreProbe(IReadOnlyList<LineProbeRoot> roots) => _roots = roots;

    /// <summary>
    /// Candidate LINE data locations (NOTES.md). The chat store lives under the classic installer's
    /// <c>LINE\Data</c> or the Store-app <c>LocalState</c>; chat media (images/videos/files received in
    /// chats) is not under <c>Data</c> in the probe we have, so we also walk the <c>LINE</c> parent and the
    /// Roaming <c>LINE</c> folder to find where media and thumbnails are cached. The probe records only file
    /// names, sizes, mtimes and the first 16 bytes, so widening the roots stays safe to run blind.
    /// </summary>
    public static IReadOnlyList<LineProbeRoot> DefaultRoots()
    {
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var roots = new List<LineProbeRoot>
        {
            new("installer", Path.Combine(local, "LINE", "Data")),
            // the LINE parent and Roaming LINE: where a desktop client usually caches media/thumbnails
            new("installer-parent", Path.Combine(local, "LINE")),
            new("roaming", Path.Combine(roaming, "LINE")),
        };
        // Store-app build: %LOCALAPPDATA%\Packages\NAVER.LINEwin8_*\LocalState\ (and the package root above it)
        var packages = Path.Combine(local, "Packages");
        if (Directory.Exists(packages))
        {
            foreach (var dir in SafeDirs(packages, "NAVER.LINEwin8_*"))
            {
                roots.Add(new LineProbeRoot("store", Path.Combine(dir, "LocalState")));
                roots.Add(new LineProbeRoot("store-package", dir));
            }
        }
        else
        {
            roots.Add(new LineProbeRoot("store", Path.Combine(packages, "NAVER.LINEwin8_UNKNOWN", "LocalState")));
        }
        return roots;
    }

    public LineProbeReport Run(string lineVersion, DateTimeOffset now, Func<string, byte[]?>? decryptor = null)
    {
        var locations = new List<LineProbeLocation>();
        var total = 0;
        var databases = 0;
        var readable = 0;
        foreach (var root in _roots)
        {
            var exists = Directory.Exists(root.Path);
            var files = new List<LineProbeFile>();
            if (exists)
            {
                foreach (var full in SafeFiles(root.Path))
                {
                    var file = Describe(root, full, decryptor);
                    files.Add(file);
                    total++;
                    if (file.Kind == nameof(LineFileKind.Sqlite)) { databases++; readable++; }
                    else if (file.LooksEncrypted) databases++;
                }
                files.Sort((a, b) => string.CompareOrdinal(a.RelativePath, b.RelativePath));
            }
            locations.Add(new LineProbeLocation { Label = root.Label, Path = root.Path, Exists = exists, Files = files });
        }
        return new LineProbeReport
        {
            GeneratedAt = Ivy.Core.Protocol.IvyTime.Format(now),
            LineVersion = lineVersion,
            Locations = locations,
            Summary = new LineProbeSummary { TotalFiles = total, Databases = databases, Readable = readable },
        };
    }

    private static LineProbeFile Describe(LineProbeRoot root, string full, Func<string, byte[]?>? decryptor = null)
    {
        var info = new FileInfo(full);
        var head = ReadHead(full, 16);
        var (kind, looksEncrypted) = Classify(full, head, root.DbPattern);
        IReadOnlyList<LineProbeTable>? tables = null;
        string? note = null;
        if (kind == LineFileKind.Sqlite)
        {
            try { tables = ListTables(full); }
            catch (SqliteException e) { note = "could not list tables: " + e.Message; }
            catch (IOException e) { note = "could not open: " + e.Message; }
        }
        else if (looksEncrypted && decryptor is not null)
        {
            // With the key, decrypt and list the real tables and columns (names only, no row data) so the
            // store's settings/blocked/hidden layout can be mapped. Never reads message contents.
            try
            {
                var plain = decryptor(full);
                if (plain is not null) { tables = ListTablesFromBytes(plain); note = "decrypted schema (names only)"; }
            }
            catch (Exception e) { note = "could not read decrypted schema: " + e.Message; }
        }
        return new LineProbeFile
        {
            RelativePath = Path.GetRelativePath(root.Path, full).Replace('\\', '/'),
            Size = info.Exists ? info.Length : 0,
            Mtime = Ivy.Core.Protocol.IvyTime.Format(info.LastWriteTimeUtc),
            Head16Hex = Convert.ToHexString(head).ToLowerInvariant(),
            Kind = kind.ToString(),
            LooksEncrypted = looksEncrypted,
            Tables = tables,
            Note = note,
        };
    }

    internal static (LineFileKind Kind, bool LooksEncrypted) Classify(string path, byte[] head, string dbPattern)
    {
        var name = Path.GetFileName(path);
        if (head.Length == 0) return (LineFileKind.Empty, false);
        if (name.EndsWith("-wal", StringComparison.OrdinalIgnoreCase) || name.EndsWith("-shm", StringComparison.OrdinalIgnoreCase))
            return (LineFileKind.SqliteSidecar, false);
        if (head.Length >= SqliteMagic.Length && head.AsSpan(0, SqliteMagic.Length).SequenceEqual(SqliteMagic))
            return (LineFileKind.Sqlite, false);
        if (name is "CURRENT" or "LOCK" or "LOG" || name.StartsWith("MANIFEST", StringComparison.Ordinal)
            || name.EndsWith(".ldb", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".log", StringComparison.OrdinalIgnoreCase))
            return (LineFileKind.LevelDb, false);
        var firstNonWs = head.FirstOrDefault(b => b is not ((byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n' or 0xEF or 0xBB or 0xBF));
        if (firstNonWs is (byte)'{' or (byte)'[') return (LineFileKind.Json, false);
        // db-like file (matches the db glob) that is not SQLite → a likely encrypted store.
        var isDbLike = Common.Glob.ToRegex(dbPattern).IsMatch(name);
        if (IsMostlyText(head)) return (LineFileKind.Text, false);
        return (LineFileKind.Binary, isDbLike);
    }

    private static bool IsMostlyText(byte[] bytes)
    {
        if (bytes.Length == 0) return false;
        var printable = bytes.Count(b => b is >= 0x20 and < 0x7F or (byte)'\r' or (byte)'\n' or (byte)'\t');
        return printable >= bytes.Length * 0.9;
    }

    private static byte[] ReadHead(string path, int count)
    {
        try
        {
            using var s = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var buf = new byte[count];
            var got = 0;
            int n;
            while (got < count && (n = s.Read(buf, got, count - got)) > 0) got += n;
            return got == count ? buf : buf[..got];
        }
        catch (IOException) { return Array.Empty<byte>(); }
        catch (UnauthorizedAccessException) { return Array.Empty<byte>(); }
    }

    private static IReadOnlyList<LineProbeTable> ListTablesFromBytes(byte[] plain)
    {
        var tmp = Path.Combine(Path.GetTempPath(), "ivy-line-probe-" + Guid.NewGuid().ToString("N")[..10] + ".db");
        try { File.WriteAllBytes(tmp, plain); return ListTables(tmp); }
        finally { try { File.Delete(tmp); } catch { /* best effort */ } }
    }

    private static IReadOnlyList<LineProbeTable> ListTables(string path)
    {
        // Snapshot to a temp copy so a locked live file does not block the read, mirroring the notification reader.
        var tmp = Path.Combine(Path.GetTempPath(), "ivy-line-probe-" + Guid.NewGuid().ToString("N")[..10] + ".db");
        try
        {
            using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var output = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                input.CopyTo(output);
            var cs = new SqliteConnectionStringBuilder { DataSource = tmp, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString();
            using var c = new SqliteConnection(cs);
            c.Open();
            var names = new List<string>();
            using (var cmd = c.CreateCommand())
            {
                cmd.CommandText = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
                using var r = cmd.ExecuteReader();
                while (r.Read()) names.Add(r.GetString(0));
            }
            var tables = new List<LineProbeTable>();
            foreach (var name in names)
            {
                var cols = new List<string>();
                using var cmd = c.CreateCommand();
                cmd.CommandText = $"PRAGMA table_info(\"{name.Replace("\"", "\"\"")}\")";
                using var r = cmd.ExecuteReader();
                while (r.Read()) cols.Add(r.GetString(1)); // column 1 = name; no row data is read
                tables.Add(new LineProbeTable { Name = name, Columns = cols });
            }
            return tables;
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch (IOException) { }
        }
    }

    private static IEnumerable<string> SafeFiles(string root)
    {
        try { return Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories); }
        catch (IOException) { return Array.Empty<string>(); }
        catch (UnauthorizedAccessException) { return Array.Empty<string>(); }
    }

    private static IEnumerable<string> SafeDirs(string parent, string pattern)
    {
        try { return Directory.EnumerateDirectories(parent, pattern); }
        catch (IOException) { return Array.Empty<string>(); }
        catch (UnauthorizedAccessException) { return Array.Empty<string>(); }
    }
}
