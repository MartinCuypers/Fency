package io.github.martincuypers.fencemapper

import android.content.Context
import io.github.martincuypers.fencemapper.core.NtripConfig

/** Réglages persistants. */
class Prefs(ctx: Context) {
    private val p = ctx.getSharedPreferences("fencemapper", Context.MODE_PRIVATE)

    var mode: String
        get() = p.getString("mode", MODE_INTERNAL) ?: MODE_INTERNAL
        set(v) = p.edit().putString("mode", v).apply()

    var ntrip: NtripConfig
        get() = NtripConfig(
            p.getString("ntrip.host", "caster.centipede.fr") ?: "",
            p.getInt("ntrip.port", 2101),
            p.getString("ntrip.mount", "") ?: "",
            p.getString("ntrip.user", "centipede") ?: "",
            p.getString("ntrip.pass", "centipede") ?: "",
        )
        set(c) = p.edit().putString("ntrip.host", c.host).putInt("ntrip.port", c.port).putString("ntrip.mount", c.mountpoint)
            .putString("ntrip.user", c.user).putString("ntrip.pass", c.password).apply()

    var btAddress: String
        get() = p.getString("bt.address", "") ?: ""
        set(v) = p.edit().putString("bt.address", v).apply()
    var btName: String
        get() = p.getString("bt.name", "") ?: ""
        set(v) = p.edit().putString("bt.name", v).apply()
    /** Transmettre les corrections NTRIP au récepteur externe (inutile s'il a son propre accès NTRIP). */
    var btForward: Boolean
        get() = p.getBoolean("bt.forward", true)
        set(v) = p.edit().putBoolean("bt.forward", v).apply()

    var elevationMask: Double
        get() = p.getFloat("rtk.elmask", 15f).toDouble()
        set(v) = p.edit().putFloat("rtk.elmask", v.toFloat()).apply()
    var useGlonass: Boolean
        get() = p.getBoolean("rtk.glo", false)
        set(v) = p.edit().putBoolean("rtk.glo", v).apply()
    /** Fix-and-hold (recommandé) ou continu. */
    var fixAndHold: Boolean
        get() = p.getBoolean("rtk.hold", true)
        set(v) = p.edit().putBoolean("rtk.hold", v).apply()

    companion object {
        const val MODE_INTERNAL = "internal"
        const val MODE_EXTERNAL = "external"
        const val MODE_STANDARD = "standard"
    }
}
