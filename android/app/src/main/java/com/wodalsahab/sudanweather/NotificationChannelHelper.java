package com.wodalsahab.sudanweather;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

public class NotificationChannelHelper {

    public static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager nm = (NotificationManager)
                context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        // قناة التنبيهات الحرجة
        NotificationChannel channel = new NotificationChannel(
                "weather_alerts",
                "تنبيهات الطقس الخطيرة",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("تنبيهات العواصف والأمطار");
        channel.enableLights(true);
        channel.setLightColor(Color.parseColor("#f59e0b"));
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 500, 300, 500});
        channel.setShowBadge(true);
        channel.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
        channel.setBypassDnd(true);

        Uri defaultSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                .build();
        channel.setSound(defaultSound, audioAttributes);

        nm.createNotificationChannel(channel);
    }
}
