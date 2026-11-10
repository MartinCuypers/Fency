package io.github.martincuypers.fency.core

import kotlin.math.abs

/** Horloge GNSS d'une époque (copie des champs utiles de android.location.GnssClock). */
data class RawClock(
    val timeNanos: Long,
    val fullBiasNanos: Long,
    val biasNanos: Double,
    val hasFullBias: Boolean,
    val hardwareClockDiscontinuityCount: Int,
)

/** Mesure d'un signal (copie des champs utiles de android.location.GnssMeasurement). */
data class RawMeasurement(
    val constellation: Int,
    val svid: Int,
    val state: Int,
    val receivedSvTimeNanos: Long,
    val timeOffsetNanos: Double,
    val cn0DbHz: Double,
    val pseudorangeRateMps: Double,
    val adrState: Int,
    val adrMeters: Double,
    val carrierFrequencyHz: Double?, // null si non fourni
    val codeType: String?,           // null si non fourni (API < 29)
)

/** Une époque prête pour RTKLIB : un élément par signal (satellite x fréquence). */
class Epoch(
    val week: Int,
    val tow: Double,
    val sys: ByteArray,
    val prn: IntArray,
    val codes: ByteArray,
    val P: DoubleArray,
    val L: DoubleArray,
    val D: DoubleArray,
    val snr: DoubleArray,
    val lli: IntArray,
) {
    val size get() = prn.size
}

/**
 * Conversion des mesures brutes Android vers des observations RINEX/RTKLIB.
 * Références : « Android raw GNSS measurements » (Google, white paper GSA) et GnssLogger.
 */
class RawConverter(
    private val useGal: Boolean = true,
    private val useBds: Boolean = true,
    private val useQzs: Boolean = true,
) {
    private var lastDiscontinuity = -1
    private val lastPhaseValid = HashMap<String, Boolean>()

    fun convert(clock: RawClock, meas: List<RawMeasurement>): Epoch? {
        if (!clock.hasFullBias) return null
        val gpsNanos = clock.timeNanos - clock.fullBiasNanos // en Long : pas de perte de précision
        val week = Math.floorDiv(gpsNanos, NS_WEEK)
        val towNanos = gpsNanos - week * NS_WEEK
        val towRx = towNanos.toDouble() - clock.biasNanos // ns depuis le début de semaine
        val clockJump = lastDiscontinuity != -1 && lastDiscontinuity != clock.hardwareClockDiscontinuityCount
        lastDiscontinuity = clock.hardwareClockDiscontinuityCount

        val sys = ArrayList<Byte>(); val prn = ArrayList<Int>(); val codes = ArrayList<Byte>()
        val p = ArrayList<Double>(); val l = ArrayList<Double>(); val d = ArrayList<Double>()
        val snr = ArrayList<Double>(); val lli = ArrayList<Int>()

        for (m in meas) {
            val sysChar = when (m.constellation) {
                CONST_GPS -> 'G'
                CONST_GALILEO -> if (useGal) 'E' else null
                CONST_BEIDOU -> if (useBds) 'C' else null
                CONST_QZSS -> if (useQzs) 'J' else null
                else -> null // GLONASS (biais inter-fréquences), SBAS, IRNSS : ignorés
            } ?: continue
            if (!timeValid(m)) continue
            val freq = m.carrierFrequencyHz ?: defaultFreq(sysChar)
            val code = signalCode(sysChar, freq, m.codeType) ?: continue

            // Pseudo-distance : (temps de réception - temps d'émission) * c
            var tRx = towRx + m.timeOffsetNanos
            if (sysChar == 'C') tRx -= BDS_GPS_OFFSET_NS
            var dt = tRx - m.receivedSvTimeNanos
            if (dt < -NS_WEEK / 2) dt += NS_WEEK // passage de semaine
            if (dt > NS_WEEK / 2) dt -= NS_WEEK
            val pr = dt * 1e-9 * CLIGHT
            if (pr < 1.0e7 || pr > 6.0e7) continue

            val lambda = CLIGHT / freq
            val key = "$sysChar${m.svid}$code"
            val adrValid = (m.adrState and ADR_STATE_VALID) != 0 && m.adrMeters != 0.0
            var flag = 0
            if (adrValid) {
                if ((m.adrState and (ADR_STATE_RESET or ADR_STATE_CYCLE_SLIP)) != 0) flag = flag or 1
                if (lastPhaseValid[key] != true || clockJump) flag = flag or 1
                if ((m.adrState and ADR_STATE_HALF_CYCLE_REPORTED) != 0 &&
                    (m.adrState and ADR_STATE_HALF_CYCLE_RESOLVED) == 0) flag = flag or 2
            }
            lastPhaseValid[key] = adrValid

            sys += sysChar.code.toByte(); prn += m.svid
            codes += code[0].code.toByte(); codes += code[1].code.toByte()
            p += pr
            l += if (adrValid) m.adrMeters / lambda else 0.0
            d += -m.pseudorangeRateMps / lambda
            snr += m.cn0DbHz
            lli += flag
        }
        if (prn.isEmpty()) return null
        return Epoch(
            week.toInt(), towRx * 1e-9,
            sys.toByteArray(), prn.toIntArray(), codes.toByteArray(),
            p.toDoubleArray(), l.toDoubleArray(), d.toDoubleArray(), snr.toDoubleArray(), lli.toIntArray(),
        )
    }

    private fun timeValid(m: RawMeasurement): Boolean {
        val s = m.state
        if ((s and STATE_MSEC_AMBIGUOUS) != 0) return false
        val tow = (s and (STATE_TOW_DECODED or STATE_TOW_KNOWN)) != 0
        return when (m.constellation) {
            CONST_GALILEO -> tow && (s and (STATE_GAL_E1BC_CODE_LOCK or STATE_CODE_LOCK)) != 0
            else -> tow && (s and STATE_CODE_LOCK) != 0
        }
    }

    companion object {
        const val CLIGHT = 299792458.0
        const val NS_WEEK = 604_800_000_000_000L
        const val BDS_GPS_OFFSET_NS = 14_000_000_000.0

        // android.location.GnssStatus
        const val CONST_GPS = 1; const val CONST_SBAS = 2; const val CONST_GLONASS = 3
        const val CONST_QZSS = 4; const val CONST_BEIDOU = 5; const val CONST_GALILEO = 6

        // android.location.GnssMeasurement
        const val STATE_CODE_LOCK = 1; const val STATE_TOW_DECODED = 8; const val STATE_MSEC_AMBIGUOUS = 16
        const val STATE_GAL_E1BC_CODE_LOCK = 1024; const val STATE_TOW_KNOWN = 16384
        const val ADR_STATE_VALID = 1; const val ADR_STATE_RESET = 2; const val ADR_STATE_CYCLE_SLIP = 4
        const val ADR_STATE_HALF_CYCLE_RESOLVED = 8; const val ADR_STATE_HALF_CYCLE_REPORTED = 16

        const val F_L1 = 1575.42e6; const val F_L5 = 1176.45e6; const val F_B1I = 1561.098e6
        const val F_L2 = 1227.60e6; const val F_E5B = 1207.14e6

        private fun near(f: Double, ref: Double) = abs(f - ref) < 2.0e6

        fun defaultFreq(sys: Char) = if (sys == 'C') F_B1I else F_L1

        /** Code d'observation RINEX 3 (2 caractères) ou null si signal non géré. */
        fun signalCode(sys: Char, freq: Double, codeType: String?): String? {
            val ct = codeType?.takeIf { it.length == 1 && it != "U" }
            return when (sys) {
                'G', 'J' -> when {
                    near(freq, F_L1) -> "1" + (ct ?: "C")
                    near(freq, F_L5) -> "5" + (ct ?: "Q")
                    near(freq, F_L2) -> "2" + (ct ?: "L")
                    else -> null
                }
                'E' -> when {
                    near(freq, F_L1) -> "1" + (ct ?: "C")
                    near(freq, F_L5) -> "5" + (ct ?: "Q")
                    near(freq, F_E5B) -> "7" + (ct ?: "Q")
                    else -> null
                }
                'C' -> when {
                    near(freq, F_B1I) -> "2" + (ct ?: "I")
                    near(freq, F_L1) -> "1" + (ct ?: "P")
                    near(freq, F_L5) -> "5" + (ct ?: "P")
                    else -> null
                }
                else -> null
            }
        }
    }
}
