package io.github.martincuypers.fencemapper.core

import java.util.Locale

/** Qualité de la position, du meilleur au moins bon. */
enum class Quality(val label: String) {
    RTK_FIX("RTK FIX"), RTK_FLOAT("RTK FLOAT"), DGNSS("DGNSS"), AUTONOMOUS("Autonome"), PHONE("GPS téléphone"), NONE("—");

    companion object {
        /** Statut RTKLIB (1 fix, 2 float, 4 DGNSS, 5 autonome). */
        fun fromRtklib(stat: Int) = when (stat) { 1 -> RTK_FIX; 2 -> RTK_FLOAT; 4 -> DGNSS; 5 -> AUTONOMOUS; else -> NONE }
        /** Qualité NMEA GGA. */
        fun fromGga(q: Int) = when (q) { 4 -> RTK_FIX; 5 -> RTK_FLOAT; 2, 9 -> DGNSS; 1 -> AUTONOMOUS; else -> NONE }
    }
}

data class Position(
    val lat: Double, val lon: Double, val alt: Double,
    val accuracyM: Double,          // précision horizontale estimée (1 sigma)
    val quality: Quality,
    val nsat: Int = 0,
    val ageS: Double? = null,       // âge des corrections
    val ratio: Double? = null,      // ratio-test de fixation
    val speedMps: Double? = null,
    val bearingDeg: Double? = null,
    val source: String = "",
    val timeMs: Long = System.currentTimeMillis(),
) {
    fun toJson(): String {
        fun d(v: Double?, digits: Int) = if (v == null || v.isNaN()) "null" else String.format(Locale.US, "%.${digits}f", v)
        return "{\"lat\":${d(lat, 9)},\"lon\":${d(lon, 9)},\"alt\":${d(alt, 3)},\"acc\":${d(accuracyM, 3)}," +
            "\"quality\":\"${quality.name}\",\"label\":\"${quality.label}\",\"nsat\":$nsat,\"age\":${d(ageS, 1)}," +
            "\"ratio\":${d(ratio, 1)},\"speed\":${d(speedMps, 2)},\"bearing\":${d(bearingDeg, 1)}," +
            "\"source\":\"${source.replace("\"", "'")}\",\"time\":$timeMs}"
    }
}
