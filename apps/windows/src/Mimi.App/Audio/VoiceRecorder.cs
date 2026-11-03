using NAudio.Wave;

namespace Mimi.App.Audio;

/// <summary>
/// A voice message: WAV, 16 kHz, 16-bit mono (media.md 2.1 — the transcription model takes WAV / MP3,
/// not webm), recorded from the default microphone. Windows asks the person the first time
/// (Settings → Privacy → Microphone → "Let desktop apps access your microphone").
/// </summary>
internal sealed class VoiceRecorder : IDisposable
{
    private WaveInEvent? input;
    private MemoryStream? buffer;
    private WaveFileWriter? writer;
    private TaskCompletionSource<byte[]>? finished;
    private DateTime started;

    public bool Recording => input is not null;
    public TimeSpan Elapsed => Recording ? DateTime.UtcNow - started : TimeSpan.Zero;

    public void Start()
    {
        if (input is not null) return;
        if (WaveInEvent.DeviceCount == 0) throw new InvalidOperationException("ไม่พบไมโครโฟน");
        buffer = new MemoryStream();
        var format = new WaveFormat(16000, 16, 1);
        writer = new WaveFileWriter(new IgnoreDispose(buffer), format);
        finished = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        input = new WaveInEvent { WaveFormat = format, BufferMilliseconds = 100 };
        input.DataAvailable += (_, e) => writer?.Write(e.Buffer, 0, e.BytesRecorded);
        input.RecordingStopped += (_, e) =>
        {
            writer?.Dispose();
            writer = null;
            var bytes = buffer?.ToArray() ?? [];
            input?.Dispose();
            input = null;
            if (e.Exception is not null) finished?.TrySetException(e.Exception);
            else finished?.TrySetResult(bytes);
        };
        started = DateTime.UtcNow;
        input.StartRecording();
    }

    /// <summary>Stops and gives the WAV file's bytes.</summary>
    public Task<byte[]> Stop()
    {
        var done = finished ?? Task.FromResult<byte[]>([]).ToCompletionSource();
        input?.StopRecording();
        return done.Task;
    }

    public void Cancel()
    {
        input?.StopRecording();
        finished = null;
    }

    public void Dispose() => Cancel();

    /// <summary>Lets the WAV writer close (it writes its header then) without closing the bytes.</summary>
    private sealed class IgnoreDispose(Stream inner) : Stream
    {
        public override bool CanRead => inner.CanRead;
        public override bool CanSeek => inner.CanSeek;
        public override bool CanWrite => inner.CanWrite;
        public override long Length => inner.Length;
        public override long Position { get => inner.Position; set => inner.Position = value; }
        public override void Flush() => inner.Flush();
        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);
        public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
        public override void SetLength(long value) => inner.SetLength(value);
        public override void Write(byte[] buffer, int offset, int count) => inner.Write(buffer, offset, count);
        protected override void Dispose(bool disposing) => inner.Flush();
    }
}

internal static class TaskExtensions
{
    public static TaskCompletionSource<T> ToCompletionSource<T>(this Task<T> task)
    {
        var source = new TaskCompletionSource<T>();
        task.ContinueWith(done => source.TrySetResult(done.Result), TaskScheduler.Default);
        return source;
    }
}
