package io.github.martincuypers.fencemapper.core

import io.github.martincuypers.fencemapper.core.RawConverter.Companion.ADR_STATE_CYCLE_SLIP
import io.github.martincuypers.fencemapper.core.RawConverter.Companion.ADR_STATE_VALID
import io.github.martincuypers.fencemapper.core.RawConverter.Companion.CLIGHT
import io.github.martincuypers.fencemapper.core.RawConverter.Companion.CONST_BEIDOU
import io.github.martincuypers.fencemapper.core.RawConverter.Companion.CONST_GALILEO
import io.github.martincuypers.fencemapper.core.RawConverter.Companion.CONST_GLONASS
import io.github.martincuypers.fencemapper.core.RawConverter.Companion.CONST_GPS
import io.github.martincuypers.fencemapper.core.RawConverter.Companion.F_L1
import io.github.martincuypers.fencemapper.core.RawConverter.Companion.F_L5
import io.github.martincuypers.fencemapper.core.RawConverter.Companion.NS_WEEK
import io.github.martincuypers.fencemapper.core.RawConverter.Companion.STATE_CODE_LOCK
import io.github.martincuypers.fencemapper.core.RawConverter.Companion.STATE_MSEC_AMBIGUOUS
import io.github.martincuypers.fencemapper.core.RawConverter.Companion.STATE_TOW_DECODED
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import kotlin.math.roundToLong

class RawConverterTest {
    private val week = 2440L
    private val bias = 0.37 // ns
    private val timeNanos = 123_456_789_000L

    /** Horloge telle que l'heure GPS de réception soit week:towNs (corrigée du biais). */
    private fun clock(towNs: Long, discontinuity: Int = 0) = RawClock(
        timeNanos = timeNanos,
        fullBiasNanos = timeNanos - (week * NS_WEEK + towNs),
        biasNanos = bias, hasFullBias = true, hardwareClockDiscontinuityCount = discontinuity,
    )

    private fun meas(towNs: Long, range: Double, constellation: Int = CONST_GPS, svid: Int = 5,
                     freq: Double = F_L1, state: Int = STATE_CODE_LOCK or STATE_TOW_DECODED,
                     adr: Double = 0.0, adrState: Int = 0, prr: Double = -250.0, sysOffsetNs: Double = 0.0) =
        RawMeasurement(
            constellation, svid, state,
            receivedSvTimeNanos = ((towNs - bias - sysOffsetNs) - range / CLIGHT * 1e9).roundToLong().let {
                if (it < 0) it + NS_WEEK else it
            },
            timeOffsetNanos = 0.0, cn0DbHz = 42.0, pseudorangeRateMps = prr,
            adrState = adrState, adrMeters = adr, carrierFrequencyHz = freq, codeType = null,
        )

    @Test fun pseudorangeEtTemps() {
        val tow = 345_600_000_000_000L
        val e = RawConverter().convert(clock(tow), listOf(meas(tow, 22_123_456.0)))!!
        assertEquals(week.toInt(), e.week)
        assertEquals((tow - bias) * 1e-9, e.tow, 1e-9)
        assertEquals(22_123_456.0, e.P[0], 0.2)
        assertEquals("1C", String(e.codes, 0, 2))
        assertEquals('G'.code.toByte(), e.sys[0])
        // Doppler : distance qui diminue (prr < 0) -> Doppler positif
        assertEquals(250.0 / (CLIGHT / F_L1), e.D[0], 1e-6)
    }

    @Test fun passageDeSemaine() {
        val tow = 50_000_000L // 0,05 s après le début de semaine : émission pendant la semaine précédente
        val e = RawConverter().convert(clock(tow), listOf(meas(tow, 21_000_000.0)))!!
        assertEquals(21_000_000.0, e.P[0], 0.2)
    }

    @Test fun beidouDecalage14s() {
        val tow = 100_000_000_000_000L
        val m = meas(tow, 38_000_000.0, CONST_BEIDOU, 30, 1561.098e6, sysOffsetNs = 14e9)
        val e = RawConverter().convert(clock(tow), listOf(m))!!
        assertEquals(38_000_000.0, e.P[0], 0.2)
        assertEquals("2I", String(e.codes, 0, 2))
    }

    @Test fun bifrequenceEtPhase() {
        val tow = 200_000_000_000_000L
        val c = RawConverter()
        fun l5(t: Long, adr: Double, st: Int = ADR_STATE_VALID) =
            meas(t, 24_000_000.0, CONST_GALILEO, 11, F_L5, adr = adr, adrState = st)
        val e1 = c.convert(clock(tow), listOf(l5(tow, 1234.5)))!!
        assertEquals("5Q", String(e1.codes, 0, 2))
        assertEquals(1234.5 / (CLIGHT / F_L5), e1.L[0], 1e-9)
        assertEquals(1, e1.lli[0] and 1) // première phase valide : (ré)accrochage
        val t2 = tow + 1_000_000_000
        assertEquals(0, c.convert(clock(t2), listOf(l5(t2, 1300.0)))!!.lli[0])
        val t3 = tow + 2_000_000_000
        assertEquals(1, c.convert(clock(t3), listOf(l5(t3, 1400.0, ADR_STATE_VALID or ADR_STATE_CYCLE_SLIP)))!!.lli[0] and 1)
        val t4 = tow + 3_000_000_000
        assertEquals(0, c.convert(clock(t4), listOf(l5(t4, 1500.0)))!!.lli[0])
        val t5 = tow + 4_000_000_000
        assertEquals(1, c.convert(clock(t5, discontinuity = 1), listOf(l5(t5, 1600.0)))!!.lli[0] and 1) // saut d'horloge
    }

    @Test fun mesuresRejetees() {
        val tow = 300_000_000_000_000L
        val list = listOf(
            meas(tow, 21e6, CONST_GLONASS),                                            // GLONASS ignoré
            meas(tow, 21e6, state = STATE_CODE_LOCK),                                  // TOW inconnu
            meas(tow, 21e6, state = STATE_CODE_LOCK or STATE_TOW_DECODED or STATE_MSEC_AMBIGUOUS),
        )
        assertNull(RawConverter().convert(clock(tow), list))
        assertNull(RawConverter().convert(clock(tow).copy(hasFullBias = false), listOf(meas(tow, 21e6))))
    }
}
