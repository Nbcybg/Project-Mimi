package app.mimi.android;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * The Mimi web client in the app's own WebView. Unlike the Chrome-based app before it, the
 * microphone and camera are this app's permissions: asked for at the first start and again
 * when the page wants them. Remembers the sign-in token for the home-screen widget.
 */
public class MainActivity extends Activity {
    private static final int ASK_AT_START = 1;
    private static final int ASK_FOR_PAGE = 2;
    private static final int PICK_FILE = 3;
    private static final int ASK_NOTIFICATIONS = 4;
    private static final String TOKEN_JS =
        "(function(){try{return sessionStorage.getItem('mimi-token')||localStorage.getItem('mimi-token')||''}catch(e){return ''}})()";

    private static final String DOWNLOAD_NAMES_JS =
        "(function(){if(window.__mimiDl)return;window.__mimiDl={};const c=HTMLAnchorElement.prototype.click;"
            + "HTMLAnchorElement.prototype.click=function(){if(this.download)window.__mimiDl[this.href]=this.download;return c.call(this)}})()";

    /** True while the app is on screen (no reply notifications then). */
    static volatile boolean visible;

    private WebView web;
    private PermissionRequest pendingRequest;
    private ValueCallback<Uri[]> pendingFiles;
    private Uri photoUri;
    private MediaPlayer soundPlayer;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#141618"));
        setContentView(web);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setUserAgentString(settings.getUserAgentString() + " MimiAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);

        web.addJavascriptInterface(new Bridge(), "MimiAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                // The Mimi server stays in the app; everything else (sign-in pages, links, APKs) opens in the browser.
                if ("https".equals(url.getScheme()) && BuildConfig.MIMI_HOST.equals(url.getHost())) return false;
                openOutside(url);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Files the page makes (blob: links) are saved by the app: remember their names.
                view.evaluateJavascript(DOWNLOAD_NAMES_JS, null);
                rememberToken();
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> answerPage(request));
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                return chooseFile(callback, params);
            }
        });
        web.setDownloadListener((url, userAgent, disposition, mime, length) -> {
            if (url.startsWith("blob:")) {
                // A file the page made itself: read it in the page and hand it over as base64.
                web.evaluateJavascript(
                    "(async()=>{const u=" + JSONObject.quote(url) + ";const n=(window.__mimiDl||{})[u]||'mimi-file';"
                        + "const b=await(await fetch(u)).blob();const f=new FileReader();"
                        + "f.onload=()=>MimiAndroid.saveFile(n,b.type||'application/octet-stream',String(f.result).split(',')[1]||'');"
                        + "f.readAsDataURL(b)})()",
                    null);
            } else {
                openOutside(Uri.parse(url));
            }
        });

        if (savedInstanceState == null) web.loadUrl(startUrl(getIntent()));
        else web.restoreState(savedInstanceState);
        askAtStart();
        askNotificationsOnce();
        SyncJob.schedule(this);
        PushService.start(this);
    }

    /** The launch page, or the chat a widget row / link points at. */
    private String startUrl(Intent intent) {
        long chat = intent != null ? intent.getLongExtra("chat", 0) : 0;
        if (chat > 0) return BuildConfig.LAUNCH_URL + "&chat=" + chat;
        Uri data = intent != null ? intent.getData() : null;
        if (data != null && BuildConfig.MIMI_HOST.equals(data.getHost())) return data.toString();
        return BuildConfig.LAUNCH_URL;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent.getLongExtra("chat", 0) > 0 || intent.getData() != null) web.loadUrl(startUrl(intent));
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        web.onResume();
        PushService.start(this); // after signing in, the token is there for the first time
        // The page treats the app as on screen again (its own visibility may lag behind the activity).
        web.evaluateJavascript("window.__mimiSetVisible&&window.__mimiSetVisible(true)", null);
        // The screen was off or the app folded away: the socket inside the page may be dead
        // without the page having noticed. Ask it to check and reconnect, then resync the chat.
        web.evaluateJavascript("window.__mimiWake&&window.__mimiWake()", null);
        WidgetSync.markSeen(this);
    }

    @Override
    protected void onPause() {
        visible = false;
        // Say so before the WebView is paused: new replies must become notifications.
        web.evaluateJavascript("window.__mimiSetVisible&&window.__mimiSetVisible(false)", null);
        rememberToken();
        WidgetSync.markSeen(this);
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    /** The widget asks the server with the same token the page signed in with. */
    private void rememberToken() {
        if (web == null) return;
        web.evaluateJavascript(TOKEN_JS, (value) -> {
            String token = "";
            try {
                token = new JSONArray("[" + value + "]").getString(0);
            } catch (Exception ignored) {
                // not a string: nobody signed in
            }
            WidgetSync.setToken(this, token);
        });
    }

    private void openOutside(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, url.toString(), Toast.LENGTH_LONG).show();
        }
    }

    // ---------- permissions ----------

    private boolean granted(String permission) {
        return Build.VERSION.SDK_INT < 23 || checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    /** The first start asks for the microphone, the camera and notifications in one go. */
    private void askAtStart() {
        if (Build.VERSION.SDK_INT < 23) return;
        if (getPreferences(MODE_PRIVATE).getBoolean("asked", false)) return;
        getPreferences(MODE_PRIVATE).edit().putBoolean("asked", true).apply();
        List<String> wanted = new ArrayList<>();
        wanted.add(Manifest.permission.RECORD_AUDIO);
        wanted.add(Manifest.permission.CAMERA);
        if (Build.VERSION.SDK_INT >= 33) {
            wanted.add(Manifest.permission.POST_NOTIFICATIONS);
            getPreferences(MODE_PRIVATE).edit().putBoolean("askedNotif", true).apply();
        }
        List<String> missing = new ArrayList<>();
        for (String permission : wanted) if (!granted(permission)) missing.add(permission);
        if (!missing.isEmpty()) requestPermissions(missing.toArray(new String[0]), ASK_AT_START);
    }

    /** An install from before Android 13 support asks for notifications once after the update too. */
    private void askNotificationsOnce() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (getPreferences(MODE_PRIVATE).getBoolean("askedNotif", false)) return;
        getPreferences(MODE_PRIVATE).edit().putBoolean("askedNotif", true).apply();
        if (!granted(Manifest.permission.POST_NOTIFICATIONS)) requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, ASK_NOTIFICATIONS);
        else confirmNotifications();
    }

    private boolean notificationsAllowed() {
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) return false;
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        return manager == null || Build.VERSION.SDK_INT < 24 || manager.areNotificationsEnabled();
    }

    /** Shows the test card once, so the user can see notifications actually work. */
    private void confirmNotifications() {
        if (getPreferences(MODE_PRIVATE).getBoolean("notifConfirmed", false)) return;
        getPreferences(MODE_PRIVATE).edit().putBoolean("notifConfirmed", true).apply();
        WidgetSync.notifyPermissionGranted(this);
    }

    /** Asked from the page (on send) or when the user opens the notification settings. */
    private void askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, ASK_NOTIFICATIONS);
            return;
        }
        if (notificationsAllowed()) confirmNotifications();
        else Toast.makeText(this, R.string.notificationsOffHint, Toast.LENGTH_LONG).show();
    }

    /** The page wants the microphone or the camera (getUserMedia). */
    private void answerPage(PermissionRequest request) {
        List<String> missing = new ArrayList<>();
        for (String resource : request.getResources()) {
            String permission = permissionFor(resource);
            if (permission != null && !granted(permission)) missing.add(permission);
        }
        if (missing.isEmpty()) {
            grantKnown(request);
            return;
        }
        if (pendingRequest != null) pendingRequest.deny();
        pendingRequest = request;
        requestPermissions(missing.toArray(new String[0]), ASK_FOR_PAGE);
    }

    private static String permissionFor(String resource) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) return Manifest.permission.RECORD_AUDIO;
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) return Manifest.permission.CAMERA;
        return null;
    }

    /** Grants what Android allowed; denies when nothing is left. */
    private void grantKnown(PermissionRequest request) {
        List<String> allowed = new ArrayList<>();
        for (String resource : request.getResources()) {
            String permission = permissionFor(resource);
            if (permission != null && granted(permission)) allowed.add(resource);
        }
        if (allowed.isEmpty()) request.deny();
        else request.grant(allowed.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == ASK_FOR_PAGE && pendingRequest != null) {
            PermissionRequest request = pendingRequest;
            pendingRequest = null;
            grantKnown(request);
            if (!granted(Manifest.permission.RECORD_AUDIO) || !granted(Manifest.permission.CAMERA)) {
                Toast.makeText(this, R.string.permissionHint, Toast.LENGTH_LONG).show();
            }
        }
        if (code == ASK_AT_START || code == ASK_NOTIFICATIONS) {
            boolean askedNotifications = code == ASK_NOTIFICATIONS;
            for (String permission : permissions) if (Manifest.permission.POST_NOTIFICATIONS.equals(permission)) askedNotifications = true;
            if (askedNotifications) {
                if (granted(Manifest.permission.POST_NOTIFICATIONS)) {
                    confirmNotifications();
                    WidgetSync.refreshAsync(this);
                } else {
                    Toast.makeText(this, R.string.notificationsOffHint, Toast.LENGTH_LONG).show();
                }
            }
        }
    }

    // ---------- files and the camera ----------

    private boolean chooseFile(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        if (pendingFiles != null) pendingFiles.onReceiveValue(null);
        pendingFiles = callback;
        photoUri = null;
        boolean wantsImage = false;
        for (String type : params.getAcceptTypes()) if (type.startsWith("image/")) wantsImage = true;
        Intent camera = null;
        if (wantsImage && granted(Manifest.permission.CAMERA)) {
            try {
                File dir = new File(getCacheDir(), "camera");
                dir.mkdirs();
                File photo = new File(dir, "photo-" + System.currentTimeMillis() + ".jpg");
                photoUri = FileProvider.getUriForFile(this, getPackageName() + ".files", photo);
                camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                camera.putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
                camera.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception error) {
                camera = null;
            }
        } else if (wantsImage && params.isCaptureEnabled()) {
            requestPermissions(new String[] {Manifest.permission.CAMERA}, ASK_AT_START);
        }
        Intent intent;
        if (camera != null && params.isCaptureEnabled()) {
            intent = camera;
        } else {
            Intent pick = params.createIntent();
            if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            intent = Intent.createChooser(pick, null);
            if (camera != null) intent.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[] {camera});
        }
        try {
            startActivityForResult(intent, PICK_FILE);
            return true;
        } catch (ActivityNotFoundException error) {
            pendingFiles = null;
            return false;
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != PICK_FILE || pendingFiles == null) return;
        Uri[] files = null;
        if (result == RESULT_OK) {
            if (data != null && data.getClipData() != null) {
                files = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < files.length; i++) files[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data != null && data.getData() != null) {
                files = new Uri[] {data.getData()};
            } else if (photoUri != null) {
                files = new Uri[] {photoUri}; // the camera wrote its photo where it was told
            }
        }
        pendingFiles.onReceiveValue(files);
        pendingFiles = null;
    }

    /**
     * Play a short app sound on the notification stream. Android keeps media and
     * notification volumes apart: a page's AudioContext would follow media volume,
     * so the app plays these natively with USAGE_NOTIFICATION instead.
     */
    private void playNativeSound(String kind) {
        if (soundPlayer != null) {
            try {
                soundPlayer.release();
            } catch (Exception ignored) {
                // already released
            }
            soundPlayer = null;
        }
        String file = "chime".equals(kind) ? null
            : "sent".equals(kind) ? "/sounds/chat_1.mp3"
            : "done".equals(kind) ? "/sounds/chat_2.mp3"
            : "ask".equals(kind) ? "/sounds/chat_3.mp3"
            : null;
        AudioAttributes attributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        if (file != null) {
            try {
                MediaPlayer player = new MediaPlayer();
                player.setAudioAttributes(attributes);
                player.setDataSource("https://" + BuildConfig.MIMI_HOST + file);
                player.setOnPreparedListener(MediaPlayer::start);
                player.setOnCompletionListener((done) -> done.release());
                player.setOnErrorListener((failed, what, extra) -> {
                    failed.release();
                    playSystemTone(attributes);
                    return true;
                });
                soundPlayer = player;
                player.prepareAsync();
                return;
            } catch (Exception ignored) {
                // fall through to the system notification tone
            }
        }
        playSystemTone(attributes);
    }

    private void playSystemTone(AudioAttributes attributes) {
        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            Ringtone tone = RingtoneManager.getRingtone(this, uri);
            if (tone != null) {
                tone.setAudioAttributes(attributes);
                tone.play();
            }
        } catch (Exception ignored) {
            // the phone may have no notification tone
        }
    }

    /** What the page calls as window.MimiAndroid. */
    private class Bridge {
        @JavascriptInterface
        public void saveFile(String name, String mime, String base64) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String where;
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    values.put(MediaStore.Downloads.MIME_TYPE, mime);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                        out.write(bytes);
                    }
                    where = "Download/" + name;
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    File file = new File(dir, name);
                    try (FileOutputStream out = new FileOutputStream(file)) {
                        out.write(bytes);
                    }
                    where = file.getPath();
                }
                String saved = getString(R.string.saved, where);
                runOnUiThread(() -> Toast.makeText(MainActivity.this, saved, Toast.LENGTH_LONG).show());
            } catch (Exception error) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, String.valueOf(error.getMessage()), Toast.LENGTH_LONG).show());
            }
        }

        /** The page signed in or out: the widget follows. */
        @JavascriptInterface
        public void signedIn(String token) {
            WidgetSync.setToken(MainActivity.this, token == null ? "" : token);
        }

        /** The page got a notification: show it natively, on screen or in the background. */
        @JavascriptInterface
        public void notify(String title, String body, String kind, long chatId) {
            WidgetSync.notifyNative(MainActivity.this, title, body, kind, chatId, true);
        }

        /** Play chat / notification tones on the notification stream, not the media stream. */
        @JavascriptInterface
        public void playSound(String kind) {
            runOnUiThread(() -> playNativeSound(kind == null ? "chime" : kind));
        }

        /** A turn ended (or the page learned of a new reply): redraw the widget now. */
        @JavascriptInterface
        public void refreshWidget() {
            WidgetSync.refreshAsync(MainActivity.this);
        }

        /** The page asks on send, so a denied permission can be granted later. */
        @JavascriptInterface
        public void requestNotifications() {
            runOnUiThread(() -> askNotifications());
        }
    }
}
