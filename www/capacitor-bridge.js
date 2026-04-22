/**
 * capacitor-bridge.js — ود السحاب v2.0
 * الجسر الكامل بين طبقة HTML والميزات الأصيلة (Native)
 *
 * يوفر:
 *   1. GPS تلقائي + بحث Geocoding مع إكمال تلقائي
 *   2. إشعارات محلية (تنبيهات + إشعار دائم)
 *   3. وضع الأوفلاين (حفظ/استعادة آخر بيانات)
 *   4. الوضع الليلي التلقائي
 *   5. شريط بحث المدن مع GPS (يُحقن في UI تلقائياً)
 *
 * الاستخدام: يُحقن تلقائياً في index.html عبر patch_appjs.py
 */
(function () {
    'use strict';

    /* ═══════════════════════════════════════════════════════
       ثوابت
    ═══════════════════════════════════════════════════════ */
    var GEOCODING_API      = 'https://geocoding-api.open-meteo.com/v1/search';
    var STICKY_NOTIF_ID    = 9001;
    var CH_ALERTS          = 'weather_alerts';
    var CH_PERSISTENT      = 'weather_persistent';
    var CH_DAILY           = 'weather_daily';

    /* ═══════════════════════════════════════════════════════
       انتظر تهيئة Capacitor (WebView يحتاج لحظة للتحميل)
    ═══════════════════════════════════════════════════════ */
    function _isNative() {
        return (
            typeof window.Capacitor !== 'undefined' &&
            typeof window.Capacitor.Plugins !== 'undefined' &&
            window.Capacitor.isNativePlatform()
        );
    }

    async function _waitCapacitor(maxMs) {
        maxMs = maxMs || 6000;
        var step = 80, elapsed = 0;
        while (!_isNative() && elapsed < maxMs) {
            await _sleep(step);
            elapsed += step;
        }
        return _isNative();
    }

    function _sleep(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    function _P(name) {
        // اختصار للوصول للـ Plugin باسمه
        return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name];
    }

    /* ═══════════════════════════════════════════════════════
       الجسر الرئيسي
    ═══════════════════════════════════════════════════════ */
    window.WodBridge = {

        /* ───────────────────────────────────────────────
           1. GPS — جلب الموقع الحالي
        ─────────────────────────────────────────────── */
        getLocation: async function () {
            var ready = await _waitCapacitor();
            if (!ready) {
                // بيئة المتصفح — استخدم Geolocation API العادي
                return _browserGeolocation();
            }

            var Geo = _P('Geolocation');
            var Pref = _P('Preferences');

            try {
                // طلب الإذن
                var perm = await Geo.requestPermissions({ permissions: ['location', 'coarseLocation'] });
                if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
                    throw new Error('رُفض إذن الموقع من المستخدم');
                }

                var pos = await Geo.getCurrentPosition({
                    enableHighAccuracy: true,
                    timeout: 12000,
                    maximumAge: 60000
                });

                var result = {
                    lat:      pos.coords.latitude,
                    lon:      pos.coords.longitude,
                    accuracy: Math.round(pos.coords.accuracy || 0),
                    name:     'موقعك الحالي',
                    fromGps:  true
                };

                // حفظ لاستخدامه عند الأوفلاين
                if (Pref) {
                    await Pref.set({
                        key:   'lastKnownLocation',
                        value: JSON.stringify(result)
                    });
                }

                return result;

            } catch (e) {
                // محاولة استرجاع آخر موقع محفوظ
                if (Pref) {
                    try {
                        var stored = await Pref.get({ key: 'lastKnownLocation' });
                        if (stored && stored.value) {
                            var cached = JSON.parse(stored.value);
                            cached.fromCache = true;
                            cached.name = cached.name || 'آخر موقع معروف';
                            return cached;
                        }
                    } catch (_) {}
                }
                throw e;
            }
        },

        /* ───────────────────────────────────────────────
           2. بحث المدن (Geocoding)
           أولاً: قاعدة المدن المحلية → ثانياً: Open-Meteo
        ─────────────────────────────────────────────── */
        searchCity: async function (query) {
            if (!query || query.trim().length < 2) return [];

            // ابحث أولاً في المدن المحلية (فوري)
            var local = _searchLocalCities(query);
            if (local.length >= 3) return local;

            // ثم Open-Meteo Geocoding
            try {
                var url = GEOCODING_API
                    + '?name=' + encodeURIComponent(query)
                    + '&count=8&language=ar&format=json';
                var res = await fetch(url, {
                    signal: (typeof makeTimeout === 'function') ? makeTimeout(8000) : undefined
                });
                var data = await res.json();
                if (!data.results) return local;

                var remote = data.results.map(function (r) {
                    return {
                        name:   r.name,
                        lat:    r.latitude,
                        lon:    r.longitude,
                        region: r.admin1 || r.country || '',
                        elev:   Math.round(r.elevation || 0),
                        source: 'geocoding'
                    };
                });

                // دمج: المدن المحلية أولاً ثم النتائج الخارجية (بدون تكرار)
                var names = local.map(function (c) { return c.name; });
                var unique = remote.filter(function (c) { return names.indexOf(c.name) === -1; });
                return local.concat(unique).slice(0, 8);

            } catch (_) {
                return local;
            }
        },

        /* ───────────────────────────────────────────────
           3. إرسال تنبيه طقس فوري
        ─────────────────────────────────────────────── */
        scheduleWeatherAlert: async function (opts) {
            // opts: { title, body, id?, urgent?, channelId? }
            await _waitCapacitor();
            var LN = _P('LocalNotifications');
            if (!LN) return null;

            var notifId = opts.id || (Math.floor(Math.random() * 8000) + 1000);

            try {
                await LN.schedule({
                    notifications: [{
                        id:         notifId,
                        title:      opts.title || 'تنبيه طقس السودان',
                        body:       opts.body  || '',
                        channelId:  opts.channelId || (opts.urgent ? CH_ALERTS : CH_DAILY),
                        schedule:   { at: new Date(Date.now() + 500) },
                        sound:      'default',
                        autoCancel: true,
                        smallIcon:  'ic_weather_notif',
                        iconColor:  opts.urgent ? '#ef4444' : '#f59e0b',
                        extra: {
                            type:   'weather_alert',
                            urgent: !!opts.urgent
                        }
                    }]
                });
                return notifId;
            } catch (e) {
                console.warn('[WodBridge] scheduleWeatherAlert:', e.message);
                return null;
            }
        },

        /* ───────────────────────────────────────────────
           4. الإشعار الدائم (Sticky) — درجة الحرارة
           يظهر في شريط التنبيهات حتى مع إغلاق التطبيق
        ─────────────────────────────────────────────── */
        updateStickyNotif: async function (temp, desc, city) {
            await _waitCapacitor();
            var LN = _P('LocalNotifications');
            if (!LN) return false;

            city = city || 'السودان';
            desc = desc || 'جاري التحديث...';
            var tempStr = (temp !== null && temp !== undefined)
                ? (Math.round(temp) + '°م')
                : '---';

            // إلغاء الإشعار الدائم القديم أولاً
            try {
                await LN.cancel({ notifications: [{ id: STICKY_NOTIF_ID }] });
            } catch (_) {}

            try {
                await LN.schedule({
                    notifications: [{
                        id:         STICKY_NOTIF_ID,
                        title:      '☁ ود السحاب — ' + city,
                        body:       tempStr + '  ·  ' + desc,
                        channelId:  CH_PERSISTENT,
                        ongoing:    true,      // ← إشعار دائم لا يُغلق
                        autoCancel: false,
                        silent:     true,      // ← بدون صوت أو اهتزاز
                        smallIcon:  'ic_weather_notif',
                        iconColor:  '#f59e0b',
                        schedule:   { at: new Date(Date.now() + 300) },
                        extra: { type: 'sticky_weather' }
                    }]
                });
                return true;
            } catch (e) {
                console.warn('[WodBridge] updateStickyNotif:', e.message);
                return false;
            }
        },

        /* ───────────────────────────────────────────────
           5. إلغاء الإشعار الدائم
        ─────────────────────────────────────────────── */
        cancelStickyNotif: async function () {
            await _waitCapacitor();
            var LN = _P('LocalNotifications');
            if (!LN) return;
            try {
                await LN.cancel({ notifications: [{ id: STICKY_NOTIF_ID }] });
            } catch (_) {}
        },

        /* ───────────────────────────────────────────────
           6. طلب إذن الإشعارات
        ─────────────────────────────────────────────── */
        requestNotifPermission: async function () {
            await _waitCapacitor();
            var LN = _P('LocalNotifications');
            if (!LN) return false;
            try {
                var perm = await LN.requestPermissions();
                return perm.display === 'granted';
            } catch (_) { return false; }
        },

        /* ───────────────────────────────────────────────
           7. حالة الشبكة
        ─────────────────────────────────────────────── */
        isOnline: async function () {
            if (!_isNative()) return navigator.onLine;
            var Net = _P('Network');
            if (!Net) return navigator.onLine;
            try {
                var status = await Net.getStatus();
                return status.connected;
            } catch (_) { return navigator.onLine; }
        },

        onNetworkChange: function (cb) {
            _waitCapacitor().then(function () {
                var Net = _P('Network');
                if (Net) {
                    Net.addListener('networkStatusChange', cb).catch(function () {});
                }
            });
            // fallback للمتصفح
            window.addEventListener('online',  function () { cb({ connected: true,  connectionType: 'wifi' }); });
            window.addEventListener('offline', function () { cb({ connected: false, connectionType: 'none' }); });
        },

        /* ───────────────────────────────────────────────
           8. حفظ / استرجاع بيانات الأوفلاين
        ─────────────────────────────────────────────── */
        saveOfflineData: async function (cityKey, weatherData) {
            var payload = JSON.stringify({ data: weatherData, ts: Date.now(), cityKey: cityKey });

            // أولاً: Capacitor Preferences (أكثر موثوقية)
            if (_isNative()) {
                var Pref = _P('Preferences');
                if (Pref) {
                    try {
                        await Pref.set({ key: 'offline_wx_' + cityKey, value: payload });
                        await Pref.set({ key: 'offline_lastCity',       value: cityKey });
                        return true;
                    } catch (_) {}
                }
            }

            // ثانياً: localStorage (fallback)
            try {
                localStorage.setItem('offline_wx_' + cityKey, payload);
                localStorage.setItem('offline_lastCity', cityKey);
                return true;
            } catch (_) { return false; }
        },

        loadOfflineData: async function (cityKey) {
            var key = cityKey;

            if (!key) {
                // جلب آخر مدينة محفوظة
                if (_isNative()) {
                    var Pref = _P('Preferences');
                    if (Pref) {
                        try {
                            var r = await Pref.get({ key: 'offline_lastCity' });
                            key = r && r.value;
                        } catch (_) {}
                    }
                }
                if (!key) key = localStorage.getItem('offline_lastCity');
            }

            if (!key) return null;

            // Capacitor Preferences
            if (_isNative()) {
                var Pref2 = _P('Preferences');
                if (Pref2) {
                    try {
                        var stored = await Pref2.get({ key: 'offline_wx_' + key });
                        if (stored && stored.value) return JSON.parse(stored.value);
                    } catch (_) {}
                }
            }

            // localStorage fallback
            try {
                var raw = localStorage.getItem('offline_wx_' + key);
                return raw ? JSON.parse(raw) : null;
            } catch (_) { return null; }
        },

        /* ───────────────────────────────────────────────
           9. الوضع الليلي التلقائي
        ─────────────────────────────────────────────── */
        initDarkMode: function () {
            // [FIX-3] احترم تفضيل الثيم الموجود في التطبيق أولاً (مخزون بمفتاح 'theme')
            var appTheme = localStorage.getItem('theme');
            if (appTheme === 'light' || appTheme === 'dark') {
                _applyDarkMode(appTheme === 'dark');
                return;
            }

            var saved = localStorage.getItem('wodDarkMode');

            if (saved === null) {
                // تلقائي بناءً على النظام
                var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
                _applyDarkMode(prefersDark);
            } else {
                _applyDarkMode(saved === 'true');
            }

            // تابع تغييرات النظام
            window.matchMedia('(prefers-color-scheme: dark)')
                .addEventListener('change', function (e) {
                    if (localStorage.getItem('wodDarkMode') === null &&
                        localStorage.getItem('theme') === null) {
                        _applyDarkMode(e.matches);
                    }
                });
        },

        toggleDarkMode: function () {
            var isDark = document.body.classList.contains('wod-dark');
            _applyDarkMode(!isDark);
            localStorage.setItem('wodDarkMode', String(!isDark));
        },

        /* ───────────────────────────────────────────────
           10. تهيئة كاملة (يُستدعى عند DOMContentLoaded)
        ─────────────────────────────────────────────── */
        init: async function () {
            var ready = await _waitCapacitor(8000);
            window._wodNative = ready;
            window._wodBridgeMode = ready ? 'native' : 'browser';

            // الوضع الليلي
            this.initDarkMode();

            if (ready) {
                // طلب أذونات الإشعارات
                await this.requestNotifPermission();

                // مراقبة الشبكة
                this.onNetworkChange(function (status) {
                    window._wodOnline = status.connected;
                    window.dispatchEvent(
                        new CustomEvent('wodNetworkChange', { detail: status })
                    );
                    _showOfflineBanner(!status.connected);
                });
            }

            // حالة الشبكة الأولية
            window._wodOnline = await this.isOnline();

            // إذا كان أوفلاين → حمّل آخر بيانات
            if (!window._wodOnline) {
                _showOfflineBanner(true);
                var offlineData = await this.loadOfflineData();
                if (offlineData) {
                    window._offlineWeatherData = offlineData;
                    window.dispatchEvent(
                        new CustomEvent('wodOfflineData', { detail: offlineData })
                    );
                }
            }

            // أخبر باقي الكود أن الجسر جاهز
            window.dispatchEvent(new Event('wodBridgeReady'));
            return ready;
        }
    };

    /* ═══════════════════════════════════════════════════════
       دوال مساعدة داخلية
    ═══════════════════════════════════════════════════════ */

    function _applyDarkMode(isDark) {
        if (isDark) {
            document.body.classList.add('wod-dark');
            // [FIX-2] اضبط على body وليس documentElement — CSS التطبيق يستخدم body[data-theme]
            document.body.setAttribute('data-theme', 'dark');
        } else {
            document.body.classList.remove('wod-dark');
            document.body.setAttribute('data-theme', 'light');
        }
        window.dispatchEvent(
            new CustomEvent('wodDarkModeChange', { detail: { dark: isDark } })
        );
    }

    function _searchLocalCities(query) {
        var allCities = window.allCities;
        if (!allCities) return [];

        var q = query.trim();
        // نمط: حروف عربية/لاتينية + رقم اختياري
        var results = [];
        var entries = Object.entries(allCities);

        for (var i = 0; i < entries.length; i++) {
            var key  = entries[i][0];
            var city = entries[i][1];
            var name = city.name || '';

            if (
                name.includes(q) ||
                key.toLowerCase().includes(q.toLowerCase())
            ) {
                results.push({
                    key:    key,
                    name:   name,
                    lat:    city.lat,
                    lon:    city.lon,
                    elev:   city.elev   || 0,
                    region: city.region || '',
                    source: 'local'
                });
            }
        }
        return results;
    }

    function _browserGeolocation() {
        return new Promise(function (resolve, reject) {
            if (!navigator.geolocation) {
                reject(new Error('الجهاز لا يدعم GPS'));
                return;
            }
            navigator.geolocation.getCurrentPosition(
                function (pos) {
                    resolve({
                        lat:     pos.coords.latitude,
                        lon:     pos.coords.longitude,
                        accuracy: pos.coords.accuracy,
                        name:    'موقعك الحالي',
                        fromBrowser: true
                    });
                },
                function (e) { reject(new Error('GPS: ' + e.message)); },
                { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
            );
        });
    }

    /* ═══════════════════════════════════════════════════════
       شريط البحث + زر GPS — حقن واجهة المستخدم تلقائياً
    ═══════════════════════════════════════════════════════ */

    /* ═══════════════════════════════════════════════════════
       [FIX-5] ربط الجسر بشريط البحث الموجود في التطبيق
       يُستدعى عندما يكتشف الجسر وجود #citySelector
       يربط زر GPS الموجود (#cityGpsBtn) بـ WodBridge.getLocation()
    ═══════════════════════════════════════════════════════ */
    function _bindExistingSearchBar() {
        // زر GPS الموجود في التطبيق
        var existingGpsBtn = document.getElementById('cityGpsBtn');
        if (existingGpsBtn && !existingGpsBtn.dataset.wodBound) {
            existingGpsBtn.dataset.wodBound = '1';

            existingGpsBtn.addEventListener('click', async function (e) {
                // أوقف السلوك الافتراضي فقط إذا كنا في البيئة الأصلية
                if (!_isNative()) return; // في المتصفح: اترك السلوك الأصلي

                e.stopImmediatePropagation(); // امنع المستمع الآخر من التنفيذ المزدوج

                existingGpsBtn.classList.add('gps-loading');
                try {
                    var loc = await WodBridge.getLocation();
                    existingGpsBtn.classList.remove('gps-loading');

                    // حدّث شارة المدينة الموجودة
                    var badge = document.getElementById('cityCurBadge');
                    if (badge) {
                        badge.textContent = loc.name || 'موقعك';
                        badge.style.display = 'block';
                    }

                    await _loadWeatherByCoords(loc.lat, loc.lon, loc.name || 'موقعك الحالي');

                    if (typeof window.showToast === 'function') {
                        window.showToast(loc.fromCache ? 'آخر موقع محفوظ' : 'تم تحديد موقعك ✓', 'success');
                    }
                } catch (e) {
                    existingGpsBtn.classList.remove('gps-loading');
                    if (typeof window.showToast === 'function') {
                        window.showToast('تعذّر الموقع — تحقق من إذن GPS', 'error');
                    }
                }
            });
        }
    }

    function _injectSearchBar() {
        if (document.getElementById('wodCitySelector')) return; // حُقن مسبقاً

        // ══════════════════════════════════════════════════════
        // [FIX-1] إذا كان التطبيق لديه شريط بحث خاص به (#citySelector)
        // لا نحقن شريطاً ثانياً — فقط نربط أحداث GPS والبحث بالعناصر الموجودة
        // ══════════════════════════════════════════════════════
        if (document.getElementById('citySelector')) {
            _bindExistingSearchBar();
            return;
        }

        /* ── CSS ── */
        var css = [
            '#wodCitySelector{',
            '  position:relative;display:flex;align-items:center;gap:8px;',
            '  padding:8px 12px 8px 12px;',
            '  background:rgba(255,255,255,0.04);',
            '  border-bottom:1px solid rgba(255,255,255,0.07);',
            '  direction:rtl;z-index:200;',
            '}',
            '#wodSearchWrapper{flex:1;position:relative;}',
            '#wodSearchBar{',
            '  width:100%;box-sizing:border-box;',
            '  background:rgba(255,255,255,0.07);',
            '  border:1.5px solid rgba(245,158,11,.3);',
            '  border-radius:14px;padding:10px 14px;',
            '  color:#f1f5f9;font-size:.9rem;',
            "  font-family:'Cairo','DM Sans',sans-serif;",
            '  outline:none;direction:rtl;',
            '  transition:border-color .2s;',
            '}',
            '#wodSearchBar:focus{border-color:#f59e0b;}',
            "#wodSearchBar::placeholder{color:rgba(241,245,249,.38);font-family:'Cairo',sans-serif;}",
            '#wodGpsBtn{',
            '  background:rgba(245,158,11,.13);',
            '  border:1.5px solid rgba(245,158,11,.45);',
            '  border-radius:14px;padding:10px 13px;',
            '  color:#f59e0b;font-size:1.15rem;cursor:pointer;',
            '  transition:all .2s;min-width:46px;display:flex;',
            '  align-items:center;justify-content:center;',
            '  user-select:none;-webkit-user-select:none;',
            '}',
            '#wodGpsBtn:active{background:rgba(245,158,11,.28);transform:scale(.94);}',
            '#wodGpsBtn.loading{animation:wodGpsSpin .9s linear infinite;}',
            '@keyframes wodGpsSpin{to{transform:rotate(360deg)}}',
            '#wodSearchResults{',
            '  position:absolute;top:calc(100% + 4px);right:0;left:0;',
            '  background:#161d2c;',
            '  border:1.5px solid rgba(245,158,11,.3);',
            '  border-radius:14px;overflow:hidden;',
            '  box-shadow:0 10px 40px rgba(0,0,0,.7);',
            '  z-index:9999;max-height:250px;overflow-y:auto;',
            '  display:none;',
            '}',
            '#wodSearchResults.open{display:block;}',
            '.wod-sri{',
            '  padding:12px 16px;color:#e2e8f0;cursor:pointer;',
            '  display:flex;align-items:center;gap:10px;',
            "  font-family:'Cairo',sans-serif;font-size:.88rem;",
            '  border-bottom:1px solid rgba(255,255,255,.05);',
            '  transition:background .15s;direction:rtl;',
            '}',
            '.wod-sri:last-child{border-bottom:none;}',
            '.wod-sri:active{background:rgba(245,158,11,.13);}',
            '.wod-sri .wod-reg{font-size:.74rem;color:rgba(241,245,249,.45);margin-right:auto;}',
            '#wodCityBadge{',
            '  font-size:.78rem;color:rgba(245,158,11,.9);',
            "  font-family:'Cairo',sans-serif;padding:3px 9px;",
            '  background:rgba(245,158,11,.1);border-radius:10px;',
            '  white-space:nowrap;display:none;max-width:90px;',
            '  overflow:hidden;text-overflow:ellipsis;',
            '}'
        ].join('\n');

        var style = document.createElement('style');
        style.id = 'wodSearchStyle';
        style.textContent = css;
        document.head.appendChild(style);

        /* ── HTML ── */
        var html = [
            '<div id="wodCitySelector">',
            '  <button id="wodGpsBtn" title="موقعي الحالي">📍</button>',
            '  <div id="wodSearchWrapper">',
            '    <input id="wodSearchBar" type="search"',
            '           placeholder="ابحث عن مدينة... الخرطوم، نيالا..."',
            '           autocomplete="off" inputmode="search" />',
            '    <div id="wodSearchResults"></div>',
            '  </div>',
            '  <span id="wodCityBadge"></span>',
            '</div>'
        ].join('\n');

        /* إيجاد أفضل موضع للحقن */
        var anchor = (
            document.querySelector('.header, header, .top-bar, #header, #topBar') ||
            document.querySelector('.app-container, #app, .main-container') ||
            document.body
        );

        if (anchor === document.body) {
            anchor.insertAdjacentHTML('afterbegin', html);
        } else if (anchor.parentNode === document.body) {
            anchor.insertAdjacentHTML('beforebegin', html);
        } else {
            document.body.insertAdjacentHTML('afterbegin', html);
        }

        _bindSearchEvents();
    }

    /* ── ربط أحداث شريط البحث ── */
    function _bindSearchEvents() {
        var searchBar = document.getElementById('wodSearchBar');
        var gpsBtn    = document.getElementById('wodGpsBtn');
        var results   = document.getElementById('wodSearchResults');
        var badge     = document.getElementById('wodCityBadge');

        if (!searchBar || !gpsBtn) return;

        var debounceTimer = null;

        /* البحث النصي */
        searchBar.addEventListener('input', function () {
            clearTimeout(debounceTimer);
            var q = this.value.trim();
            if (q.length < 2) {
                results.innerHTML = '';
                results.classList.remove('open');
                return;
            }
            debounceTimer = setTimeout(async function () {
                var found = await WodBridge.searchCity(q);
                _renderSearchResults(found, results);
            }, 280);
        });

        searchBar.addEventListener('blur', function () {
            setTimeout(function () {
                results.classList.remove('open');
            }, 220);
        });

        /* زر GPS */
        gpsBtn.addEventListener('click', async function () {
            gpsBtn.textContent = '⏳';
            gpsBtn.disabled = true;
            gpsBtn.classList.add('loading');

            try {
                if (typeof window.showToast === 'function') {
                    window.showToast('جاري تحديد موقعك...', 'info');
                }
                var loc = await WodBridge.getLocation();

                gpsBtn.textContent = '📍';
                gpsBtn.disabled = false;
                gpsBtn.classList.remove('loading');

                _setCityBadge(badge, loc.name || 'موقعك');
                await _loadWeatherByCoords(loc.lat, loc.lon, loc.name || 'موقعك الحالي');

                if (typeof window.showToast === 'function') {
                    if (loc.fromCache) {
                        window.showToast('تم استخدام آخر موقع محفوظ', 'warn');
                    } else {
                        window.showToast('تم تحديد موقعك ✓', 'success');
                    }
                }
            } catch (e) {
                gpsBtn.textContent = '📍';
                gpsBtn.disabled = false;
                gpsBtn.classList.remove('loading');
                if (typeof window.showToast === 'function') {
                    window.showToast('تعذّر الموقع — تحقق من إذن GPS', 'error');
                }
            }
        });
    }

    function _setCityBadge(badge, name) {
        if (!badge) return;
        badge.textContent = name;
        badge.style.display = 'block';
        // اخفِ بعد 5 ثوانٍ وأبقِه صغيراً
        setTimeout(function () {
            badge.style.opacity = '.7';
        }, 5000);
    }

    function _renderSearchResults(cities, container) {
        if (!cities || cities.length === 0) {
            container.innerHTML = '<div class="wod-sri" style="color:rgba(241,245,249,.4);justify-content:center;cursor:default;">لا توجد نتائج</div>';
            container.classList.add('open');
            return;
        }

        // [FIX-7] بناء العناصر برمجياً بدلاً من innerHTML لتجنب XSS
        container.innerHTML = '';
        cities.slice(0, 7).forEach(function (city) {
            var item = document.createElement('div');
            item.className = 'wod-sri';

            var icon = document.createElement('span');
            icon.textContent = '🏙';

            var nameSpan = document.createElement('span');
            nameSpan.textContent = city.name || '';

            item.appendChild(icon);
            item.appendChild(nameSpan);

            if (city.region) {
                var reg = document.createElement('span');
                reg.className = 'wod-reg';
                reg.textContent = city.region;
                item.appendChild(reg);
            }

            item.addEventListener('mousedown', function (e) {
                e.preventDefault();
                WodBridge._pick(city.lat, city.lon, city.name || '', city.key || '');
            });

            container.appendChild(item);
        });

        container.classList.add('open');
    }

    /* اختيار مدينة من نتائج البحث */
    window.WodBridge._pick = async function (lat, lon, name, key) {
        var results = document.getElementById('wodSearchResults');
        var searchBar = document.getElementById('wodSearchBar');
        var badge = document.getElementById('wodCityBadge');
        if (results)   results.classList.remove('open');
        if (searchBar) searchBar.value = name;
        _setCityBadge(badge, name);
        await _loadWeatherByCoords(lat, lon, name, key);
    };

    /* تحميل الطقس بالإحداثيات */
    async function _loadWeatherByCoords(lat, lon, name, key) {
        window._currentCityCoords = { lat: lat, lon: lon, name: name, key: key };

        /* ── الحالة 1: مدينة معروفة في القاموس ── */
        if (key && window.allCities && window.allCities[key]) {
            window.currentCity = key;
            // [FIX-4] استخدم selectCityFromDropdown إذا كانت موجودة (التطبيق الحالي)
            if (typeof selectCityFromDropdown === 'function') {
                selectCityFromDropdown(key);
                return;
            }
            if (typeof changeCity === 'function') {
                changeCity(key);
                return;
            }
        }

        /* ── الحالة 2: إحداثيات GPS أو مدينة خارجية ── */
        if (window.allCities) {
            window.allCities['gps'] = {
                name:   name || 'موقعك الحالي',
                lat:    lat,
                lon:    lon,
                elev:   0,
                region: 'GPS'
            };
        }
        window.currentCity = 'gps';

        // جرّب دوال التطبيق المتاحة بالترتيب
        if (typeof fetchWeatherByCoords === 'function') {
            fetchWeatherByCoords(lat, lon, name);
        } else if (typeof changeCity === 'function') {
            changeCity('gps');
        } else {
            window.dispatchEvent(
                new CustomEvent('wodLoadWeather', { detail: { lat: lat, lon: lon, name: name } })
            );
        }
    }

    /* ═══════════════════════════════════════════════════════
       لافتة الأوفلاين
    ═══════════════════════════════════════════════════════ */
    function _showOfflineBanner(show) {
        var banner = document.getElementById('wodOfflineBanner');

        if (show) {
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'wodOfflineBanner';
                banner.style.cssText = [
                    'position:fixed;bottom:72px;left:50%;',
                    'transform:translateX(-50%);',
                    'background:#1e293b;',
                    'border:1.5px solid #475569;',
                    'border-radius:20px;padding:8px 18px;',
                    'color:#94a3b8;font-size:.82rem;',
                    "font-family:'Cairo',sans-serif;",
                    'z-index:9990;display:flex;gap:8px;',
                    'align-items:center;pointer-events:none;',
                    'box-shadow:0 4px 24px rgba(0,0,0,.6);',
                    'white-space:nowrap;direction:rtl;'
                ].join('');
                banner.innerHTML = '📵 وضع الأوفلاين — آخر بيانات محفوظة';
                document.body.appendChild(banner);
            }
            banner.style.display = 'flex';
        } else {
            if (banner) banner.style.display = 'none';
        }
    }

    /* ═══════════════════════════════════════════════════════
       مستمع: تحديث الطقس → تحديث الإشعار الدائم + حفظ أوفلاين
    ═══════════════════════════════════════════════════════ */
    window.addEventListener('wodWeatherUpdated', async function (e) {
        var d = e.detail || {};
        if (d.temp !== undefined) {
            await WodBridge.updateStickyNotif(d.temp, d.desc, d.city);
        }
        if (d.fullData) {
            var cityKey = window.currentCity || 'gps';
            await WodBridge.saveOfflineData(cityKey, d.fullData);
        }
    });

    /* ═══════════════════════════════════════════════════════
       مستمع: تغيير الشبكة
    ═══════════════════════════════════════════════════════ */
    window.addEventListener('wodNetworkChange', function (e) {
        _showOfflineBanner(!e.detail.connected);
    });

    /* ═══════════════════════════════════════════════════════
       تشغيل عند تحميل DOM
    ═══════════════════════════════════════════════════════ */
    document.addEventListener('DOMContentLoaded', async function () {

        // حقن شريط البحث + GPS
        _injectSearchBar();

        // تهيئة الجسر
        await WodBridge.init();

        /* إذا لم يختر المستخدم مدينة بعد → جرّب آخر موقع محفوظ */
        if (window._wodOnline !== false && _isNative()) {
            var Pref = _P('Preferences');
            if (Pref) {
                try {
                    var savedLoc = await Pref.get({ key: 'lastKnownLocation' });
                    if (savedLoc && savedLoc.value) {
                        var loc = JSON.parse(savedLoc.value);
                        /* استخدمه بصمت بدون طلب GPS جديد */
                        await _loadWeatherByCoords(loc.lat, loc.lon, loc.name || 'موقعك السابق');
                        // [FIX-6] استخدم الشارة الموجودة في التطبيق (#cityCurBadge) إذا كانت متاحة
                        var badge = document.getElementById('cityCurBadge')
                                 || document.getElementById('wodCityBadge');
                        _setCityBadge(badge, loc.name || 'موقعك');
                    }
                } catch (_) {}
            }
        }
    });

})(); /* نهاية IIFE */
