package com.wodalsahab.sudanweather;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.BridgeActivity;

/**
 * MainActivity — ود السحاب v2.0
 * يمتد من BridgeActivity الذي يحمّل Capacitor تلقائياً.
 * المهام الإضافية هنا:
 *   1. طلب الإعفاء من تحسين البطارية (مرة واحدة عند أول تشغيل)
 *   2. إعداد قناة الإشعارات عبر Android API (Notification Channel)
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "WodAlSahab";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // ── 1. قنوات الإشعارات (Android 8+, API 26+) ──────────────────
        NotificationChannelHelper.createChannels(this);

        // ── 2. طلب الإعفاء من تحسين البطارية ──────────────────────────
        requestBatteryOptimizationExempt();
    }

    /**
     * يطلب من المستخدم السماح للتطبيق بالعمل بحرية في الخلفية
     * بدون قيود Battery Optimization.
     * يُطلب مرة واحدة فقط (إذا لم يُعفَ مسبقاً).
     */
    private void requestBatteryOptimizationExempt() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;

        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return;

            // تحقق إذا كان التطبيق معفواً مسبقاً
            if (pm.isIgnoringBatteryOptimizations(getPackageName())) {
                Log.d(TAG, "البطارية: التطبيق معفى مسبقاً ✓");
                return;
            }

            // أظهر حوار طلب الإعفاء
            Intent intent = new Intent();
            intent.setAction(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);

            Log.d(TAG, "البطارية: تم طلب الإعفاء من تحسين البطارية");

        } catch (Exception e) {
            // بعض الأجهزة لا تدعم هذا الإعداد — تجاهل الخطأ بأمان
            Log.w(TAG, "البطارية: تعذّر طلب الإعفاء — " + e.getMessage());
        }
    }
}
