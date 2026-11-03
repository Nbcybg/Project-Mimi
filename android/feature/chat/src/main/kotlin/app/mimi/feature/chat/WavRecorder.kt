package app.mimi.feature.chat

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread
import kotlin.math.abs

/**
 * Records a voice message as 16-bit mono WAV at 16 kHz: the core's transcription models take
 * WAV or MP3, not the AAC/webm a MediaRecorder makes (docs/native/media.md 2.1).
 */
class WavRecorder {
    private val rate = 16_000
    @Volatile private var running = false
    private var worker: Thread? = null
    private val pcm = ByteArrayOutputStream()
    @Volatile var level: Float = 0f
        private set

    @SuppressLint("MissingPermission") // asked for by the screen before start()
    fun start() {
        if (running) return
        pcm.reset()
        val size = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT).coerceAtLeast(4096)
        val record = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size)
        running = true
        record.startRecording()
        worker = thread(name = "mimi-voice") {
            val buffer = ByteArray(size)
            while (running) {
                val read = record.read(buffer, 0, buffer.size)
                if (read > 0) {
                    synchronized(pcm) { pcm.write(buffer, 0, read) }
                    var peak = 0
                    for (i in 0 until read - 1 step 2) peak = maxOf(peak, abs((buffer[i + 1].toInt() shl 8) or (buffer[i].toInt() and 0xff)))
                    level = peak / 32768f
                }
            }
            record.stop()
            record.release()
        }
    }

    /** Stops and returns the WAV file's bytes (null when cancelled or under half a second). */
    fun stop(keep: Boolean = true): ByteArray? {
        running = false
        worker?.join(1_000)
        worker = null
        level = 0f
        val data = synchronized(pcm) { pcm.toByteArray() }
        if (!keep || data.size < rate) return null
        return wav(data, rate)
    }

    companion object {
        fun wav(pcm: ByteArray, rate: Int): ByteArray {
            val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN).apply {
                put("RIFF".toByteArray()); putInt(36 + pcm.size); put("WAVE".toByteArray())
                put("fmt ".toByteArray()); putInt(16); putShort(1); putShort(1); putInt(rate); putInt(rate * 2); putShort(2); putShort(16)
                put("data".toByteArray()); putInt(pcm.size)
            }
            return header.array() + pcm
        }
    }
}
