#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch_appjs.py — ود السحاب v2.0
===================================
يُدمج capacitor-bridge.js في index.html بأمان عبر Python string-replace.
يعمل مع ملفات Unicode/العربية بدون مشاكل ترميز.

الاستخدام:
    python3 patch_appjs.py www/index.html

يقوم بـ:
  1. حقن <script src="capacitor-bridge.js"></script> قبل </body>
  2. إضافة fetchWeatherByCoords() كـ GPS hook للكود الموجود
  3. تحديث تهيئة currentCity لتفحص آخر موقع GPS
"""

import sys
import os
import shutil
import re

# ══════════════════════════════════════════════════════════
# إعدادات
# ══════════════════════════════════════════════════════════

TARGET = sys.argv[1] if len(sys.argv) > 1 else 'www/index.html'
BACKUP = TARGET + '.bak'

BRIDGE_SCRIPT_TAG = '<script src="capacitor-bridge.js"></script>'

# ── الكود المحقون: fetchWeatherByCoords ──────────────────
# يُضاف قبل دالة makeTimeout
FETCH_BY_COORDS_CODE = '''
        // ══════════════════════════════════════════════════
        // fetchWeatherByCoords — GPS Hook (ود السحاب v2.0)
        // يُستدعى من capacitor-bridge.js عند تحديد موقع GPS
        // أو اختيار مدينة من شريط البحث.
        // ══════════════════════════════════════════════════
        window.fetchWeatherByCoords = async function(lat, lon, cityName) {
            // أضف/حدّث إدخال 'gps' في allCities
            if (typeof allCities !== 'undefined') {
                allCities['gps'] = {
                    name:   cityName || 'موقعك الحالي',
                    lat:    lat,
                    lon:    lon,
                    elev:   0,
                    region: 'GPS'
                };
                window.allCities = allCities;
            }
            window.currentCity = 'gps';

            // استدعِ دالة تغيير المدينة الموجودة
            if (typeof changeCity === 'function') {
                changeCity('gps');
            } else if (typeof loadWeatherData === 'function') {
                loadWeatherData('gps');
            }
        };

'''

# ── تعديل تهيئة currentCity ──────────────────────────────
OLD_CITY_INIT = "if (typeof window.currentCity === 'undefined')  window.currentCity  = 'khartoum';"

NEW_CITY_INIT = """if (typeof window.currentCity === 'undefined')  window.currentCity  = 'khartoum';
        // [v2.0] استعادة آخر مدينة GPS عند إعادة فتح التطبيق
        (function() {
            try {
                var savedGps = localStorage.getItem('offline_lastCity');
                if (savedGps && savedGps !== 'gps' && typeof allCities !== 'undefined' && allCities[savedGps]) {
                    window.currentCity = savedGps;
                }
            } catch(_) {}
        })();"""

# ══════════════════════════════════════════════════════════
# تنفيذ التعديلات
# ══════════════════════════════════════════════════════════

def patch_html(filepath):
    print(f'[WodPatch] قراءة: {filepath}')
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    original = content
    changes  = 0

    # ── 1. حقن <script src="capacitor-bridge.js"> قبل </body> ──
    if BRIDGE_SCRIPT_TAG not in content:
        if '</body>' in content:
            content = content.replace(
                '</body>',
                f'\n    {BRIDGE_SCRIPT_TAG}\n</body>',
                1
            )
            changes += 1
            print('[WodPatch] ✅ تم حقن <script src="capacitor-bridge.js"> قبل </body>')
        else:
            print('[WodPatch] ⚠️  لم يُعثر على </body> — يُضاف في نهاية الملف')
            content += f'\n{BRIDGE_SCRIPT_TAG}\n'
            changes += 1
    else:
        print('[WodPatch] ℹ️  capacitor-bridge.js محقون مسبقاً — تخطي')

    # ── 2. إضافة fetchWeatherByCoords قبل makeTimeout ──────
    ANCHOR_MAKE_TIMEOUT = 'function makeTimeout(ms) {'
    if 'window.fetchWeatherByCoords' not in content:
        if ANCHOR_MAKE_TIMEOUT in content:
            content = content.replace(
                ANCHOR_MAKE_TIMEOUT,
                FETCH_BY_COORDS_CODE + '        ' + ANCHOR_MAKE_TIMEOUT,
                1
            )
            changes += 1
            print('[WodPatch] ✅ تم إضافة fetchWeatherByCoords()')
        else:
            print('[WodPatch] ⚠️  لم يُعثر على makeTimeout — تخطي fetchWeatherByCoords')
    else:
        print('[WodPatch] ℹ️  fetchWeatherByCoords موجودة مسبقاً — تخطي')

    # ── 3. تحديث تهيئة currentCity ─────────────────────────
    if OLD_CITY_INIT in content and 'استعادة آخر مدينة GPS' not in content:
        content = content.replace(OLD_CITY_INIT, NEW_CITY_INIT, 1)
        changes += 1
        print('[WodPatch] ✅ تم تحديث تهيئة currentCity مع دعم GPS')
    else:
        print('[WodPatch] ℹ️  تهيئة currentCity محدَّثة مسبقاً أو لم تُعثر — تخطي')

    # ══════════════════════════════════════════════════════
    # كتابة النتيجة
    # ══════════════════════════════════════════════════════
    if changes == 0:
        print('[WodPatch] ✅ لا توجد تعديلات جديدة — الملف محدَّث مسبقاً')
        return

    # نسخة احتياطية
    shutil.copy2(filepath, BACKUP)
    print(f'[WodPatch] 💾 نسخة احتياطية: {BACKUP}')

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)

    print(f'[WodPatch] ✅ تم تطبيق {changes} تعديل على {filepath}')

    # تحقق من الحجم
    orig_size = len(original.encode('utf-8'))
    new_size  = len(content.encode('utf-8'))
    print(f'[WodPatch]    الحجم: {orig_size:,} → {new_size:,} بايت (+{new_size - orig_size:,})')


if __name__ == '__main__':
    if not os.path.exists(TARGET):
        print(f'[WodPatch] ❌ الملف غير موجود: {TARGET}')
        print('الاستخدام: python3 patch_appjs.py www/index.html')
        sys.exit(1)

    patch_html(TARGET)
    print('[WodPatch] 🎉 اكتمل بنجاح!')
