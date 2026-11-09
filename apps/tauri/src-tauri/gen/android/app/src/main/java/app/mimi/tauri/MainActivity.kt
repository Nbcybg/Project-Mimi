package app.mimi.tauri

import android.Manifest
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * The Android side of the Mimi shell. packages/ui already speaks to an Android shell through a
 * small contract, so none of this needs a change in the UI:
 *   - window.__mimiBack()        the Back button: closes the topmost popup / goes from a chat to the
 *                                list; false = nothing left, so the app goes to the background
 *   - window.__mimiWake()        called when the app comes back to the front
 *   - window.MimiAndroid.notify  a system notification (the UI hands every notice over, also while
 *                                the page is on screen; the same title + chat replaces itself)
 *   - window.__mimiKeyboard(px)  how far the keyboard overlaps the page (the web view is not resized)
 *   - window.MimiAndroid.signedIn(token)   sign-in / sign-out: starts / stops NotifyService, which
 *                                keeps the notifications coming while the app is in the background
 * It also keeps the page out from under the status bar and navigation bar (edge-to-edge is
 * enforced from Android 15; the UI only reserves space where it uses env(safe-area-inset-*)).
 * The microphone, camera and file pickers of the page are handled by the WebView client of the
 * Tauri runtime; they only need the permissions in AndroidManifest.xml.
 */
class MainActivity : TauriActivity() {
  private var web: WebView? = null

  // The default Back handling only walks the WebView history; the UI has its own (see above).
  override val handleBackNavigation: Boolean = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val content = findViewById<ViewGroup>(android.R.id.content)
    // The colour of the bars' background: the UI's dark theme (<meta name="theme-color">).
    content.setBackgroundColor(0xFF171215.toInt())
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      // The keyboard does not shrink the page: the character and the backdrop must stay where they are.
      // The page is told how far the keyboard overlaps it (CSS px) and lifts only its message box.
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      val overlapPx = maxOf(0, keyboard.bottom - bars.bottom)
      web?.evaluateJavascript("(function(){try{window.__mimiKeyboard&&window.__mimiKeyboard(" + overlapPx / resources.displayMetrics.density + ")}catch(e){}})()", null)
      WindowInsetsCompat.CONSUMED
    }
    val controller = WindowCompat.getInsetsController(window, content)
    controller.isAppearanceLightStatusBars = false
    controller.isAppearanceLightNavigationBars = false
    ViewCompat.requestApplyInsets(content)
  }

  override fun onWebViewCreate(webView: WebView) {
    web = webView
    webView.addJavascriptInterface(MimiBridge(), "MimiAndroid")
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          webView.evaluateJavascript(
            "(function(){try{return !!(window.__mimiBack&&window.__mimiBack())}catch(e){return false}})()",
          ) { handled ->
            if (handled != "true") {
              if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
            }
          }
        }
      },
    )
  }

  override fun onResume() {
    super.onResume()
    web?.evaluateJavascript("(function(){try{window.__mimiWake&&window.__mimiWake()}catch(e){}})()", null)
  }

  /** What packages/ui (and the shell's own script) call as window.MimiAndroid. */
  inner class MimiBridge {
    /** The page tells the shell where its core is (the shell's own script does, from localStorage). */
    @JavascriptInterface
    fun setCore(core: String?) {
      if (!core.isNullOrBlank()) ShellPrefs.of(this@MainActivity).edit().putString("core", core).apply()
    }

    /** A token = signed in (start listening in the background); empty = signed out. */
    @JavascriptInterface
    fun signedIn(token: String?) {
      val prefs = ShellPrefs.of(this@MainActivity)
      if (token.isNullOrBlank()) {
        prefs.edit().remove("token").apply()
        NotifyService.stop(this@MainActivity)
      } else {
        prefs.edit().putString("token", token).apply()
        if (prefs.getBoolean("background", true)) NotifyService.start(this@MainActivity)
      }
    }

    /**
     * Notifications while the app is in the background need a service with a permanent notification
     * ("เชื่อมต่ออยู่ เพื่อรอการแจ้งเตือน") — Android requires it. This is the switch for it (default on).
     */
    @JavascriptInterface
    fun getBackgroundNotify(): Boolean = ShellPrefs.of(this@MainActivity).getBoolean("background", true)

    @JavascriptInterface
    fun setBackgroundNotify(on: Boolean) {
      val prefs = ShellPrefs.of(this@MainActivity)
      prefs.edit().putBoolean("background", on).apply()
      if (on && !prefs.getString("token", null).isNullOrBlank()) NotifyService.start(this@MainActivity) else NotifyService.stop(this@MainActivity)
    }

    @JavascriptInterface
    fun refreshWidget() {}

    @JavascriptInterface
    fun requestNotifications() {
      if (Build.VERSION.SDK_INT < 33 || Notifier.allowed(this@MainActivity)) return
      runOnUiThread {
        ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
      }
    }

    @JavascriptInterface
    fun notify(title: String?, body: String?, @Suppress("UNUSED_PARAMETER") kind: String?, chatId: Int) {
      if (!Notifier.allowed(this@MainActivity)) {
        requestNotifications()
        return
      }
      Notifier.post(this@MainActivity, title, body, chatId)
    }
  }

  private companion object {
    const val REQUEST_NOTIFICATIONS = 4101
  }
}
