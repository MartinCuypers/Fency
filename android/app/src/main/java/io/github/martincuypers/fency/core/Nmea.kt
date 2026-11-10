package io.github.martincuypers.fency.core

import java.util.Locale
import kotlin.math.abs
import kotlin.math.floor

/** Position décodée d'un récepteur externe (NMEA GGA + RMC). */
data class NmeaFix(
    val lat: Double, val lon: Double, val alt: Double,
    val quality: Int,   // 0 aucune, 1 autonome, 2 DGNSS, 4 RTK FIX, 5 RTK FLOAT
    val nsat: Int, val hdop: Double, val ageS: Double?,
)

object Nmea {
    fun checksumOk(line: String): Boolean {
        val star = line.lastIndexOf('*')
        if (!line.startsWith("$") || star < 0 || star + 3 > line.length) return false
        val expect = line.substring(star + 1, star + 3).toIntOrNull(16) ?: return false
        return checksum(line.substring(1, star)) == expect
    }

    fun checksum(body: String): Int = body.fold(0) { acc, c -> acc xor c.code }

    private fun coord(v: String, hemi: String): Double? {
        if (v.isEmpty()) return null
        val x = v.toDoubleOrNull() ?: return null
        val deg = floor(x / 100.0)
        val res = deg + (x - deg * 100.0) / 60.0
        return if (hemi == "S" || hemi == "W") -res else res
    }

    /** Décode une phrase GGA (tous talkers : GP, GN, GA...). */
    fun parseGga(line: String): NmeaFix? {
        if (!checksumOk(line)) return null
        val f = line.substring(1, line.lastIndexOf('*')).split(',')
        if (f.size < 14 || !f[0].endsWith("GGA")) return null
        val lat = coord(f[2], f[3]) ?: return null
        val lon = coord(f[4], f[5]) ?: return null
        return NmeaFix(
            lat, lon, (f[9].toDoubleOrNull() ?: 0.0) + (f[11].toDoubleOrNull() ?: 0.0),
            f[6].toIntOrNull() ?: 0, f[7].toIntOrNull() ?: 0, f[8].toDoubleOrNull() ?: 99.0, f[13].toDoubleOrNull(),
        )
    }

    /** Vitesse (m/s) et cap (degrés) d'une phrase RMC. */
    fun parseRmc(line: String): Pair<Double, Double?>? {
        if (!checksumOk(line)) return null
        val f = line.substring(1, line.lastIndexOf('*')).split(',')
        if (f.size < 9 || !f[0].endsWith("RMC") || f[2] != "A") return null
        val knots = f[7].toDoubleOrNull() ?: return null
        return knots * 0.514444 to f[8].toDoubleOrNull()
    }

    /** Construit une phrase GGA (envoyée au caster NTRIP, requis par les bases virtuelles). */
    fun buildGga(lat: Double, lon: Double, alt: Double, utcSeconds: Double, quality: Int = 1, nsat: Int = 10): String {
        fun dm(v: Double, degDigits: Int): String {
            val a = abs(v); val d = floor(a); val m = (a - d) * 60.0
            return String.format(Locale.US, "%0${degDigits}d%07.4f", d.toInt(), m)
        }
        val s = ((utcSeconds % 86400.0) + 86400.0) % 86400.0
        val hh = (s / 3600).toInt(); val mm = ((s % 3600) / 60).toInt(); val ss = s % 60
        val body = String.format(
            Locale.US, "GPGGA,%02d%02d%05.2f,%s,%s,%s,%s,%d,%02d,1.0,%.1f,M,0.0,M,,",
            hh, mm, ss, dm(lat, 2), if (lat >= 0) "N" else "S", dm(lon, 3), if (lon >= 0) "E" else "W",
            quality, nsat, alt,
        )
        return String.format(Locale.US, "$%s*%02X", body, checksum(body))
    }
}
