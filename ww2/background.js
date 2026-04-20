/**
 * background.js — ود السحاب v2.0
 * BackgroundRunner Script (@capacitor/background-runner)
 *
 * ⚠️ يعمل في JavaScriptCore — لا يوجد DOM ولا fetch عادي.
 * يُنفَّذ كل 3 ساعات (interval: 180 دقيقة) حتى مع إغلاق التطبيق.
 *
 * المسار: www/background.js
 */

/* ── حدث التحقق الدوري من الطقس ── */
addEventListener('weatherCheck', async function (resolve, reject, args) {
    try {
        var now   = new Date();
        var hour  = now.getHours();

        /* لا ترسل إشعاراً في الليل (23:00 – 06:00) */
        if (hour >= 23 || hour < 6) {
            resolve({ skipped: true, reason: 'night_hours', hour: hour });
            return;
        }

        /* ── جلب آخر موقع محفوظ ── */
        var locResult = await CapacitorPreferences.get({ key: 'lastKnownLocation' });
        var lat  = 15.5007;  // الخرطوم (افتراضي)
        var lon  = 32.5599;
        var city = 'السودان';

        if (locResult && locResult.value) {
            try {
                var loc = JSON.parse(locResult.value);
                lat  = loc.lat  || lat;
                lon  = loc.lon  || lon;
                city = loc.name || city;
            } catch (_) {}
        }

        /* ── جلب درجة الحرارة الحالية من Open-Meteo ── */
        var apiUrl = 'https://api.open-meteo.com/v1/forecast'
            + '?latitude='    + lat
            + '&longitude='   + lon
            + '&current=temperature_2m,weather_code,wind_speed_10m'
            + '&wind_speed_unit=kmh'
            + '&timezone=Africa%2FKhartoum';

        var response = await fetch(apiUrl);
        var wxData   = await response.json();

        var current = wxData.current || {};
        var temp    = current.temperature_2m;
        var wcode   = current.weather_code || 0;
        var wind    = current.wind_speed_10m || 0;

        /* ── تصنيف حالة الطقس ── */
        var desc    = _getWeatherDesc(wcode);
        var isAlert = _isAlertCondition(wcode, temp, wind);

        /* ── تحديث الإشعار الدائم ── */
        await CapacitorLocalNotifications.schedule({
            notifications: [{
                id:         9001,
                title:      '☁ ود السحاب — ' + city,
                body:       Math.round(temp) + '°م  ·  ' + desc,
                channelId:  'weather_persistent',
                ongoing:    true,
                autoCancel: false,
                silent:     true,
                smallIcon:  'ic_weather_notif',
                iconColor:  '#f59e0b',
                schedule:   { at: new Date() },
                extra: { type: 'sticky_weather', temp: temp }
            }]
        });

        /* ── إشعار تنبيهي إذا كانت الأحوال خطيرة ── */
        if (isAlert) {
            var alertTitle = _getAlertTitle(wcode, temp, wind);
            var alertBody  = _getAlertBody(wcode, temp, wind, city);

            await CapacitorLocalNotifications.schedule({
                notifications: [{
                    id:         Math.floor(Math.random() * 5000) + 2000,
                    title:      alertTitle,
                    body:       alertBody,
                    channelId:  'weather_alerts',
                    ongoing:    false,
                    autoCancel: true,
                    sound:      'default',
                    smallIcon:  'ic_weather_notif',
                    iconColor:  '#ef4444',
                    schedule:   { at: new Date() },
                    extra: { type: 'weather_alert', lat: lat, lon: lon }
                }]
            });
        }

        /* حفظ آخر تحديث في Preferences */
        await CapacitorPreferences.set({
            key:   'bg_last_check',
            value: JSON.stringify({
                ts:   Date.now(),
                temp: temp,
                desc: desc,
                city: city
            })
        });

        resolve({ success: true, temp: temp, city: city, alert: isAlert });

    } catch (e) {
        /* في حالة الخطأ — أرسل إشعاراً يطلب التحديث اليدوي */
        try {
            await CapacitorLocalNotifications.schedule({
                notifications: [{
                    id:        7777,
                    title:     '☁ ود السحاب',
                    body:      'اضغط لتحديث بيانات الطقس',
                    channelId: 'weather_daily',
                    schedule:  { at: new Date() },
                    extra: { type: 'bg_refresh_request' }
                }]
            });
        } catch (_) {}

        reject('BackgroundRunner Error: ' + e.message);
    }
});

/* ════════════════════════════════════════
   دوال مساعدة (JavaScriptCore — لا DOM)
════════════════════════════════════════ */

function _getWeatherDesc(code) {
    if (code === 0)                  return 'صحو';
    if (code <= 3)                   return 'غيوم جزئية';
    if (code <= 49)                  return 'ضباب';
    if (code <= 67)                  return 'أمطار';
    if (code <= 77)                  return 'ثلج';
    if (code <= 82)                  return 'زخات مطر';
    if (code >= 95 && code <= 99)    return 'عواصف رعدية';
    return 'متغير';
}

function _isAlertCondition(code, temp, wind) {
    /* عاصفة رعدية */
    if (code >= 95) return true;
    /* حرارة شديدة (السودان: > 45°م) */
    if (temp > 45)  return true;
    /* رياح شديدة (> 50 كم/س) — غبار/هبوب محتمل */
    if (wind > 50)  return true;
    return false;
}

function _getAlertTitle(code, temp, wind) {
    if (code >= 95)    return '⚡ تحذير: عواصف رعدية';
    if (temp > 45)     return '🌡 تحذير: موجة حر شديدة';
    if (wind > 50)     return '💨 تحذير: رياح شديدة / هبوب';
    return '⚠ تنبيه طقس — ود السحاب';
}

function _getAlertBody(code, temp, wind, city) {
    if (code >= 95) {
        return city + ': عواصف رعدية متوقعة. الرجاء الابتعاد عن الأماكن المكشوفة.';
    }
    if (temp > 45) {
        return city + ': درجة الحرارة ' + Math.round(temp) + '°م. تجنّب التعرض للشمس المباشرة.';
    }
    if (wind > 50) {
        return city + ': رياح ' + Math.round(wind) + ' كم/س. غبار أو هبوب محتمل — ابقَ في المنزل.';
    }
    return city + ': تنبيه طقس — افتح التطبيق للتفاصيل.';
}
