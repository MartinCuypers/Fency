package io.github.martincuypers.fency.gnss

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothSocket
import java.io.IOException
import java.io.OutputStream
import java.util.UUID

/**
 * Récepteur RTK externe en Bluetooth classique (profil série SPP) : ArduSimple simpleRTK2B
 * avec module Bluetooth, Emlid Reach, etc. Lit le NMEA et peut lui transmettre les
 * corrections RTCM reçues par NTRIP.
 */
class BluetoothReceiver(
    private val adapter: BluetoothAdapter,
    private val address: String,
    private val onLine: (String) -> Unit,
    private val onState: (Boolean, String) -> Unit,
) {
    @Volatile private var running = false
    @Volatile private var socket: BluetoothSocket? = null
    @Volatile private var out: OutputStream? = null
    private var thread: Thread? = null

    fun start() {
        running = true
        thread = Thread({ loop() }, "bt-gnss").apply { isDaemon = true; start() }
    }

    fun stop() {
        running = false
        try { socket?.close() } catch (_: IOException) {}
        thread?.interrupt()
    }

    /** Envoie des octets au récepteur (corrections RTCM). */
    fun write(data: ByteArray, len: Int) {
        val o = out ?: return
        try { o.write(data, 0, len); o.flush() } catch (_: IOException) {}
    }

    @SuppressLint("MissingPermission")
    private fun loop() {
        while (running) {
            try {
                val dev = adapter.getRemoteDevice(address)
                onState(false, "Connexion à ${dev.name ?: address}…")
                adapter.cancelDiscovery()
                val s = dev.createRfcommSocketToServiceRecord(SPP)
                socket = s
                s.connect()
                out = s.outputStream
                onState(true, "Connecté à ${dev.name ?: address}")
                val reader = s.inputStream.bufferedReader(Charsets.US_ASCII)
                while (running) {
                    val line = reader.readLine() ?: break
                    if (line.startsWith("$")) onLine(line.trim())
                }
            } catch (e: Exception) {
                if (running) onState(false, "Récepteur : ${e.message ?: "erreur"}")
            } finally {
                out = null
                try { socket?.close() } catch (_: IOException) {}
            }
            if (running) try { Thread.sleep(3000) } catch (_: InterruptedException) { break }
        }
    }

    companion object {
        val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    }
}
