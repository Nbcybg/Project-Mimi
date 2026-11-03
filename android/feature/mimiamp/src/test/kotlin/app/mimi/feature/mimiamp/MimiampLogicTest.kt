package app.mimi.feature.mimiamp

import app.mimi.core.model.MimiampTrack
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MimiampLogicTest {
    private val tracks = listOf(
        MimiampTrack(id = "file:Sunset Train.wav", source = "file", file = "Sunset Train.wav", title = "Sunset Train", artist = "Suno"),
        MimiampTrack(id = "file:Sunset Train 2.wav", source = "file", file = "Sunset Train 2.wav", title = "Sunset Train (Take 2)", artist = "Suno"),
        MimiampTrack(id = "youtube:dQw4w9WgXcQ", source = "youtube", videoId = "dQw4w9WgXcQ", title = "Never Gonna", artist = "Rick"),
    )

    @Test
    fun `an agent's query matches exactly first, then by words, like the web player`() {
        assertEquals("file:Sunset Train.wav", findTrack(tracks, "sunset train")?.id)
        assertEquals("file:Sunset Train 2.wav", findTrack(tracks, "take 2")?.id)
        assertEquals("youtube:dQw4w9WgXcQ", findTrack(tracks, "dQw4w9WgXcQ")?.id)
        assertEquals("youtube:dQw4w9WgXcQ", findTrack(tracks, "rick")?.id)
        assertNull(findTrack(tracks, "nothing like this"))
        assertNull(findTrack(tracks, "  "))
    }

    @Test
    fun `ten bands fold onto a five-band device by nearest centre, averaged`() {
        val device = intArrayOf(60, 230, 910, 3600, 14000)
        val gains = floatArrayOf(6f, 4f, 2f, 0f, -2f, -4f, -6f, 8f, 10f, 12f)
        // 60 -> 60; 170,310 -> 230; 600,1000 -> 910; 3000,6000 -> 3600; 12k,14k,16k -> 14k
        assertArrayEquals(floatArrayOf(6f, 3f, -1f, -5f, 10f), mapBands(device, gains), 0.001f)
    }

    @Test
    fun `a band with no slider near it stays flat`() {
        assertArrayEquals(floatArrayOf(0f, 3f), mapBands(intArrayOf(1, 1000), FloatArray(10) { 3f }), 0.001f)
    }
}
