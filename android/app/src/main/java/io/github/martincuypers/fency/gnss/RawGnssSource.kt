package io.github.martincuypers.fency.gnss

import android.annotation.SuppressLint
import android.location.GnssClock
import android.location.GnssMeasurement
import android.location.GnssMeasurementRequest
import android.location.GnssMeasurementsEvent
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import io.github.martincuypers.fency.core.RawClock
import io.github.martincuypers.fency.core.RawMeasurement
import java.util.concurrent.Executor

/**
 * Mesures GNSS brutes du téléphone (Android 7+). Désactive le « duty cycling »
 * (suivi complet) à partir d'Android 12 ; avant, il faut activer l'option développeur
 * « Forcer les mesures GNSS complètes ».
 */
class RawGnssSource(
    private val lm: LocationManager,
    private val onEpoch: (RawClock, List<RawMeasurement>) -> Unit,
    private val onStatus: (String) -> Unit,
) {
    private var thread: HandlerThread? = null

    private val callback = object : GnssMeasurementsEvent.Callback() {
        override fun onGnssMeasurementsReceived(event: GnssMeasurementsEvent) {
            onEpoch(toClock(event.clock), event.measurements.map(::toMeasurement))
        }

        override fun onStatusChanged(status: Int) {
            onStatus(when (status) {
                STATUS_READY -> "Mesures brutes : actives"
                STATUS_NOT_SUPPORTED -> "Mesures brutes non prises en charge par ce téléphone"
                STATUS_LOCATION_DISABLED -> "Localisation désactivée"
                STATUS_NOT_ALLOWED -> "Mesures brutes non autorisées"
                else -> "Mesures brutes : état $status"
            })
        }
    }

    @SuppressLint("MissingPermission")
    fun start(): Boolean {
        val t = HandlerThread("gnss-raw").also { it.start() }
        thread = t
        val handler = Handler(t.looper)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val req = GnssMeasurementRequest.Builder().setFullTracking(true).build()
            lm.registerGnssMeasurementsCallback(req, Executor { handler.post(it) }, callback)
        } else {
            @Suppress("DEPRECATION")
            lm.registerGnssMeasurementsCallback(callback, handler)
        }
    }

    fun stop() {
        lm.unregisterGnssMeasurementsCallback(callback)
        thread?.quitSafely(); thread = null
    }

    companion object {
        fun toClock(c: GnssClock) = RawClock(
            c.timeNanos, if (c.hasFullBiasNanos()) c.fullBiasNanos else 0L,
            if (c.hasBiasNanos()) c.biasNanos else 0.0, c.hasFullBiasNanos(), c.hardwareClockDiscontinuityCount,
        )

        fun toMeasurement(m: GnssMeasurement) = RawMeasurement(
            constellation = m.constellationType,
            svid = m.svid,
            state = m.state,
            receivedSvTimeNanos = m.receivedSvTimeNanos,
            timeOffsetNanos = m.timeOffsetNanos,
            cn0DbHz = m.cn0DbHz,
            pseudorangeRateMps = m.pseudorangeRateMetersPerSecond,
            adrState = m.accumulatedDeltaRangeState,
            adrMeters = m.accumulatedDeltaRangeMeters,
            carrierFrequencyHz = if (m.hasCarrierFrequencyHz()) m.carrierFrequencyHz.toDouble() else null,
            codeType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && m.hasCodeType()) m.codeType else null,
        )
    }
}
