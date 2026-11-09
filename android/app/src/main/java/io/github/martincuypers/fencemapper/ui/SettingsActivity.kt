package io.github.martincuypers.fencemapper.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import io.github.martincuypers.fencemapper.Prefs
import io.github.martincuypers.fencemapper.core.NtripClient
import io.github.martincuypers.fencemapper.core.NtripConfig
import io.github.martincuypers.fencemapper.core.Sourcetable
import java.util.Locale
import kotlin.concurrent.thread

/** Réglages : source de position, caster NTRIP, récepteur Bluetooth, options RTK. */
class SettingsActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var col: LinearLayout
    private val ids = mutableMapOf<String, Int>()

    private lateinit var modeGroup: RadioGroup
    private lateinit var host: EditText; private lateinit var port: EditText; private lateinit var mount: EditText
    private lateinit var user: EditText; private lateinit var pass: EditText
    private lateinit var btLabel: TextView; private lateinit var btForward: CheckBox
    private lateinit var elmask: EditText; private lateinit var hold: CheckBox

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Réglages RTK"
        prefs = Prefs(this)
        col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(12), dp(16), dp(32)) }
        setContentView(ScrollView(this).apply { addView(col) })

        h("Source de position")
        modeGroup = RadioGroup(this)
        listOf(
            Prefs.MODE_INTERNAL to "RTK avec le GPS du téléphone (mesures brutes + corrections) — 10 à 50 cm au mieux",
            Prefs.MODE_EXTERNAL to "Récepteur RTK externe en Bluetooth — 1 à 2 cm",
            Prefs.MODE_STANDARD to "GPS standard du téléphone — 2 à 5 m",
        ).forEachIndexed { i, (key, label) ->
            val rb = RadioButton(this).apply { id = View.generateViewId(); text = label; tag = key }
            ids[key] = rb.id
            modeGroup.addView(rb)
        }
        modeGroup.check(ids[prefs.mode] ?: ids[Prefs.MODE_INTERNAL]!!)
        col.addView(modeGroup)
        button("Diagnostic du téléphone (mesures brutes, phase, L5)") {
            startActivity(Intent(this, DiagnosticActivity::class.java))
        }

        h("Corrections NTRIP")
        note("Centipede (réseau communautaire gratuit) : caster.centipede.fr, port 2101, identifiant et mot de passe « centipede ». Choisissez une base à moins de 20 à 30 km.")
        val c = prefs.ntrip
        host = field("Caster", c.host); port = field("Port", c.port.toString(), InputType.TYPE_CLASS_NUMBER)
        mount = field("Point de montage (base)", c.mountpoint)
        user = field("Identifiant", c.user); pass = field("Mot de passe", c.password, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        button("Choisir la base la plus proche") { chooseMount() }

        h("Récepteur externe (Bluetooth)")
        note("Appairez d'abord le récepteur dans les réglages Bluetooth d'Android (profil série SPP).")
        btLabel = TextView(this).apply { text = prefs.btName.ifEmpty { "Aucun récepteur choisi" } }
        col.addView(btLabel)
        button("Choisir le récepteur") { chooseBluetooth() }
        btForward = check("Envoyer les corrections NTRIP au récepteur", prefs.btForward)

        h("Options RTK (mode téléphone)")
        elmask = field("Masque d'élévation (degrés)", prefs.elevationMask.toInt().toString(), InputType.TYPE_CLASS_NUMBER)
        hold = check("Fix-and-hold (recommandé)", prefs.fixAndHold)
        note("Conseils : téléphone à plat, ciel dégagé, sur un plan de masse métallique (disque d'environ 10 cm). Comptez quelques minutes de convergence. Avant Android 12, activez l'option développeur « Forcer les mesures GNSS complètes ».")

        button("Enregistrer", primary = true) { save(); finish() }
    }

    private fun save() {
        prefs.mode = col.findViewById<RadioButton>(modeGroup.checkedRadioButtonId)?.tag as? String ?: Prefs.MODE_INTERNAL
        prefs.ntrip = NtripConfig(host.text.toString().trim(), port.text.toString().toIntOrNull() ?: 2101,
            mount.text.toString().trim(), user.text.toString().trim(), pass.text.toString())
        prefs.btForward = btForward.isChecked
        prefs.elevationMask = elmask.text.toString().toDoubleOrNull()?.coerceIn(0.0, 45.0) ?: 15.0
        prefs.fixAndHold = hold.isChecked
        Toast.makeText(this, "Réglages enregistrés", Toast.LENGTH_SHORT).show()
    }

    @SuppressLint("MissingPermission")
    private fun chooseMount() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 1)
            return
        }
        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val loc = lm.getProviders(true).mapNotNull { lm.getLastKnownLocation(it) }.maxByOrNull { it.time }
        val cfg = NtripConfig(host.text.toString().trim(), port.text.toString().toIntOrNull() ?: 2101, "",
            user.text.toString().trim(), pass.text.toString())
        Toast.makeText(this, "Téléchargement de la liste des bases…", Toast.LENGTH_SHORT).show()
        thread {
            val result = runCatching { NtripClient.fetchSourcetable(cfg) }
            runOnUiThread {
                val list = result.getOrElse {
                    Toast.makeText(this, "Échec : ${it.message}", Toast.LENGTH_LONG).show(); return@runOnUiThread
                }
                if (list.isEmpty()) { Toast.makeText(this, "Aucune base trouvée", Toast.LENGTH_LONG).show(); return@runOnUiThread }
                val sorted = if (loc != null) Sourcetable.nearest(list, loc.latitude, loc.longitude, 12) else list.sortedBy { it.name }
                val labels = sorted.map { m ->
                    (if (loc != null) String.format(Locale.FRANCE, "%s — %.1f km", m.name, m.distanceKm(loc.latitude, loc.longitude)) else m.name) +
                        " (${m.navSystems})"
                }.toTypedArray()
                AlertDialog.Builder(this)
                    .setTitle(if (loc != null) "Bases les plus proches" else "Bases (position inconnue)")
                    .setItems(labels) { _, i -> mount.setText(sorted[i].name) }
                    .setNegativeButton("Annuler", null).show()
            }
        }
    }

    @SuppressLint("MissingPermission")
    private fun chooseBluetooth() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), 2); return
        }
        val adapter = (getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
        val devices = adapter?.bondedDevices?.toList().orEmpty()
        if (devices.isEmpty()) { Toast.makeText(this, "Aucun appareil Bluetooth appairé", Toast.LENGTH_LONG).show(); return }
        AlertDialog.Builder(this).setTitle("Récepteur GNSS")
            .setItems(devices.map { "${it.name ?: "?"} (${it.address})" }.toTypedArray()) { _, i ->
                prefs.btAddress = devices[i].address; prefs.btName = devices[i].name ?: devices[i].address
                btLabel.text = prefs.btName
                modeGroup.check(ids[Prefs.MODE_EXTERNAL]!!)
            }.setNegativeButton("Annuler", null).show()
    }

    // --- petits constructeurs de vues ---
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun h(text: String) = col.addView(TextView(this).apply {
        this.text = text; textSize = 18f; setTypeface(typeface, Typeface.BOLD); setPadding(0, dp(18), 0, dp(6))
    })
    private fun note(text: String) = col.addView(TextView(this).apply { this.text = text; textSize = 13f; alpha = 0.75f })
    private fun field(label: String, value: String, type: Int = InputType.TYPE_CLASS_TEXT): EditText {
        col.addView(TextView(this).apply { text = label; textSize = 13f; setPadding(0, dp(8), 0, 0) })
        return EditText(this).apply { setText(value); inputType = type; isSingleLine = true }.also { col.addView(it, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT)) }
    }
    private fun check(label: String, value: Boolean) = CheckBox(this).apply { text = label; isChecked = value }.also { col.addView(it) }
    private fun button(label: String, primary: Boolean = false, onClick: () -> Unit) =
        col.addView(Button(this).apply {
            text = label; isAllCaps = false; setOnClickListener { onClick() }
            if (primary) setTypeface(typeface, Typeface.BOLD)
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(8) })
}
