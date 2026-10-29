package app.mimi.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Keeps the widget's list: asks the server (GET /api/widget) for the newest chats with the
 * token the app signed in with, keeps the answer and round avatars on the device, and posts a
 * notification when a chat got new replies while the app was not open.
 */
final class WidgetSync {
    static final String PREFS = "widget";
    private static final String CHANNEL = "replies";

    private WidgetSync() {}

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void setToken(Context context, String token) {
        String old = prefs(context).getString("token", "");
        if (old.equals(token)) return;
        prefs(context).edit().putString("token", token).remove("chats").remove("notifId").apply();
        refreshAsync(context);
    }

    /** The app is on screen: what is there now counts as read. */
    static void markSeen(Context context) {
        prefs(context).edit().putString("seen", iso(new Date())).apply();
        refreshAsync(context);
    }

    static void refreshAsync(Context context) {
        Context app = context.getApplicationContext();
        new Thread(() -> refresh(app), "mimi-widget").start();
    }

    /** Fetches the list and redraws every widget; quiet on failure (the old list stays). */
    static synchronized void refresh(Context context) {
        SharedPreferences prefs = prefs(context);
        String token = prefs.getString("token", "");
        if (!token.isEmpty()) {
            try {
                String since = prefs.getString("seen", "");
                String query = since.isEmpty() ? "" : "?since=" + java.net.URLEncoder.encode(since, "UTF-8");
                byte[] body = get("/api/widget" + query, token);
                JSONObject answer = new JSONObject(new String(body, "UTF-8"));
                JSONArray chats = answer.optJSONArray("chats");
                if (chats == null) chats = new JSONArray();
                for (int i = 0; i < chats.length(); i++) cacheAvatar(context, chats.getJSONObject(i), token);
                notifyNew(context, chats);
                prefs.edit().putString("chats", chats.toString()).putLong("fetched", System.currentTimeMillis()).apply();
            } catch (Exception ignored) {
                // offline or signed out on the server: keep showing the last list
            }
        }
        redraw(context);
    }

    static void redraw(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, ChatWidget.class));
        if (ids.length == 0) return;
        ChatWidget.draw(context, manager, ids);
        manager.notifyAppWidgetViewDataChanged(ids, R.id.widgetList);
    }

    private static byte[] get(String path, String token) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("https://" + BuildConfig.MIMI_HOST + path).openConnection();
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("authorization", "Bearer " + token);
        try {
            if (connection.getResponseCode() != 200) throw new Exception("HTTP " + connection.getResponseCode());
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                for (int read; (read = in.read(buffer)) > 0; ) out.write(buffer, 0, read);
                return out.toByteArray();
            }
        } finally {
            connection.disconnect();
        }
    }

    static File avatarFile(Context context, String agent) {
        File dir = new File(context.getCacheDir(), "avatars");
        dir.mkdirs();
        return new File(dir, Integer.toHexString(agent.hashCode()) + ".png");
    }

    /** Downloads an agent's picture once per version, cut to a circle. */
    private static void cacheAvatar(Context context, JSONObject chat, String token) {
        String agent = chat.optString("agent", "");
        String path = chat.optString("avatar", "");
        if (agent.isEmpty() || path.isEmpty() || "null".equals(path)) return;
        SharedPreferences prefs = prefs(context);
        File file = avatarFile(context, agent);
        if (path.equals(prefs.getString("avatar:" + agent, "")) && file.exists()) return;
        try {
            byte[] bytes = get(path, token);
            Bitmap source = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (source == null) return;
            try (FileOutputStream out = new FileOutputStream(file)) {
                circle(source, 128).compress(Bitmap.CompressFormat.PNG, 100, out);
            }
            prefs.edit().putString("avatar:" + agent, path).apply();
        } catch (Exception ignored) {
            // the letter placeholder stays
        }
    }

    static Bitmap circle(Bitmap source, int size) {
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        int side = Math.min(source.getWidth(), source.getHeight());
        // A portrait-shaped picture keeps its top (the face).
        int left = (source.getWidth() - side) / 2;
        int top = source.getHeight() > source.getWidth() ? 0 : (source.getHeight() - side) / 2;
        canvas.drawBitmap(source, new Rect(left, top, left + side, top + side), new Rect(0, 0, size, size), paint);
        return out;
    }

    /** One notification per chat whose unread count went up since the last look. */
    private static void notifyNew(Context context, JSONArray chats) {
        SharedPreferences prefs = prefs(context);
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL, context.getString(R.string.channelReplies), NotificationManager.IMPORTANCE_DEFAULT));
        }
        SharedPreferences.Editor edit = prefs.edit();
        for (int i = 0; i < chats.length(); i++) {
            JSONObject chat = chats.optJSONObject(i);
            if (chat == null) continue;
            long id = chat.optLong("id");
            int unread = chat.optInt("unread");
            int known = prefs.getInt("unread:" + id, 0);
            edit.putInt("unread:" + id, unread);
            if (unread > known && !MainActivity.visible) {
                Intent open = new Intent(context, MainActivity.class).putExtra("chat", id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                PendingIntent tap = PendingIntent.getActivity(context, (int) id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                String title = chat.optString("title");
                if (title.trim().isEmpty()) title = context.getString(R.string.appName);
                String preview = chat.optString("preview").trim();
                if (preview.isEmpty()) preview = context.getString(R.string.newMessage);
                Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(context, CHANNEL) : new Notification.Builder(context);
                builder
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentTitle(title)
                    .setContentText(preview)
                    .setStyle(new Notification.BigTextStyle().bigText(preview))
                    .setNumber(unread)
                    .setWhen(System.currentTimeMillis())
                    .setShowWhen(true)
                    .setCategory(Notification.CATEGORY_MESSAGE)
                    .setPriority(Notification.PRIORITY_DEFAULT)
                    .setAutoCancel(true)
                    .setContentIntent(tap);
                File avatar = avatarFile(context, chat.optString("agent", ""));
                if (avatar.exists()) builder.setLargeIcon(BitmapFactory.decodeFile(avatar.getPath()));
                try {
                    manager.notify((int) id, builder.build());
                } catch (SecurityException ignored) {
                    // notifications not allowed
                }
            } else if (unread == 0) {
                manager.cancel((int) id);
            }
        }
        edit.apply();
    }

    static String iso(Date date) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(date);
    }

    // ---------- the notification inbox (while the app page is closed) ----------

    private static final String NOTIF_CHANNEL = "notifications";

    private static NotificationManager notifManager(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return null;
        if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(NOTIF_CHANNEL) == null) {
            manager.createNotificationChannel(new NotificationChannel(NOTIF_CHANNEL, context.getString(R.string.channelReplies), NotificationManager.IMPORTANCE_DEFAULT));
        }
        return manager;
    }

    /** Posts one native notification; `kind` gets the same emoji the web app uses. */
    static void notifyNative(Context context, String title, String body, String kind, long chatId) {
        if (MainActivity.visible) return; // the page itself shows it
        NotificationManager manager = notifManager(context);
        if (manager == null) return;
        String icon = "message".equals(kind) ? "💬 " : "reminder".equals(kind) ? "⏰ " : "approval".equals(kind) ? "✋ " : "";
        int id = (int) (System.currentTimeMillis() & 0x7fffffff);
        Intent open = new Intent(context, MainActivity.class);
        if (chatId > 0) open.putExtra("chat", chatId);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent tap = PendingIntent.getActivity(context, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String safeTitle = title == null || title.trim().isEmpty() ? context.getString(R.string.appName) : title;
        String safeBody = body == null ? "" : body.trim();
        if (safeBody.isEmpty()) safeBody = context.getString(R.string.newMessage);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(context, NOTIF_CHANNEL) : new Notification.Builder(context);
        builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(icon + safeTitle)
            .setContentText(safeBody)
            .setStyle(new Notification.BigTextStyle().bigText(safeBody))
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .setCategory("message".equals(kind) ? Notification.CATEGORY_MESSAGE : Notification.CATEGORY_REMINDER)
            .setPriority(Notification.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(tap);
        try {
            manager.notify(id, builder.build());
        } catch (SecurityException ignored) {
            // notifications not allowed
        }
    }

    /**
     * Asks the server for unread notifications and posts each new one natively — the path
     * for reminders and approvals while the app is closed. Polled by the same job as the
     * widget (about every 15 minutes, the shortest Android allows).
     */
    static synchronized void syncNotifications(Context context) {
        SharedPreferences prefs = prefs(context);
        String token = prefs.getString("token", "");
        if (token.isEmpty()) return;
        try {
            byte[] body = get("/api/notifications", token);
            JSONArray items = new JSONArray(new String(body, "UTF-8"));
            long known = prefs.getLong("notifId", 0);
            long newest = known;
            for (int i = 0; i < items.length(); i++) {
                JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                long id = item.optLong("id");
                newest = Math.max(newest, id);
                if (id <= known) continue;
                notifyNative(context, item.optString("title"), item.optString("body"), item.optString("kind"), item.optLong("chatId"));
            }
            if (newest != known) prefs.edit().putLong("notifId", newest).apply();
        } catch (Exception ignored) {
            // offline or signed out: try again next round
        }
    }

    static Date parse(String iso) {
        try {
            SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
            format.setTimeZone(TimeZone.getTimeZone("UTC"));
            return format.parse(iso);
        } catch (Exception error) {
            return null;
        }
    }
}
