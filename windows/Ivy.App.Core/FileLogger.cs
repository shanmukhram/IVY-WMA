using System.Globalization;
using System.Text;
using Microsoft.Extensions.Logging;

namespace Ivy.App.Core;

/// <summary>
/// Minimal append-only log file for the app process (Ivy.Core logs object keys, sizes and errors, never
/// captured content). Rolls to <c>.1</c> once the file passes <see cref="MaxBytes"/>.
/// </summary>
public sealed class FileLoggerFactory : ILoggerFactory
{
    public const long MaxBytes = 5L * 1024 * 1024;
    private readonly string _path;
    private readonly LogLevel _min;
    private readonly object _lock = new();

    public FileLoggerFactory(string path, LogLevel minimum = LogLevel.Information)
    {
        _path = path;
        _min = minimum;
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
    }

    public string FilePath => _path;

    public ILogger CreateLogger(string categoryName) => new FileLogger(this, categoryName);

    public void AddProvider(ILoggerProvider provider) { }

    public void Dispose() { }

    internal void Write(LogLevel level, string category, string message, Exception? e)
    {
        if (level < _min) return;
        var sb = new StringBuilder();
        sb.Append(DateTimeOffset.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture))
            .Append(' ').Append(Short(level)).Append(' ').Append(category).Append(": ").Append(message);
        if (e is not null) sb.Append(Environment.NewLine).Append(e);
        sb.Append(Environment.NewLine);
        lock (_lock)
        {
            try
            {
                var fi = new FileInfo(_path);
                if (fi.Exists && fi.Length > MaxBytes) File.Move(_path, _path + ".1", overwrite: true);
                File.AppendAllText(_path, sb.ToString());
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static string Short(LogLevel l) => l switch
    {
        LogLevel.Trace => "TRC",
        LogLevel.Debug => "DBG",
        LogLevel.Information => "INF",
        LogLevel.Warning => "WRN",
        LogLevel.Error => "ERR",
        LogLevel.Critical => "CRT",
        _ => "---",
    };

    private sealed class FileLogger : ILogger
    {
        private readonly FileLoggerFactory _f;
        private readonly string _category;
        public FileLogger(FileLoggerFactory f, string category)
        {
            _f = f;
            var dot = category.LastIndexOf('.');
            _category = dot >= 0 ? category[(dot + 1)..] : category;
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel >= _f._min && logLevel != LogLevel.None;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            _f.Write(logLevel, _category, formatter(state, exception), exception);
        }
    }
}
