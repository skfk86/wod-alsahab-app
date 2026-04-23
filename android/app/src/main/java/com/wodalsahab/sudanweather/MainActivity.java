package com.wodalsahab.sudanweather;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

import androidx.annotation.NonNull;

import com.getcapacitor.BridgeActivity;

/**
 * MainActivity — طقس السودان v3.0
 *
 * المهام:
 *   1. إنشاء قنوات الإشعارات (Android 8+)
 *   2. طلب الإعفاء من Battery Optimization (مرة واحدة)
 *   3. طلب إذن الموقع في الخلفية (Android 10+)
 *      ملاحظة مهمة لـ Google Play:
 *      يجب تقديم تبرير واضح لهذا الإذن في نموذج الإفصاح
 *      (Policy Declaration Form) قبل النشر.
 */
public class MainActivity extends BridgeActivity {

    private static final String TAG = "WodAlSahab";

    // كود طلب إذن موقع الخلفية
    private static final int REQ_BG_LOCATION = 1001;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 1. قنوات الإشعارات (Android 8+)
        NotificationChannelHelper.createChannels(this);

        // 2. الإعفاء من Battery Optimization
        requestBatteryOptimizationExempt();

        // 3. إذن الموقع في الخلفية (Android 10+ / API 29+)
        requestBackgroundLocationIfNeeded();
    }

    /**
     * يطلب إذن ACCESS_BACKGROUND_LOCATION على Android 10+.
     *
     * القواعد:
     * - يجب أن يكون ACCESS_FINE_LOCATION أو ACCESS_COARSE_LOCATION
     *   قد مُنح بالفعل قبل طلب إذن الخلفية (Android يرفض الطلب المباشر).
     * - Google Play تتطلب شاشة شرح مسبقة توضح لماذا يحتاج التطبيق
     *   للموقع في الخلفية (لتحديث الطقس التلقائي).
     * - هذا الإذن يُمنح بمفرده عبر شاشة إعدادات النظام.
     *
     * ⚠️ تحذير Google Play:
     *   قبل النشر، أكمل نموذج "Prominent Disclosure" في Play Console
     *   تحت: Policy → App content → Location permissions
     *   واذكر: "يحتاج التطبيق لموقعك في الخلفية لتحديث بيانات الطقس
     *           تلقائياً كل 3 ساعات حتى عند إغلاق التطبيق."
     */
    private void requestBackgroundLocationIfNeeded() {
        // هذا الإذن موجود فقط في Android 10+ (API 29+)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;

        // تحقق إذا كان ممنوحاً مسبقاً
        if (checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED) {
            Log.d(TAG, "الموقع الخلفي: ممنوح مسبقاً ✓");
            return;
        }

        // يجب أن يكون إذن الموقع الأساسي ممنوحاً أولاً
        boolean hasFine   = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                            == PackageManager.PERMISSION_GRANTED;
        boolean hasCoarse = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                            == PackageManager.PERMISSION_GRANTED;

        if (!hasFine && !hasCoarse) {
            // طلب إذن الموقع الأساسي أولاً — سيُعاد طلب الخلفية في onRequestPermissionsResult
            Log.d(TAG, "الموقع: طلب الإذن الأساسي أولاً");
            requestPermissions(
                new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                },
                REQ_BG_LOCATION
            );
            return;
        }

        // الإذن الأساسي موجود — طلب الخلفية مباشرة
        Log.d(TAG, "الموقع: طلب إذن الخلفية (Android 10+)");
        requestPermissions(
            new String[]{ Manifest.permission.ACCESS_BACKGROUND_LOCATION },
            REQ_BG_LOCATION
        );
    }

    /**
     * استجابة طلب الإذن:
     * إذا مُنح الإذن الأساسي → طلب إذن الخلفية تلقائياً
     */
    @Override
    public void onRequestPermissionsResult(int requestCode,
                                           @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode != REQ_BG_LOCATION) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;

        // إذا مُنح الإذن الأساسي الآن → طلب الخلفية
        boolean justGranted = grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED;

        if (justGranted) {
            boolean bgAlreadyGranted =
                checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED;

            if (!bgAlreadyGranted) {
                requestPermissions(
                    new String[]{ Manifest.permission.ACCESS_BACKGROUND_LOCATION },
                    REQ_BG_LOCATION
                );
            }
        } else {
            Log.w(TAG, "الموقع: رُفض الإذن من المستخدم — التحديث التلقائي بالموقع معطّل");
        }
    }

    /**
     * يطلب الإعفاء من Battery Optimization (مرة واحدة عند أول تشغيل).
     */
    private void requestBatteryOptimizationExempt() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;

        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null) return;

            if (pm.isIgnoringBatteryOptimizations(getPackageName())) {
                Log.d(TAG, "البطارية: معفى مسبقاً ✓");
                return;
            }

            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
            Log.d(TAG, "البطارية: تم طلب الإعفاء");

        } catch (Exception e) {
            // بعض الأجهزة لا تدعم هذا الإعداد
            Log.w(TAG, "البطارية: تعذّر الطلب — " + e.getMessage());
        }
    }
}
