package io.github.martincuypers.fency.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import io.github.martincuypers.fency.PositionEngine
import io.github.martincuypers.fency.Prefs
import java.io.IOException

/**
 * Héberge l'interface web de Fency (copiée dans assets/www) et lui fournit
 * les positions RTK via window.fmNative.onPosition(...).
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var engine: PositionEngine
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingSave: String? = null
    private var startAfterPermission = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        engine = PositionEngine(this,
            onPosition = { js("window.fmNative && fmNative.onPosition(${it.toJson()})") },
            onStatus = { js("window.fmNative && fmNative.onStatus($it)") })

        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
        }
        web.addJavascriptInterface(Bridge(), "FencyAndroid")
        web.webViewClient = object : WebViewClient() {
            // Sert les fichiers de l'interface depuis assets/www sous une origine https
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                val url = req.url
                if (url.host != HOST) return null
                val path = url.path?.trimStart('/')?.ifEmpty { "index.html" } ?: "index.html"
                return try {
                    WebResourceResponse(mime(path), if (mime(path).startsWith("text") || path.endsWith(".js")) "utf-8" else null,
                        assets.open("www/$path"))
                } catch (_: IOException) {
                    WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "".byteInputStream())
                }
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = cb
                return try { startActivityForResult(params.createIntent(), REQ_OPEN); true } catch (_: Exception) { fileCallback = null; false }
            }
        }
        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl("https://$HOST/index.html")
    }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); web.saveState(outState) }

    override fun onDestroy() { engine.stop(); web.destroy(); super.onDestroy() }

    @Deprecated("Activity sans AndroidX")
    override fun onBackPressed() { if (web.canGoBack()) web.goBack() else super.onBackPressed() }

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }

    private fun neededPermissions(): Array<String> {
        val list = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Prefs(this).mode == Prefs.MODE_EXTERNAL && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            list += Manifest.permission.BLUETOOTH_CONNECT
        return list.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }.toTypedArray()
    }

    private fun startEngine() {
        val missing = neededPermissions()
        if (missing.isNotEmpty()) { startAfterPermission = true; requestPermissions(missing, REQ_PERM); return }
        engine.start()
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        if (code == REQ_PERM && startAfterPermission) {
            startAfterPermission = false
            if (results.all { it == PackageManager.PERMISSION_GRANTED }) engine.start()
            else Toast.makeText(this, "Autorisation de localisation nécessaire", Toast.LENGTH_LONG).show()
        }
    }

    @Deprecated("Activity sans AndroidX")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            REQ_OPEN -> {
                fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
                fileCallback = null
            }
            REQ_SAVE -> {
                val uri = data?.data
                val content = pendingSave
                pendingSave = null
                if (resultCode == RESULT_OK && uri != null && content != null) {
                    try {
                        contentResolver.openOutputStream(uri)?.use { it.write(content.toByteArray()) }
                        Toast.makeText(this, "Plan enregistré", Toast.LENGTH_SHORT).show()
                    } catch (e: IOException) {
                        Toast.makeText(this, "Échec de l'enregistrement : ${e.message}", Toast.LENGTH_LONG).show()
                    }
                }
            }
        }
    }

    /** Fonctions appelées depuis le JavaScript (window.FencyAndroid). */
    inner class Bridge {
        @JavascriptInterface fun start() = runOnUiThread { startEngine() }
        @JavascriptInterface fun stop() = runOnUiThread { engine.stop() }
        @JavascriptInterface fun isRunning() = engine.running
        @JavascriptInterface fun openSettings() = runOnUiThread {
            engine.stop()
            startActivity(Intent(this@MainActivity, SettingsActivity::class.java))
        }
        @JavascriptInterface fun saveFile(name: String, content: String) = runOnUiThread {
            pendingSave = content
            startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE); type = "application/geo+json"; putExtra(Intent.EXTRA_TITLE, name)
            }, REQ_SAVE)
        }
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
        private const val REQ_PERM = 1; private const val REQ_OPEN = 2; private const val REQ_SAVE = 3

        fun mime(path: String) = when (path.substringAfterLast('.').lowercase()) {
            "html" -> "text/html"; "js", "mjs" -> "application/javascript"; "css" -> "text/css"
            "svg" -> "image/svg+xml"; "png" -> "image/png"; "json", "webmanifest" -> "application/json"
            "woff2" -> "font/woff2"; else -> "application/octet-stream"
        }
    }
}
