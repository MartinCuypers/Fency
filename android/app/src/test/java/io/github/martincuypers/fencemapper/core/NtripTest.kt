package io.github.martincuypers.fencemapper.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class NtripTest {
    private val payload = ByteArray(5000) { (it * 31).toByte() }

    /** Faux caster : renvoie [header] puis le corps produit par [body], et mémorise la requête. */
    private fun caster(header: String, body: (java.io.OutputStream) -> Unit): Pair<Int, StringBuilder> {
        val server = ServerSocket(0); val req = StringBuilder()
        thread(isDaemon = true) {
            server.accept().use { s ->
                val input = s.getInputStream().bufferedReader(Charsets.ISO_8859_1)
                while (true) { val l = input.readLine() ?: break; if (l.isEmpty()) break; req.append(l).append('\n') }
                val out = s.getOutputStream()
                out.write(header.toByteArray()); body(out); out.flush()
                Thread.sleep(300)
            }
            server.close()
        }
        return server.localPort to req
    }

    private fun receive(port: Int, expected: Int): Pair<ByteArray, List<String>> {
        val got = ByteArrayOutputStream(); val states = mutableListOf<String>()
        val done = CountDownLatch(1)
        val c = NtripClient(NtripConfig("127.0.0.1", port, "TEST", "centipede", "centipede"),
            onData = { b, n -> synchronized(got) { got.write(b, 0, n); if (got.size() >= expected) done.countDown() } },
            onState = { s, m -> synchronized(states) { states += "$s:$m" }; if (s == NtripClient.State.ERROR) done.countDown() })
        c.start(); done.await(5, TimeUnit.SECONDS); c.stop()
        return got.toByteArray() to synchronized(states) { states.toList() }
    }

    @Test fun ntripV1() {
        val (port, req) = caster("ICY 200 OK\r\n") { it.write(payload) }
        val (data, _) = receive(port, payload.size)
        assertTrue(data.contentEquals(payload))
        assertTrue(req.contains("GET /TEST HTTP/1.0"))
        assertTrue(req.contains("Authorization: Basic Y2VudGlwZWRlOmNlbnRpcGVkZQ=="))
    }

    @Test fun ntripV2Chunked() {
        val (port, _) = caster("HTTP/1.1 200 OK\r\nContent-Type: gnss/data\r\nTransfer-Encoding: chunked\r\n\r\n") { out ->
            payload.toList().chunked(1234).forEach { c ->
                out.write("${Integer.toHexString(c.size)}\r\n".toByteArray()); out.write(c.toByteArray()); out.write("\r\n".toByteArray())
            }
        }
        val (data, _) = receive(port, payload.size)
        assertTrue(data.contentEquals(payload))
    }

    @Test fun erreurAuthentification() {
        val (port, _) = caster("HTTP/1.1 401 Unauthorized\r\n\r\n") {}
        val (_, states) = receive(port, 1)
        assertTrue(states.any { it.startsWith("ERROR") && it.contains("refusé") })
    }

    @Test fun sourcetableEtBaseLaPlusProche() {
        val st = """SOURCETABLE 200 OK
STR;NANTES;Nantes;RTCM 3.3;1004(1),1006(10),1074(1);2;GPS+GLO+GAL+BDS;NONE;FRA;47.22;-1.55;0;0;sNTRIP;none;B;N;0;
STR;RENNES;Rennes;RTCM 3.3;1074(1);2;GPS+GAL;NONE;FRA;48.11;-1.68;0;0;sNTRIP;none;B;N;0;
STR;LYON;Lyon;RTCM 3.2;1074(1);2;GPS;NONE;FRA;45.76;4.84;0;0;sNTRIP;none;B;N;0;
STR;OLD;Old;RTCM 2.3;1(1);2;GPS;NONE;FRA;48.10;-1.60;0;0;sNTRIP;none;B;N;0;
ENDSOURCETABLE"""
        val list = Sourcetable.parse(st)
        assertEquals(4, list.size)
        val near = Sourcetable.nearest(list, 48.0, -1.7, 2)
        assertEquals(listOf("RENNES", "NANTES"), near.map { it.name })
        assertEquals(12.3, near[0].distanceKm(48.0, -1.7), 0.5)
    }
}
