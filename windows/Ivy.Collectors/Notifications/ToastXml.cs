using System.Xml;
using System.Xml.Linq;

namespace Ivy.Collectors.Notifications;

public sealed record ToastContent(string Title, string Text, string? Attribution);

/// <summary>
/// Parses a toast payload (<c>&lt;toast&gt;&lt;visual&gt;&lt;binding&gt;&lt;text&gt;…</c>, ToastGeneric or the
/// legacy ToastText0x templates). Title = first text element, text = the remaining ones joined by newlines,
/// attribution = <c>placement="attribution"</c> text. DTDs are prohibited (no XXE).
/// </summary>
public static class ToastXml
{
    public static ToastContent? Parse(string? xml)
    {
        if (string.IsNullOrWhiteSpace(xml)) return null;
        XDocument doc;
        try
        {
            using var sr = new StringReader(xml.TrimStart('﻿', '\0').TrimEnd('\0'));
            using var xr = XmlReader.Create(sr, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, IgnoreComments = true });
            doc = XDocument.Load(xr);
        }
        catch (XmlException) { return null; }
        var root = doc.Root;
        if (root is null || !root.Name.LocalName.Equals("toast", StringComparison.OrdinalIgnoreCase)) return null;
        var binding = root.Descendants().FirstOrDefault(e => e.Name.LocalName == "binding" && e.Elements().Any(t => t.Name.LocalName == "text"));
        if (binding is null) return new ToastContent("", "", null);
        string? attribution = null;
        var texts = new List<string>();
        foreach (var t in binding.Descendants().Where(e => e.Name.LocalName == "text"))
        {
            var value = t.Value.Trim();
            if (string.Equals((string?)t.Attribute("placement"), "attribution", StringComparison.OrdinalIgnoreCase))
            {
                if (value.Length > 0) attribution = value;
                continue;
            }
            // Only direct texts of the binding or of a top-level group/subgroup; skip empty ones.
            if (value.Length > 0) texts.Add(value);
        }
        return new ToastContent(texts.Count > 0 ? texts[0] : "", string.Join("\n", texts.Skip(1)), attribution);
    }
}
