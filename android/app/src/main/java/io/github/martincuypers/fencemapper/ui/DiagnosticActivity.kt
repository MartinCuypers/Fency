package io.github.martincuypers.fencemapper.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.ScrollView
import android.widget.TextView
import io.github.martincuypers.fencemapper.core.RawClock
import io.github.martincuypers.fencemapper.core.RawConverter
import io.github.martincuypers.fencemapper.core.RawMeasurement
import io.github.martincuypers.fencemapper.gnss.RawGnssSource
import java.util.Locale

/**
 * Vérifie en 1 à 2 minutes, ciel dégagé, ce que le GNSS du téléphone permet :
 * mesures brutes, phase porteuse (ADR) valide, double fréquence L1/L5.
 */
class DiagnosticActivity : Activity() {
    private lateinit var text: TextView
    private lateinit var lm: LocationManager
    private var raw: RawGnssSource? = null
    private val main = Handler(Looper.getMainLooper())
    private var rawStatus = "en attente…"
    private var epochs = 0
    private var signals = 0
    private var phaseValid = 0
    private var usable = 0
    private val bands = sortedMapOf<String, Int>()
    private val constellations = sortedMapOf<String, Int>()
    private var cn0Sum = 0.0
    private val converter = RawConverter()
    private val listener = LocationListener { _: Location -> }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Diagnostic GNSS"
        text = TextView(this).apply { setPadding(32, 32, 32, 32); typeface = Typeface.MONOSPACE; textSize = 13f }
        setContentView(ScrollView(this).apply { addView(text) })
        lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
    }

    override fun onResume() {
        super.onResume()
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION), 1)
        } else start()
    }

    override fun onRequestPermissionsResult(code: Int, p: Array<out String>, r: IntArray) {
        if (r.isNotEmpty() && r[0] == PackageManager.PERMISSION_GRANTED) start() else text.text = "Autorisation de localisation refusée."
    }

    override fun onPause() { stop(); super.onPause() }

    @SuppressLint("MissingPermission")
    private fun start() {
        if (raw != null) return
        lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, listener, Looper.getMainLooper())
        raw = RawGnssSource(lm, ::onEpoch) { s -> main.post { rawStatus = s; render() } }
        if (raw?.start() != true) rawStatus = "enregistrement refusé"
        render()
    }

    private fun stop() {
        raw?.stop(); raw = null
        lm.removeUpdates(listener)
    }

    private fun onEpoch(clock: RawClock, meas: List<RawMeasurement>) {
        val e = converter.convert(clock, meas)
        main.post {
            epochs++
            signals += meas.size
            for (m in meas) {
                if ((m.adrState and RawConverter.ADR_STATE_VALID) != 0 && m.adrMeters != 0.0) phaseValid++
                cn0Sum += m.cn0DbHz
                val f = m.carrierFrequencyHz ?: RawConverter.F_L1
                val band = if (kotlin.math.abs(f - RawConverter.F_L5) < 2e6) "L5/E5a" else if (kotlin.math.abs(f - RawConverter.F_L1) < 2e6) "L1/E1" else String.format(Locale.US, "%.0f MHz", f / 1e6)
                bands[band] = (bands[band] ?: 0) + 1
                val c = when (m.constellation) { 1 -> "GPS"; 3 -> "GLONASS"; 4 -> "QZSS"; 5 -> "BeiDou"; 6 -> "Galileo"; 2 -> "SBAS"; else -> "autre" }
                constellations[c] = (constellations[c] ?: 0) + 1
            }
            usable += e?.size ?: 0
            render()
        }
    }

    private fun pct(a: Int, b: Int) = if (b == 0) "—" else "${100 * a / b} %"

    private fun render() {
        val caps = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val c = lm.gnssCapabilities
            "mesures brutes déclarées : ${if (c.hasMeasurements()) "oui" else "non"}"
        } else "capacités non publiées avant Android 12"
        val perEpoch = if (epochs == 0) 0 else signals / epochs
        val l5 = bands["L5/E5a"] ?: 0
        val verdict = when {
            epochs == 0 -> "Patientez (à l'extérieur, ciel dégagé)…"
            usable == 0 -> "Mesures reçues mais inexploitables (temps GNSS non résolu) : attendez le premier point GPS."
            phaseValid == 0 -> "Pas de phase porteuse valide : RTK impossible, DGNSS seulement (≈ 1 m). " +
                (if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) "Essayez l'option développeur « Forcer les mesures GNSS complètes »." else "")
            l5 == 0 -> "Phase disponible en mono-fréquence : RTK possible mais fixation lente et fragile (≈ 0,3 à 1 m)."
            else -> "Phase disponible en double fréquence L1/L5 : meilleur cas pour un téléphone (≈ 10 à 50 cm)."
        }
        text.text = buildString {
            appendLine("${Build.MANUFACTURER} ${Build.MODEL} — Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            appendLine(caps)
            appendLine("État : $rawStatus")
            appendLine()
            appendLine("Époques reçues      : $epochs")
            appendLine("Signaux par époque  : $perEpoch")
            appendLine("Exploitables (RTK)  : ${pct(usable, signals)}")
            appendLine("Phase (ADR) valide  : ${pct(phaseValid, signals)}")
            appendLine("C/N0 moyen          : ${if (signals == 0) "—" else String.format(Locale.FRANCE, "%.1f dB-Hz", cn0Sum / signals)}")
            appendLine("Bandes              : ${bands.entries.joinToString { "${it.key} ${pct(it.value, signals)}" }}")
            appendLine("Constellations      : ${constellations.entries.joinToString { "${it.key} ${pct(it.value, signals)}" }}")
            appendLine()
            appendLine("Verdict : $verdict")
        }
    }
}
