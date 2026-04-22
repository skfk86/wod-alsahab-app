package com.wodalsahab.sudanweather;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * WeatherForegroundService — طقس السودان v2.0
 * ════════════════════════════════════════════════
 * خدمة Foreground تعرض درجة الحرارة الحالية في شريط التنبيهات.
 * المسار: android/app/src/main/java/com/wodalsahab/sudanweather/
 *
 * إصلاحات جذور الأخطاء:
 *   [FIX-8] startForeground() أُضيف إليها foregroundServiceType
 *           مطلوب صراحةً في Android 14+ (API 34) — targetSdkVersion=34
 *           بدونه: ForegroundServiceStartNotAllowedException عند التشغيل
 *
 *   [FIX-9] stopForeground(true) → ServiceCompat.stopForeground()
 *           stopForeground(boolean) deprecated منذ API 33.
 *           ServiceCompat يُوفّر API موحَّداً لكل إصدارات Android.
 */
public class WeatherForegroundService extends Service {

    private static final String TAG           = "WodWeatherService";
    private static final int    NOTIF_ID      = 9001;
    private static final String CH_PERSISTENT = "weather_persistent";

    public static final String ACTION_START  = "com.wodalsahab.sudanweather.START_WEATHER";
    public static final String ACTION_UPDATE = "com.wodalsahab.sudanweather.UPDATE_WEATHER";
    public static final String ACTION_STOP   = "com.wodalsahab.sudanweather.STOP_WEATHER";

    public static final String EXTRA_TEMP = "temp";
    public static final String EXTRA_DESC = "desc";
    public static final String EXTRA_CITY = "city";

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
            startForegroundCompat(lastTemp, lastDesc, lastCity);
            return START_STICKY;
        }

        String action = intent.getAction();
        if (action == null) action = ACTION_START;

        switch (action) {

            case ACTION_STOP:
                Log.d(TAG, "WeatherForegroundService: STOP");
                // [FIX-9] ServiceCompat.stopForeground بدلاً من stopForeground(true)
                //         stopForeground(boolean) deprecated منذ API 33
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
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

                startForegroundCompat(lastTemp, lastDesc, lastCity);
                break;
        }

        return START_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.d(TAG, "WeatherForegroundService: onDestroy");
    }

    /* ══════════════════════════════════════════════════════
       بناء الإشعار الدائم
    ══════════════════════════════════════════════════════ */

    /**
     * [FIX-8] startForegroundCompat — يمرّر foregroundServiceType لـ API 34+
     *
     * Android 14 (API 34) مع targetSdkVersion=34 يُلزم تمرير
     * FOREGROUND_SERVICE_TYPE_LOCATION عند استدعاء startForeground().
     * بدونه يُطلق النظام ForegroundServiceStartNotAllowedException.
     *
     * ServiceCompat.startForeground() يُوحّد هذا السلوك لكل الإصدارات.
     */
    private void startForegroundCompat(String temp, String desc, String city) {
        try {
            Notification notif = buildNotification(temp, desc, city);

            ServiceCompat.startForeground(
                    this,
                    NOTIF_ID,
                    notif,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            );

            Log.d(TAG, "Sticky notif updated: " + temp + " / " + city);
        } catch (Exception e) {
            Log.w(TAG, "startForeground failed: " + e.getMessage());
        }
    }

    private Notification buildNotification(String temp, String desc, String city) {
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

        return new NotificationCompat.Builder(this, CH_PERSISTENT)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(getSmallIconRes())
                .setColor(0xFFF59E0B)
                .setContentIntent(tapPending)
                .setOngoing(true)
                .setAutoCancel(false)
                .setSilent(true)
                .setShowWhen(false)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    /**
     * يُحاول ic_weather_notif أولاً، ويتراجع إلى الأيقونة الافتراضية.
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

    public static void stop(android.content.Context ctx) {
        Intent intent = new Intent(ctx, WeatherForegroundService.class);
        intent.setAction(ACTION_STOP);
        ctx.startService(intent);
    }
}
