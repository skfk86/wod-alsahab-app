package com.wodalsahab.sudanweather;

import android.os.Bundle;
import android.util.Log;

import com.getcapacitor.BridgeActivity;

/**
 * MainActivity — ود السحاب v2.0
 * يمتد من BridgeActivity الذي يحمّل Capacitor تلقائياً.
 * المهام الإضافية هنا:
 *   1. إعداد قناة الإشعارات عبر Android API (Notification Channel)
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "WodAlSahab";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // ── 1. قنوات الإشعارات (Android 8+, API 26+) ──────────────────
        NotificationChannelHelper.createChannels(this);

        Log.d(TAG, "تم تهيئة قنوات الإشعارات بنجاح ✓");
    }
}
