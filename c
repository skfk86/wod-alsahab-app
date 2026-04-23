package com.wodalsahab.sudanweather;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

/**
 * NotificationChannelHelper — ود السحاب v2.0
 * ينشئ قنوات الإشعارات المطلوبة عند أول تشغيل للتطبيق.
 *
 * القنوات:
 *   1. weather_alerts      — تنبيهات الطقس الحرجة (أولوية قصوى + صوت)
 *   2. weather_daily       — تنبيهات الطقس اليومية (صوت)
 */
public class NotificationChannelHelper {

    public static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager nm = (NotificationManager)
                context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        // ── 1. قناة التنبيهات الحرجة (هبوب، عاصفة ترابية) ──────────
        {
            NotificationChannel channel = new NotificationChannel(
                    "weather_alerts",
                    "تنبيهات الطقس الخطيرة",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("هبوب وعواصف ترابية وتنبيهات جوية حرجة");
            channel.enableLights(true);
            channel.setLightColor(Color.parseColor("#f59e0b"));
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[]{0, 500, 300, 500, 300, 800});
            channel.setShowBadge(true);
            channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
            
            // ✅ تجاوز وضع عدم الإزعاج (Do Not Disturb)
            channel.setBypassDnd(true);

            // ✅ استخدام صوت الهاتف الافتراضي
            Uri defaultSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                    .build();
            channel.setSound(defaultSound, audioAttributes);

            nm.createNotificationChannel(channel);
        }

        // ── 2. قناة التنبيهات اليومية ────────────────────────────────
        {
            NotificationChannel channel = new NotificationChannel(
                    "weather_daily",
                    "تنبيهات الطقس اليومية",
                    NotificationManager.IMPORTANCE_DEFAULT
            );
            channel.setDescription("ملخص الطقس اليومي وتحذيرات الغبار والحرارة");
            channel.enableLights(true);
            channel.setLightColor(Color.parseColor("#3b82f6"));
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[]{0, 300, 150, 300});
            channel.setShowBadge(true);
            channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);

            // ✅ استخدام صوت الهاتف الافتراضي
            Uri defaultSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .build();
            channel.setSound(defaultSound, audioAttributes);

            nm.createNotificationChannel(channel);
        }
    }
}



