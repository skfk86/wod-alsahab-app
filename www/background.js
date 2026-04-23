/**
 * background.js — طقس السودان v3.0
 * BackgroundRunner Script (@capacitor/background-runner)
 *
 * ⚠️ يعمل في JavaScriptCore — لا DOM ولا window.
 * المسار: www/background.js
 *
 * المعمارية الجديدة (v3):
 *   لا يوجد fetch هنا إطلاقاً.
 *   المهمة الوحيدة: إيقاظ التطبيق الرئيسي عبر إشعار صامت (id: 9999).
 *   التطبيق الرئيسي (capacitor-bridge.js) يستقبل الإشعار ويجلب البيانات.
 *   هذا يمنع تكرار الإشعارات ويضمن المزامنة الصحيحة مع Firestore.
 */

addEventListener('weatherCheck', async function (resolve, reject, args) {
    try {
        var now  = new Date();
        var hour = now.getHours();

        // لا إيقاظ في ساعات الليل الهادئة
        if (hour >= 23 || hour < 6) {
            resolve({ skipped: true, reason: 'night_hours', hour: hour });
            return;
        }

        // إشعار صامت يُوقظ التطبيق الرئيسي ليتولى جلب البيانات
        await CapacitorLocalNotifications.schedule({
            notifications: [{
                id:         9999,
                title:      'طقس السودان',
                body:       'تحديث تلقائي',
                channelId:  'weather_persistent',
                ongoing:    false,
                autoCancel: true,
                silent:     true,
                smallIcon:  'ic_weather_notif',
                schedule:   { at: new Date(Date.now() + 200) },
                extra: { wakeup: true, ts: Date.now() }
            }]
        });

        // حفظ توقيت آخر إيقاظ
        await CapacitorPreferences.set({
            key:   'bg_last_wakeup',
            value: String(Date.now())
        });

        resolve({ success: true, wakeup_sent: true, hour: hour });

    } catch (e) {
        reject('BackgroundRunner wakeup failed: ' + e.message);
    }
});

