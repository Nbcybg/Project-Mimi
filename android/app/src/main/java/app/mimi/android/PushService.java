package app.mimi.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps replies arriving while the app is folded away. Android freezes a WebView in the
 * background and the periodic job runs about every 15 minutes at best, so this foreground
 * service asks the server for new notifications every half minute (natively, no page needed)
 * and posts each with its text. It also keeps the widget's list fresh. A quiet notification
 * in the status bar is the price Android asks for running in the background.
 */
public class PushService extends Service {
    private static final String CHANNEL = "connection";
    private static final int NOTIFICATION = 7002;
    private static final long EVERY_MS = 30_000;

    /** True while the loop runs: the chat-unread notifications of the 15-minute job stand down. */
    static volatile boolean live;

    private Thread loop;

    static void start(Context context) {
        if (WidgetSync.prefs(context).getString("token", "").isEmpty()) return;
        try {
            Intent intent = new Intent(context, PushService.class);
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent);
            else context.startService(intent);
        } catch (Exception ignored) {
            // not allowed right now (background start limits): the next open of the app tries again
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, PushService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        showOngoing();
        if (loop == null || !loop.isAlive()) {
            live = true;
            Context app = getApplicationContext();
            loop = new Thread(() -> {
                int round = 0;
                while (!Thread.currentThread().isInterrupted()) {
                    if (WidgetSync.prefs(app).getString("token", "").isEmpty()) break; // signed out
                    WidgetSync.syncNotifications(app);
                    if (round++ % 4 == 0) WidgetSync.refresh(app); // the widget about every two minutes
                    try {
                        Thread.sleep(EVERY_MS);
                    } catch (InterruptedException stopped) {
                        return;
                    }
                }
                live = false;
                stopSelf();
            }, "mimi-push");
            loop.start();
        }
        return START_STICKY;
    }

    private void showOngoing() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && manager != null && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, getString(R.string.channelConnection), NotificationManager.IMPORTANCE_MIN);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        PendingIntent tap = PendingIntent.getActivity(this, 3, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(getString(R.string.appName))
            .setContentText(getString(R.string.connectionText))
            .setOngoing(true)
            .setContentIntent(tap);
        if (Build.VERSION.SDK_INT < 26) builder.setPriority(Notification.PRIORITY_MIN);
        Notification notification = builder.build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTIFICATION, notification);
    }

    @Override
    public void onDestroy() {
        live = false;
        if (loop != null) loop.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
