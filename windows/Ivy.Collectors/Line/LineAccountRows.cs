namespace Ivy.Collectors.Line;

/// <summary>The account's own LINE profile (from the _profile table).</summary>
public sealed record LineOwnProfile(string Mid, string? DisplayName, string? UserId, string? StatusMessage, string? PicturePath);

/// <summary>
/// A contact row with the raw status/type/settings so blocked can be determined, plus picture refs.
/// <c>Blocked</c> is set only when the store states it as a plain JSON boolean (26.x <c>_blockDetail.notBlocked</c>);
/// otherwise it stays null (unknown).
/// </summary>
public sealed record LineContactRow(string Mid, string? DisplayName, string? Status, string? Type, int? Settings, string? StatusMessage, string? PicturePath, string? ThumbnailUrl, bool? Blocked = null);

/// <summary>A chat's options row (hidden flag, notification, pinned).</summary>
public sealed record LineChatOptionRow(string Id, bool? Hidden, bool? Notification, bool Pinned);

/// <summary>The account snapshot read from the LINE store for the settings page.</summary>
public sealed record LineAccount(LineOwnProfile? Profile, IReadOnlyList<LineContactRow> Contacts, IReadOnlyList<LineChatOptionRow> Options, IReadOnlyList<(string Key, string Value)> Settings);
