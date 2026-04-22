package com.wodalsahab.sudanweather;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

/**
 * WeatherForegroundService — طقس السودان v2.0
 * ════════════════════════════════════════════════
 * خدمة Foreground تعرض درجة الحرارة الحالية
 * في شريط التنبيهات باستمرار حتى مع إغلاق التطبيق.
 *
 * المسار: android/app/src/main/java/com/wodalsahab/sudanweather/
 *
 * يُستدعى من capacitor-bridge.js عبر:
 *   updateStickyNotif(temp, desc, city)
 *
 * القناة المستخدمة: weather_persistent (IMPORTANCE_LOW — بدون صوت)
 */
public class WeatherForegroundService extends Service {

    private static final String TAG            = "WodWeatherService";
    private static final int    NOTIF_ID       = 9001;
    private static final String CH_PERSISTENT  = "weather_persistent";

    /* ── الإجراءات المدعومة ── */
    public static final String ACTION_START  = "com.wodalsahab.sudanweather.START_WEATHER";
    public static final String ACTION_UPDATE = "com.wodalsahab.sudanweather.UPDATE_WEATHER";
    public static final String ACTION_STOP   = "com.wodalsahab.sudanweather.STOP_WEATHER";

    /* ── مفاتيح Intent Extras ── */
    public static final String EXTRA_TEMP = "temp";
    public static final String EXTRA_DESC = "desc";
    public static final String EXTRA_CITY = "city";

    // حالة الطقس الأخيرة — تُحفظ لإعادة عرضها بعد إعادة تشغيل الجهاز
    private String lastTemp = "---";
    private String lastDesc = "جاري التحديث...";
    private String lastCity = "السودان";

    /* ══════════════════════════════════════════════════════
       دورة حياة الخدمة
    ══════════════════════════════════════════════════════ */

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "WeatherForegroundService: onCreate");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // أُعيد التشغيل تلقائياً بعد القتل — ابدأ بآخر بيانات
            startForegroundWithNotif(lastTemp, lastDesc, lastCity);
            return START_STICKY;
        }

        String action = intent.getAction();
        if (action == null) action = ACTION_START;

        switch (action) {

            case ACTION_STOP:
                Log.d(TAG, "WeatherForegroundService: STOP");
                stopForeground(true);
                stopSelf();
                break;

            case ACTION_UPDATE:
            case ACTION_START:
            default:
                String temp = intent.getStringExtra(EXTRA_TEMP);
                String desc = intent.getStringExtra(EXTRA_DESC);
                String city = intent.getStringExtra(EXTRA_CITY);

                if (temp != null) lastTemp = temp;
                if (desc != null) lastDesc = desc;
                if (city != null) lastCity = city;

                startForegroundWithNotif(lastTemp, lastDesc, lastCity);
                break;
        }

        // START_STICKY: أعد التشغيل تلقائياً عند إنهاء الخدمة بالقوة
        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null; // لا نحتاج Bound Service
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.d(TAG, "WeatherForegroundService: onDestroy");
    }

    /* ══════════════════════════════════════════════════════
       بناء الإشعار الدائم
    ══════════════════════════════════════════════════════ */

    private void startForegroundWithNotif(String temp, String desc, String city) {
        try {
            Notification notif = buildNotification(temp, desc, city);
            startForeground(NOTIF_ID, notif);
            Log.d(TAG, "Sticky notif updated: " + temp + " / " + city);
        } catch (Exception e) {
            Log.w(TAG, "startForeground failed: " + e.getMessage());
        }
    }

    private Notification buildNotification(String temp, String desc, String city) {
        // Intent لفتح التطبيق عند الضغط على الإشعار
        Intent tapIntent = new Intent(this, MainActivity.class);
        tapIntent.setAction(Intent.ACTION_MAIN);
        tapIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        tapIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        int pendingFlags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;

        PendingIntent tapPending = PendingIntent.getActivity(
                this, 0, tapIntent, pendingFlags
        );

        String title = "☁ طقس السودان — " + city;
        String body  = temp + "°م  ·  " + desc;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CH_PERSISTENT)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(getSmallIconRes())
                .setColor(0xFFF59E0B)           // لون الأيقونة: برتقالي (--accent)
                .setContentIntent(tapPending)
                .setOngoing(true)               // ← دائم لا يُغلق بالسحب
                .setAutoCancel(false)
                .setSilent(true)                // ← بدون صوت أو اهتزاز
                .setShowWhen(false)             // لا تُظهر الوقت (يتغير باستمرار)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW);

        return builder.build();
    }

    /**
     * إرجاع معرّف أيقونة الإشعار.
     * يحاول ic_weather_notif أولاً، ويتراجع إلى الأيقونة الافتراضية.
     */
    private int getSmallIconRes() {
        try {
            int id = getResources().getIdentifier(
                    "ic_weather_notif", "drawable", getPackageName()
            );
            return id != 0 ? id : android.R.drawable.ic_dialog_info;
        } catch (Exception e) {
            return android.R.drawable.ic_dialog_info;
        }
    }

    /* ══════════════════════════════════════════════════════
       API ثابتة — للاستدعاء من خارج الخدمة
    ══════════════════════════════════════════════════════ */

    /**
     * تشغيل/تحديث الإشعار الدائم.
     * مثال: WeatherForegroundService.update(context, "38", "غائم جزئياً", "الخرطوم");
     */
    public static void update(android.content.Context ctx,
                               String temp, String desc, String city) {
        Intent intent = new Intent(ctx, WeatherForegroundService.class);
        intent.setAction(ACTION_UPDATE);
        intent.putExtra(EXTRA_TEMP, temp);
        intent.putExtra(EXTRA_DESC, desc);
        intent.putExtra(EXTRA_CITY, city);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent);
        } else {
            ctx.startService(intent);
        }
    }

    /**
     * إيقاف الإشعار الدائم.
     */
    public static void stop(android.content.Context ctx) {
        Intent intent = new Intent(ctx, WeatherForegroundService.class);
        intent.setAction(ACTION_STOP);
        ctx.startService(intent);
    }
}
