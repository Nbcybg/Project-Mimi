package app.mimi.feature.mimiamp

import android.content.Context
import android.media.audiofx.Equalizer
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.abs
import kotlin.math.ln

/** The web player's ten bands (feature-mimiamp.js EQ_BANDS), in Hz, and their presets in dB. */
val EQ_BANDS = intArrayOf(60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000)
val EQ_PRESETS: Map<String, FloatArray> = linkedMapOf(
    "Flat" to FloatArray(10),
    "Bass" to floatArrayOf(6f, 5f, 3f, 1f, 0f, 0f, 0f, 0f, 0f, 0f),
    "Vocal" to floatArrayOf(-2f, -1f, 0f, 2f, 4f, 4f, 2f, 0f, -1f, -2f),
    "Treble" to floatArrayOf(0f, 0f, 0f, 0f, 0f, 2f, 4f, 5f, 6f, 6f),
    "Lo-fi" to floatArrayOf(3f, 2f, 1f, 0f, -1f, -2f, -3f, -5f, -6f, -6f),
)

data class EqState(val enabled: Boolean = false, val gains: FloatArray = FloatArray(10), val deviceBands: Int = 0) {
    override fun equals(other: Any?) = other is EqState && enabled == other.enabled && gains.contentEquals(other.gains) && deviceBands == other.deviceBands
    override fun hashCode() = 31 * enabled.hashCode() + gains.contentHashCode()
}

/**
 * Which of the device's bands each of the ten Mimiamp bands drives: the nearest centre
 * frequency on a log scale. Devices have 5 bands at best, so several sliders share one and
 * the band gets their average. Pure, so it is tested on the JVM.
 */
fun mapBands(deviceCentersHz: IntArray, gains: FloatArray): FloatArray {
    val out = FloatArray(deviceCentersHz.size)
    val counts = IntArray(deviceCentersHz.size)
    for (i in EQ_BANDS.indices) {
        val target = ln(EQ_BANDS[i].toDouble())
        val nearest = deviceCentersHz.indices.minByOrNull { abs(ln(deviceCentersHz[it].coerceAtLeast(1).toDouble()) - target) } ?: continue
        out[nearest] += gains[i]
        counts[nearest]++
    }
    for (band in out.indices) if (counts[band] > 0) out[band] /= counts[band]
    return out
}

/** The 10-band EQ over `android.media.audiofx.Equalizer`, attached to the player's audio session. */
@Singleton
class Equalizer10 @Inject constructor(@ApplicationContext context: Context) {
    private val prefs = context.getSharedPreferences("mimiamp-eq", Context.MODE_PRIVATE)
    private val stateFlow = MutableStateFlow(
        EqState(
            enabled = prefs.getBoolean("enabled", false),
            gains = FloatArray(10) { prefs.getFloat("g$it", 0f) },
        ),
    )
    val state: StateFlow<EqState> = stateFlow.asStateFlow()
    private var effect: Equalizer? = null

    /** Called by the player whenever its audio session changes. */
    @Synchronized
    fun attach(audioSessionId: Int) {
        effect?.release()
        effect = runCatching { Equalizer(0, audioSessionId) }.getOrNull()
        stateFlow.value = stateFlow.value.copy(deviceBands = effect?.numberOfBands?.toInt() ?: 0)
        apply()
    }

    @Synchronized
    fun release() {
        effect?.release()
        effect = null
    }

    fun setEnabled(enabled: Boolean) = update(stateFlow.value.copy(enabled = enabled))

    fun setGain(band: Int, db: Float) = update(stateFlow.value.copy(gains = stateFlow.value.gains.copyOf().also { it[band] = db.coerceIn(-12f, 12f) }))

    fun preset(name: String) = EQ_PRESETS[name]?.let { update(stateFlow.value.copy(enabled = true, gains = it.copyOf())) }

    private fun update(next: EqState) {
        stateFlow.value = next
        prefs.edit().putBoolean("enabled", next.enabled).apply {
            next.gains.forEachIndexed { index, value -> putFloat("g$index", value) }
        }.apply()
        apply()
    }

    @Synchronized
    private fun apply() {
        val eq = effect ?: return
        runCatching {
            val current = stateFlow.value
            eq.enabled = current.enabled
            val bands = eq.numberOfBands.toInt()
            val centers = IntArray(bands) { eq.getCenterFreq(it.toShort()) / 1000 }
            val (min, max) = eq.bandLevelRange.let { it[0] to it[1] }
            mapBands(centers, current.gains).forEachIndexed { band, db ->
                eq.setBandLevel(band.toShort(), (db * 100).toInt().coerceIn(min.toInt(), max.toInt()).toShort())
            }
        }
    }
}
