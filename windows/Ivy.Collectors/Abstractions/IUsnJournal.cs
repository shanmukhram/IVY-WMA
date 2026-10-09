namespace Ivy.Collectors.Abstractions;

/// <summary>FSCTL_QUERY_USN_JOURNAL result for one volume.</summary>
public sealed record UsnJournalInfo(ulong JournalId, long FirstUsn, long NextUsn);

/// <summary>One USN_RECORD, with its full path resolved (parent directory by file id + file name) when possible.</summary>
public sealed record UsnChange(long Usn, uint Reason, string FileName, string? FullPath, bool IsDirectory);

public sealed record UsnReadResult(IReadOnlyList<UsnChange> Changes, long NextUsn);

/// <summary>USN reason flags (winioctl.h) the file index cares about.</summary>
public static class UsnReasons
{
    public const uint DataOverwrite = 0x00000001;
    public const uint DataExtend = 0x00000002;
    public const uint DataTruncation = 0x00000004;
    public const uint FileCreate = 0x00000100;
    public const uint FileDelete = 0x00000200;
    public const uint RenameOldName = 0x00001000;
    public const uint RenameNewName = 0x00002000;
    public const uint BasicInfoChange = 0x00008000;
    public const uint Close = 0x80000000;

    /// <summary>Reasons that can change a file_meta field (path, size, mtime, content).</summary>
    public const uint Relevant = DataOverwrite | DataExtend | DataTruncation | FileCreate | FileDelete | RenameOldName | RenameNewName | BasicInfoChange;
}

/// <summary>
/// NTFS change journal access (Windows: DeviceIoControl FSCTL_QUERY_USN_JOURNAL / FSCTL_READ_USN_JOURNAL).
/// Implementations throw <see cref="UnauthorizedAccessException"/> when the volume cannot be opened and
/// <see cref="NotSupportedException"/> when the volume has no journal (FAT, network share).
/// </summary>
public interface IUsnJournal
{
    /// <summary><paramref name="volume"/> is a root such as <c>C:\</c>.</summary>
    UsnJournalInfo Query(string volume);

    /// <summary>Read records from <paramref name="startUsn"/>; returns at most about <paramref name="maxRecords"/>.</summary>
    UsnReadResult Read(string volume, ulong journalId, long startUsn, int maxRecords);
}
