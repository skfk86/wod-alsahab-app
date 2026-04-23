package com.wodalsahab.sudanweather;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "WodAlSahab";
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 1001;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // إنشاء قنوات الإشعارات
        NotificationChannelHelper.createChannels(this);

        // طلب إذن الإشعارات (Android 13+)
        requestNotificationPermission();
    }

    private void requestNotificationPermission() {
        // فقط لأندرويد 13 وما فوق (API 33+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            
            // تحقق إذا كان الإذن مُمنحاً بالفعل
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED) {
                Log.d(TAG, "إذن الإشعارات مُمنح بالفعل ✓");
                return;
            }
            
            // تحقق إذا كان يجب عرض شرح للمستخدم
            if (ActivityCompat.shouldShowRequestPermissionRationale(this, Manifest.permission.POST_NOTIFICATIONS)) {
                // يمكنك عرض AlertDialog هنا لشرح سبب الحاجة للإذن
                Log.d(TAG, "يجب شرح سبب الحاجة لإذن الإشعارات للمستخدم");
            }
            
            // طلب الإذن
            ActivityCompat.requestPermissions(
                this,
                new String[]{Manifest.permission.POST_NOTIFICATIONS},
                NOTIFICATION_PERMISSION_REQUEST_CODE
            );
        } else {
            // لأندرويد 12 وما دون، الإذن يُمنح تلقائياً عند التثبيت
            Log.d(TAG, "إصدار أندرويد أقل من 13، لا يحتاج طلب إذن الإشعارات");
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST_CODE) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                Log.d(TAG, "✓ تم منح إذن الإشعارات بنجاح");
            } else {
                Log.w(TAG, "✗ تم رفض إذن الإشعارات");
                // يمكنك إعلام المستخدم أن الإشعارات لن تعمل
            }
        }
    }
}
