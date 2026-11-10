package io.github.martincuypers.fency.core

/** Découpe un flux RTCM3 en trames valides (CRC-24Q) pour en suivre le contenu. */
class Rtcm3Framer {
    private val buf = ByteArray(1029)
    private var n = 0
    private var len = 0
    val counts = sortedMapOf<Int, Int>()
    var badCrc = 0; private set

    /** Ajoute des octets ; appelle [onFrame] (type du message, trame complète) pour chaque trame. */
    fun push(data: ByteArray, size: Int = data.size, onFrame: (Int, ByteArray) -> Unit = { _, _ -> }) {
        for (i in 0 until size) {
            val b = data[i].toInt() and 0xFF
            if (n == 0) {
                if (b == 0xD3) buf[n++] = b.toByte()
                continue
            }
            buf[n++] = b.toByte()
            if (n == 3) {
                len = ((buf[1].toInt() and 0x03) shl 8) or (buf[2].toInt() and 0xFF)
                if ((buf[1].toInt() and 0xFC) != 0) { n = 0; continue } // bits réservés
            }
            if (n >= 3 && n == len + 6) {
                val crc = ((buf[n - 3].toInt() and 0xFF) shl 16) or ((buf[n - 2].toInt() and 0xFF) shl 8) or
                    (buf[n - 1].toInt() and 0xFF)
                if (crc24q(buf, n - 3) == crc && len >= 2) {
                    val type = ((buf[3].toInt() and 0xFF) shl 4) or ((buf[4].toInt() and 0xFF) shr 4)
                    counts[type] = (counts[type] ?: 0) + 1
                    onFrame(type, buf.copyOf(n))
                } else badCrc++
                n = 0
            }
        }
    }

    companion object {
        private val TABLE = IntArray(256).also { t ->
            for (i in 0 until 256) {
                var c = i shl 16
                repeat(8) { c = if (c and 0x800000 != 0) (c shl 1) xor 0x1864CFB else c shl 1 }
                t[i] = c and 0xFFFFFF
            }
        }

        fun crc24q(b: ByteArray, len: Int): Int {
            var crc = 0
            for (i in 0 until len) crc = ((crc shl 8) and 0xFFFFFF) xor TABLE[((crc shr 16) xor (b[i].toInt() and 0xFF)) and 0xFF]
            return crc
        }

        fun describe(type: Int): String = when (type) {
            1005, 1006 -> "position base"
            1019 -> "éph. GPS"; 1020 -> "éph. GLONASS"; 1042 -> "éph. BeiDou"; 1046, 1045 -> "éph. Galileo"
            in 1071..1077 -> "obs. GPS"; in 1081..1087 -> "obs. GLONASS"; in 1091..1097 -> "obs. Galileo"
            in 1121..1127 -> "obs. BeiDou"; 1230 -> "biais GLONASS"
            1033 -> "antenne"; else -> "type $type"
        }
    }
}
