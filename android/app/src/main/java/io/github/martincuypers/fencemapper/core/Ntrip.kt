package io.github.martincuypers.fencemapper.core

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.Base64
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

data class NtripConfig(
    val host: String = "caster.centipede.fr",
    val port: Int = 2101,
    val mountpoint: String = "",
    val user: String = "centipede",
    val password: String = "centipede",
)

/** Une base (point de montage) du sourcetable. */
data class Mountpoint(val name: String, val identifier: String, val format: String, val details: String,
                      val navSystems: String, val lat: Double, val lon: Double, val needsGga: Boolean) {
    fun distanceKm(lat0: Double, lon0: Double): Double {
        val r = Math.toRadians(1.0)
        val dLat = (lat - lat0) * r; val dLon = (lon - lon0) * r
        val a = sin(dLat / 2).let { it * it } + cos(lat0 * r) * cos(lat * r) * sin(dLon / 2).let { it * it }
        return 2 * 6371.0 * asin(sqrt(a))
    }
}

object Sourcetable {
    fun parse(text: String): List<Mountpoint> = text.lineSequence()
        .filter { it.startsWith("STR;") }
        .mapNotNull { line ->
            val f = line.split(';')
            if (f.size < 12) return@mapNotNull null
            val lat = f[9].toDoubleOrNull() ?: return@mapNotNull null
            val lon = f[10].toDoubleOrNull() ?: return@mapNotNull null
            Mountpoint(f[1], f[2], f[3], f[4], f[6], lat, lon, f[11] == "1")
        }.toList()

    fun nearest(list: List<Mountpoint>, lat: Double, lon: Double, count: Int = 5) =
        list.filter { it.format.contains("RTCM 3", ignoreCase = true) || it.format.contains("RTCM3", ignoreCase = true) }
            .sortedBy { it.distanceKm(lat, lon) }.take(count)
}

/**
 * Client NTRIP (v1 « ICY 200 OK » et v2 HTTP, y compris en transfert « chunked »).
 * Reçoit le flux RTCM3 d'une base et le passe à [onData] ; se reconnecte automatiquement.
 */
class NtripClient(
    private val cfg: NtripConfig,
    private val onData: (ByteArray, Int) -> Unit,
    private val onState: (State, String) -> Unit,
    private val ggaProvider: () -> String? = { null },
) {
    enum class State { CONNECTING, CONNECTED, ERROR, STOPPED }

    @Volatile private var running = false
    @Volatile private var socket: Socket? = null
    private var thread: Thread? = null
    @Volatile var bytes = 0L; private set

    fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "ntrip").apply { isDaemon = true; start() }
    }

    fun stop() {
        running = false
        try { socket?.close() } catch (_: IOException) {}
        thread?.interrupt()
        onState(State.STOPPED, "Arrêté")
    }

    private fun loop() {
        var delay = 2000L
        while (running) {
            try {
                onState(State.CONNECTING, "Connexion à ${cfg.host}:${cfg.port}/${cfg.mountpoint}…")
                session()
                delay = 2000L
            } catch (e: Exception) {
                if (!running) break
                onState(State.ERROR, e.message ?: e.javaClass.simpleName)
            }
            if (!running) break
            try { Thread.sleep(delay) } catch (_: InterruptedException) { break }
            delay = (delay * 2).coerceAtMost(30_000L)
        }
    }

    private fun session() {
        Socket().use { s ->
            socket = s
            s.connect(InetSocketAddress(cfg.host, cfg.port), 10_000)
            s.soTimeout = 30_000 // pas de données pendant 30 s : on se reconnecte
            val out = s.getOutputStream()
            out.write(request(cfg, "/" + cfg.mountpoint).toByteArray(Charsets.ISO_8859_1))
            ggaProvider()?.let { out.write("$it\r\n".toByteArray()) }
            out.flush()
            val input = BufferedInputStream(s.getInputStream())
            val status = readLine(input) ?: throw IOException("Pas de réponse du caster")
            val chunked: Boolean
            when {
                status.startsWith("ICY 200") -> chunked = false
                status.matches(Regex("HTTP/1\\.[01] 200.*")) -> {
                    var ch = false
                    while (true) {
                        val h = readLine(input) ?: break
                        if (h.isEmpty()) break
                        if (h.lowercase().startsWith("transfer-encoding:") && h.lowercase().contains("chunked")) ch = true
                        if (h.lowercase().startsWith("content-type:") && h.lowercase().contains("sourcetable"))
                            throw IOException("Point de montage « ${cfg.mountpoint} » inconnu")
                    }
                    chunked = ch
                }
                status.startsWith("SOURCETABLE") -> throw IOException("Point de montage « ${cfg.mountpoint} » inconnu")
                status.contains("401") -> throw IOException("Identifiant ou mot de passe refusé")
                else -> throw IOException("Réponse du caster : $status")
            }
            onState(State.CONNECTED, "Connecté à ${cfg.mountpoint}")
            pump(if (chunked) ChunkedInputStream(input) else input, out)
        }
    }

    private fun pump(input: InputStream, out: OutputStream) {
        val buf = ByteArray(4096)
        var lastGga = System.currentTimeMillis()
        while (running) {
            val n = input.read(buf)
            if (n < 0) throw IOException("Connexion fermée par le caster")
            if (n > 0) { bytes += n; onData(buf, n) }
            val now = System.currentTimeMillis()
            if (now - lastGga > 10_000) {
                ggaProvider()?.let { out.write("$it\r\n".toByteArray()); out.flush() }
                lastGga = now
            }
        }
    }

    companion object {
        fun request(cfg: NtripConfig, path: String): String {
            val auth = Base64.getEncoder().encodeToString("${cfg.user}:${cfg.password}".toByteArray())
            return "GET $path HTTP/1.0\r\n" +
                "Host: ${cfg.host}\r\n" +
                "Ntrip-Version: Ntrip/2.0\r\n" +
                "User-Agent: NTRIP FenceMapper/1.0\r\n" +
                (if (cfg.user.isNotEmpty()) "Authorization: Basic $auth\r\n" else "") +
                "Connection: close\r\n\r\n"
        }

        fun readLine(input: InputStream): String? {
            val sb = StringBuilder()
            while (true) {
                val c = input.read()
                if (c < 0) return if (sb.isEmpty()) null else sb.toString()
                if (c == '\n'.code) return sb.toString().trimEnd('\r')
                sb.append(c.toChar())
                if (sb.length > 8192) throw IOException("Ligne trop longue")
            }
        }

        /** Télécharge le sourcetable (liste des bases) du caster. */
        fun fetchSourcetable(cfg: NtripConfig, timeoutMs: Int = 15_000): List<Mountpoint> {
            Socket().use { s ->
                s.connect(InetSocketAddress(cfg.host, cfg.port), timeoutMs)
                s.soTimeout = timeoutMs
                s.getOutputStream().apply { write(request(cfg, "/").toByteArray(Charsets.ISO_8859_1)); flush() }
                val input = BufferedInputStream(s.getInputStream())
                val all = ByteArrayOutputStream()
                val buf = ByteArray(8192)
                while (true) {
                    val n = try { input.read(buf) } catch (_: java.net.SocketTimeoutException) { -1 }
                    if (n < 0) break
                    all.write(buf, 0, n)
                    if (all.toString(Charsets.ISO_8859_1.name()).contains("ENDSOURCETABLE")) break
                }
                return Sourcetable.parse(all.toString(Charsets.ISO_8859_1.name()))
            }
        }
    }
}

/** Décodage du « Transfer-Encoding: chunked » (NTRIP v2 sur HTTP/1.1). */
class ChunkedInputStream(private val src: InputStream) : InputStream() {
    private var remaining = 0
    private var eof = false

    private fun nextChunk(): Boolean {
        if (eof) return false
        var line = NtripClient.readLine(src) ?: return false.also { eof = true }
        if (line.isEmpty()) line = NtripClient.readLine(src) ?: return false.also { eof = true }
        remaining = line.substringBefore(';').trim().toIntOrNull(16) ?: throw IOException("Chunk invalide : $line")
        if (remaining == 0) { eof = true; return false }
        return true
    }

    override fun read(): Int {
        if (remaining == 0 && !nextChunk()) return -1
        val c = src.read()
        if (c >= 0) remaining--
        return c
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (remaining == 0 && !nextChunk()) return -1
        val n = src.read(b, off, minOf(len, remaining))
        if (n > 0) remaining -= n
        return n
    }
}
