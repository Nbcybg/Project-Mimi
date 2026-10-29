package app.mimi.android;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.text.format.DateFormat;
import android.view.View;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;

/** The rows of ChatWidget, drawn from the list WidgetSync keeps. */
public class ChatWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Rows(getApplicationContext());
    }

    private static final class Rows implements RemoteViewsFactory {
        private static final int[] COLORS = {0xFFE08A5B, 0xFF5B9BE0, 0xFF63B37A, 0xFFB57AD6, 0xFFD6A13C, 0xFFD0647A};
        private final Context context;
        private final List<JSONObject> chats = new ArrayList<>();

        Rows(Context context) {
            this.context = context;
        }

        @Override
        public void onCreate() {}

        @Override
        public void onDataSetChanged() {
            chats.clear();
            try {
                JSONArray list = new JSONArray(WidgetSync.prefs(context).getString("chats", "[]"));
                for (int i = 0; i < list.length(); i++) chats.add(list.getJSONObject(i));
            } catch (Exception ignored) {
                // nothing kept yet
            }
        }

        @Override
        public void onDestroy() {
            chats.clear();
        }

        @Override
        public int getCount() {
            return chats.size();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            RemoteViews row = new RemoteViews(context.getPackageName(), R.layout.widget_row);
            if (position >= chats.size()) return row;
            JSONObject chat = chats.get(position);
            String title = chat.optString("title", "Mimi");
            row.setTextViewText(R.id.rowTitle, title);
            String preview = chat.optString("preview", "").replaceAll("[*`#]", "");
            row.setTextViewText(R.id.rowPreview, preview);
            row.setTextViewText(R.id.rowTime, when(chat.optString("lastMessageAt", "")));
            int unread = chat.optInt("unread", 0);
            row.setViewVisibility(R.id.rowBadge, unread > 0 ? View.VISIBLE : View.GONE);
            row.setTextViewText(R.id.rowBadge, unread > 99 ? "99+" : String.valueOf(unread));

            File avatar = WidgetSync.avatarFile(context, chat.optString("agent", ""));
            Bitmap picture = avatar.exists() ? BitmapFactory.decodeFile(avatar.getPath()) : null;
            row.setImageViewBitmap(R.id.rowAvatar, picture != null ? picture : letter(title));

            row.setOnClickFillInIntent(R.id.rowRoot, new Intent().putExtra("chat", chat.optLong("id")));
            return row;
        }

        /** Today: 17:12. This week: the day's name. Older: the date. */
        private String when(String iso) {
            Date date = WidgetSync.parse(iso);
            if (date == null) return "";
            Calendar now = Calendar.getInstance();
            Calendar then = Calendar.getInstance();
            then.setTime(date);
            boolean today = now.get(Calendar.YEAR) == then.get(Calendar.YEAR) && now.get(Calendar.DAY_OF_YEAR) == then.get(Calendar.DAY_OF_YEAR);
            if (today) return DateFormat.getTimeFormat(context).format(date);
            if (now.getTimeInMillis() - date.getTime() < 6L * 24 * 3600 * 1000) return DateFormat.format("EEE", date).toString();
            return DateFormat.getDateFormat(context).format(date);
        }

        /** A coloured circle with the first letter, for an agent without a picture. */
        private Bitmap letter(String title) {
            int size = 128;
            Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(out);
            Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
            paint.setColor(COLORS[Math.abs(title.hashCode()) % COLORS.length]);
            canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint);
            paint.setColor(Color.WHITE);
            paint.setTextSize(size * 0.46f);
            paint.setTextAlign(Paint.Align.CENTER);
            String first = title.isEmpty() ? "M" : title.substring(0, title.offsetByCodePoints(0, 1)).toUpperCase();
            canvas.drawText(first, size / 2f, size / 2f - (paint.descent() + paint.ascent()) / 2, paint);
            return out;
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 1;
        }

        @Override
        public long getItemId(int position) {
            return position < chats.size() ? chats.get(position).optLong("id", position) : position;
        }

        @Override
        public boolean hasStableIds() {
            return true;
        }
    }
}
