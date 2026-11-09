package io.github.martincuypers.fencemapper.rtk

import io.github.martincuypers.fencemapper.core.Epoch

/** Moteur RTK natif (RTKLIB demo5 via JNI, voir src/main/cpp). Thread-safe. */
class RtkNative(elmaskDeg: Double = 15.0, snrMask: Double = 0.0, armode: Int = ARMODE_FIX_AND_HOLD,
                gal: Boolean = true, bds: Boolean = true, glo: Boolean = false, ratio: Double = 3.0) : AutoCloseable {

    private var handle: Long = nativeNew(elmaskDeg, snrMask, armode, gal, bds, glo, ratio)
    private val out = DoubleArray(OUT_N)

    class Solution(val stat: Int, val lat: Double, val lon: Double, val hgt: Double, val nsat: Int,
                   val age: Double, val ratio: Double, val sdn: Double, val sde: Double, val sdu: Double)

    /** Octets RTCM3 de la base. Retourne des drapeaux BASE_*. */
    @Synchronized fun base(data: ByteArray, len: Int): Int = if (handle == 0L) 0 else nativeBase(handle, data, len)

    @Synchronized fun rover(e: Epoch): Solution? {
        if (handle == 0L || e.size == 0) return null
        val st = nativeRover(handle, e.week, e.tow, e.size, e.sys, e.prn, e.codes, e.P, e.L, e.D, e.snr, e.lli, out)
        if (st <= 0) return null
        return Solution(st, out[1], out[2], out[3], out[4].toInt(), out[5], out[6], out[7], out[8], out[9])
    }

    @get:Synchronized val hasBase get() = handle != 0L && nativeHasBase(handle)
    @get:Synchronized val ephemerisCount get() = if (handle == 0L) 0 else nativeEphCount(handle)
    @get:Synchronized val lastError: String get() = if (handle == 0L) "" else nativeError(handle).trim()

    @Synchronized override fun close() {
        if (handle != 0L) nativeFree(handle)
        handle = 0L
    }

    companion object {
        const val ARMODE_OFF = 0; const val ARMODE_CONTINUOUS = 1; const val ARMODE_FIX_AND_HOLD = 3
        const val BASE_OBS = 1; const val BASE_EPH = 2; const val BASE_POS = 4
        private const val OUT_N = 13

        init { System.loadLibrary("fmrtk") }

        @JvmStatic private external fun nativeNew(elmask: Double, snrmask: Double, armode: Int, gal: Boolean,
                                                  bds: Boolean, glo: Boolean, ratio: Double): Long
        @JvmStatic private external fun nativeFree(h: Long)
        @JvmStatic private external fun nativeBase(h: Long, data: ByteArray, len: Int): Int
        @JvmStatic private external fun nativeRover(h: Long, week: Int, tow: Double, n: Int, sys: ByteArray, prn: IntArray,
                                                    codes: ByteArray, P: DoubleArray, L: DoubleArray, D: DoubleArray,
                                                    snr: DoubleArray, lli: IntArray, out: DoubleArray): Int
        @JvmStatic private external fun nativeHasBase(h: Long): Boolean
        @JvmStatic private external fun nativeEphCount(h: Long): Int
        @JvmStatic private external fun nativeError(h: Long): String
    }
}
