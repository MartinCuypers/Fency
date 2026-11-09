package io.github.martincuypers.fencemapper.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NmeaTest {
    @Test fun ggaClassique() {
        val f = Nmea.parseGga("\$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47")!!
        assertEquals(48.1173, f.lat, 1e-6); assertEquals(11.516667, f.lon, 1e-6)
        assertEquals(1, f.quality); assertEquals(8, f.nsat)
    }

    @Test fun ggaRtkFixeEtChecksumFaux() {
        val line = Nmea.buildGga(47.2345678, -1.5678901, 35.2, 45296.5, quality = 4, nsat = 21)
        val f = Nmea.parseGga(line.replace("GPGGA", "GPGGA"))!!
        assertEquals(4, f.quality); assertEquals(47.2345678, f.lat, 1e-6); assertEquals(-1.5678901, f.lon, 1e-6)
        assertTrue(line.startsWith("\$GPGGA,123456.50,"))
        assertNull(Nmea.parseGga(line.dropLast(1) + "0"))
    }

    @Test fun rmc() {
        val body = "GNRMC,123519,A,4807.038,N,01131.000,E,10.0,084.4,230394,003.1,W"
        val line = "$" + body + "*" + "%02X".format(Nmea.checksum(body))
        val (speed, course) = Nmea.parseRmc(line)!!
        assertEquals(5.14444, speed, 1e-4); assertNotNull(course); assertEquals(84.4, course!!, 1e-9)
    }
}
