package io.github.martincuypers.fency.core

import org.junit.Assert.assertEquals
import org.junit.Test

class Rtcm3Test {
    private fun frame(type: Int, payloadLen: Int): ByteArray {
        val f = ByteArray(payloadLen + 6)
        f[0] = 0xD3.toByte(); f[1] = (payloadLen shr 8).toByte(); f[2] = payloadLen.toByte()
        f[3] = (type shr 4).toByte(); f[4] = ((type and 0xF) shl 4).toByte()
        for (i in 5 until 3 + payloadLen) f[i] = (i * 7).toByte()
        val crc = Rtcm3Framer.crc24q(f, payloadLen + 3)
        f[payloadLen + 3] = (crc shr 16).toByte(); f[payloadLen + 4] = (crc shr 8).toByte(); f[payloadLen + 5] = crc.toByte()
        return f
    }

    @Test fun crcValeurDeReference() {
        assertEquals(0xCDE703, Rtcm3Framer.crc24q("123456789".toByteArray(), 9))
    }

    @Test fun decoupeTramesMemeFragmentees() {
        val stream = byteArrayOf(1, 2, 3) + frame(1006, 21) + frame(1074, 150) + frame(1019, 61) + byteArrayOf(0xD3.toByte(), 0)
        val framer = Rtcm3Framer()
        val types = mutableListOf<Int>()
        stream.toList().chunked(17).forEach { framer.push(it.toByteArray()) { t, _ -> types += t } }
        assertEquals(listOf(1006, 1074, 1019), types)
        assertEquals(0, framer.badCrc)
    }

    @Test fun crcInvalideRejete() {
        val f = frame(1077, 40); f[10] = (f[10] + 1).toByte()
        val framer = Rtcm3Framer(); var n = 0
        framer.push(f) { _, _ -> n++ }
        assertEquals(0, n); assertEquals(1, framer.badCrc)
    }
}
