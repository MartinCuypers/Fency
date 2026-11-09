package io.github.martincuypers.fencemapper

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import io.github.martincuypers.fencemapper.core.Nmea
import io.github.martincuypers.fencemapper.core.NtripClient
import io.github.martincuypers.fencemapper.core.Position
import io.github.martincuypers.fencemapper.core.Quality
import io.github.martincuypers.fencemapper.core.RawConverter
import io.github.martincuypers.fencemapper.core.Rtcm3Framer
import io.github.martincuypers.fencemapper.gnss.BluetoothReceiver
import io.github.martincuypers.fencemapper.gnss.RawGnssSource
import io.github.martincuypers.fencemapper.rtk.RtkNative
import java.util.Locale
import kotlin.math.hypot

/**
 * Chef d'orchestre des sources de position :
 *  - « internal » : mesures brutes du téléphone + corrections NTRIP + RTKLIB ;
 *  - « external » : récepteur RTK Bluetooth (NMEA), corrections NTRIP retransmises ;
 *  - « standard » : position Android classique.
 * Les callbacks [onPosition] et [onStatus] sont appelés sur le thread principal.
 */
class PositionEngine(
    private val ctx: Context,
    private val onPosition: (Position) -> Unit,
    private val onStatus: (String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private var prefs = Prefs(ctx)

    private var rtk: RtkNative? = null
    private var raw: RawGnssSource? = null
    private var ntrip: NtripClient? = null
    private var bt: BluetoothReceiver? = null
    private val framer = Rtcm3Framer()
    private var converter = RawConverter()

    @Volatile private var lastPhone: Location? = null
    @Volatile private var lastPos: Position? = null
    @Volatile private var lastRtkMs = 0L
    @Volatile private var lastBaseMs = 0L
    @Volatile private var lastBtSpeed: Pair<Double, Double?>? = null
    private val st = linkedMapOf<String, String>()
    var running = false; private set

    private val phoneListener = object : LocationListener {
        override fun onLocationChanged(l: Location) {
            lastPhone = l
            // en mode RTK interne, la position du téléphone sert de secours (et donne vitesse/cap)
            val rtkFresh = System.currentTimeMillis() - lastRtkMs < 3000
            if (prefs.mode == Prefs.MODE_STANDARD || (prefs.mode == Prefs.MODE_INTERNAL && !rtkFresh)) {
                emit(Position(l.latitude, l.longitude, l.altitude, l.accuracy.toDouble(), Quality.PHONE,
                    speedMps = if (l.hasSpeed()) l.speed.toDouble() else null,
                    bearingDeg = if (l.hasBearing()) l.bearing.toDouble() else null, source = "Android"))
            }
        }
        @Deprecated("API < 29") override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
        override fun onProviderEnabled(p: String) {}
        override fun onProviderDisabled(p: String) { status("gps", "Localisation désactivée dans les réglages") }
    }

    @SuppressLint("MissingPermission")
    fun start() {
        if (running) return
        running = true
        prefs = Prefs(ctx)
        st.clear()
        val mode = prefs.mode
        status("mode", when (mode) {
            Prefs.MODE_INTERNAL -> "RTK interne (téléphone)"
            Prefs.MODE_EXTERNAL -> "Récepteur externe ${prefs.btName}"
            else -> "GPS standard"
        })
        if (mode != Prefs.MODE_EXTERNAL) {
            lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, phoneListener, Looper.getMainLooper())
        }
        if (mode == Prefs.MODE_INTERNAL) startInternal()
        if (mode == Prefs.MODE_EXTERNAL) startExternal()
        if (mode != Prefs.MODE_STANDARD) startNtrip()
    }

    fun stop() {
        running = false
        lm.removeUpdates(phoneListener)
        raw?.stop(); raw = null
        ntrip?.stop(); ntrip = null
        bt?.stop(); bt = null
        rtk?.close(); rtk = null
    }

    private fun startInternal() {
        val p = prefs
        rtk = RtkNative(elmaskDeg = p.elevationMask, glo = false,
            armode = if (p.fixAndHold) RtkNative.ARMODE_FIX_AND_HOLD else RtkNative.ARMODE_CONTINUOUS)
        converter = RawConverter()
        raw = RawGnssSource(lm, onEpoch = { clock, meas ->
            val epoch = converter.convert(clock, meas)
            val engine = rtk
            if (epoch == null || engine == null) {
                status("rtk", "Pas de mesure exploitable (${meas.size} signaux reçus)")
                return@RawGnssSource
            }
            val phase = epoch.L.count { it != 0.0 }
            val dual = epoch.codes.toList().chunked(2).count { it[0] == '5'.code.toByte() }
            val sol = engine.rover(epoch)
            status("signaux", "${epoch.size} signaux, $phase avec phase, $dual sur L5/E5a")
            if (sol == null) { status("rtk", "Calcul en attente : ${engine.lastError.ifEmpty { "—" }}"); return@RawGnssSource }
            val q = Quality.fromRtklib(sol.stat)
            val l = lastPhone
            lastRtkMs = System.currentTimeMillis()
            status("rtk", String.format(Locale.FRANCE, "%s · %d sat · ratio %.1f%s", q.label, sol.nsat, sol.ratio,
                if (engine.hasBase) "" else " · base inconnue"))
            emit(Position(sol.lat, sol.lon, sol.hgt, hypot(sol.sdn, sol.sde), q, sol.nsat,
                if (engine.hasBase) sol.age else null, sol.ratio,
                speedMps = l?.takeIf { it.hasSpeed() }?.speed?.toDouble(),
                bearingDeg = l?.takeIf { it.hasBearing() }?.bearing?.toDouble(), source = "RTKLIB"))
        }, onStatus = { status("brutes", it) })
        if (raw?.start() != true) status("brutes", "Impossible d'activer les mesures brutes")
    }

    private fun startExternal() {
        val adapter = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
        if (adapter == null || prefs.btAddress.isEmpty()) { status("bt", "Aucun récepteur choisi (Réglages RTK)"); return }
        bt = BluetoothReceiver(adapter, prefs.btAddress, onLine = { line ->
            Nmea.parseRmc(line)?.let { lastBtSpeed = it }
            Nmea.parseGga(line)?.let { f ->
                if (f.quality == 0) return@let
                val q = Quality.fromGga(f.quality)
                // précision approximative déduite de la qualité et du HDOP
                val acc = when (q) { Quality.RTK_FIX -> 0.02; Quality.RTK_FLOAT -> 0.3; Quality.DGNSS -> 0.8; else -> 2.5 } *
                    f.hdop.coerceIn(0.5, 5.0)
                status("rtk", "${q.label} · ${f.nsat} sat · HDOP ${f.hdop}")
                emit(Position(f.lat, f.lon, f.alt, acc, q, f.nsat, f.ageS, null,
                    lastBtSpeed?.first, lastBtSpeed?.second, "Récepteur externe"))
            }
        }, onState = { _, msg -> status("bt", msg) })
        bt?.start()
    }

    private fun startNtrip() {
        val cfg = prefs.ntrip
        if (cfg.mountpoint.isEmpty()) { status("ntrip", "Aucune base NTRIP choisie (Réglages RTK)"); return }
        val forward = prefs.mode == Prefs.MODE_EXTERNAL && prefs.btForward
        ntrip = NtripClient(cfg, onData = { b, n ->
            lastBaseMs = System.currentTimeMillis()
            synchronized(framer) { framer.push(b, n) }
            rtk?.base(b, n)
            if (forward) bt?.write(b, n)
        }, onState = { s, msg ->
            status("ntrip", when (s) {
                NtripClient.State.CONNECTED -> "Corrections : $msg"
                NtripClient.State.ERROR -> "Corrections : erreur — $msg"
                else -> "Corrections : $msg"
            })
        }, ggaProvider = {
            val p = lastPos ?: lastPhone?.let { Position(it.latitude, it.longitude, it.altitude, 0.0, Quality.PHONE) }
            p?.let { Nmea.buildGga(it.lat, it.lon, it.alt, (System.currentTimeMillis() / 1000.0) % 86400.0) }
        })
        ntrip?.start()
    }

    private fun emit(p: Position) {
        lastPos = p
        main.post { if (running) onPosition(p) }
    }

    private fun status(key: String, value: String) {
        synchronized(st) {
            st[key] = value
            val e = rtk
            if (e != null && (key == "ntrip" || key == "rtk")) {
                val age = if (lastBaseMs > 0) (System.currentTimeMillis() - lastBaseMs) / 1000 else -1
                val msgs = synchronized(framer) { framer.counts.entries.joinToString(" ") { "${it.key}×${it.value}" } }
                st["base"] = "Base : ${if (e.hasBase) "position reçue" else "position attendue"}, " +
                    "${e.ephemerisCount} éph., dernier message il y a ${if (age < 0) "—" else "$age s"}" +
                    (if (msgs.isNotEmpty()) " ($msgs)" else "")
            }
        }
        val json = synchronized(st) {
            st.entries.joinToString(",", "{", "}") { "\"${it.key}\":\"${it.value.replace("\\", "/").replace("\"", "'")}\"" }
        }
        main.post { onStatus(json) }
    }
}
