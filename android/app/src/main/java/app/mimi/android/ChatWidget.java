package app.mimi.android;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.widget.RemoteViews;

/**
 * Home-screen widget: the newest chats as rows (picture, name, time, last message, a badge
 * with the replies not seen yet). A row opens its chat; the list follows WidgetSync.
 */
public class ChatWidget extends AppWidgetProvider {
    static final String REFRESH = "app.mimi.android.WIDGET_REFRESH";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        draw(context, manager, ids);
        PendingResult result = goAsync();
        Context app = context.getApplicationContext();
        new Thread(() -> {
            try {
                WidgetSync.refresh(app);
            } finally {
                result.finish();
            }
        }, "mimi-widget").start();
    }

    @Override
    public void onEnabled(Context context) {
        SyncJob.schedule(context);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (REFRESH.equals(intent.getAction())) WidgetSync.refreshAsync(context);
    }

    static void draw(Context context, AppWidgetManager manager, int[] ids) {
        boolean signedIn = !WidgetSync.prefs(context).getString("token", "").isEmpty();
        int mutable = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        for (int id : ids) {
            RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_chats);
            Intent service = new Intent(context, ChatWidgetService.class)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
            service.setData(Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME)));
            views.setRemoteAdapter(R.id.widgetList, service);
            views.setEmptyView(R.id.widgetList, R.id.widgetEmpty);
            views.setTextViewText(R.id.widgetEmpty, context.getString(signedIn ? R.string.widgetEmpty : R.string.widgetSignIn));

            // A row fills in its chat id; the template opens the app.
            Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            views.setPendingIntentTemplate(R.id.widgetList,
                PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | mutable));
            views.setOnClickPendingIntent(R.id.widgetEmpty,
                PendingIntent.getActivity(context, 1, new Intent(context, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            manager.updateAppWidget(id, views);
        }
    }
}
