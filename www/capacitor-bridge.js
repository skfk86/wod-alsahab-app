/**
 * capacitor-bridge.js — طقس السودان v3.0
 * الجسر بين WebView وميزات Capacitor الأصيلة.
 *
 * المسار: www/capacitor-bridge.js
 */
(function () {
    'use strict';

    // ── ثوابت ────────────────────────────────────────────────────────────
    var GEOCODING_API   = 'https://geocoding-api.open-meteo.com/v1/search';
    var STICKY_ID       = 9001;
    var BG_WAKEUP_ID    = 9999;
    var CH_ALERTS       = 'weather_alerts';
    var CH_PERSISTENT   = 'weather_persistent';
    var CH_DAILY        = 'weather_daily';
    var NOTIF_TTL_MS    = 3 * 60 * 60 * 1000;   // مدة تذكر الإشعار المُرسل (3 ساعات)
    var FAV_OPS_KEY     = 'fav_ops_queue';       // قائمة عمليات المفضلة المعلقة
    var SYNC_DELAY_MS   = 900;                   // تأخير المزامنة بعد آخر تغيير

    // ── أدوات مساعدة ────────────────────────────────────────────────────

    function _isNative() {
        return (
            typeof window.Capacitor !== 'undefined' &&
            typeof window.Capacitor.Plugins !== 'undefined' &&
            window.Capacitor.isNativePlatform()
        );
    }

    function _sleep(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    async function _waitCapacitor(maxMs) {
        var step = 80, elapsed = 0;
        maxMs = maxMs || 6000;
        while (!_isNative() && elapsed < maxMs) {
            await _sleep(step);
            elapsed += step;
        }
        return _isNative();
    }

    function _P(name) {
        return window.Capacitor &&
               window.Capacitor.Plugins &&
               window.Capacitor.Plugins[name];
    }

    // ── safeLS: غلاف آمن لـ Capacitor Preferences ────────────────────────

    var _Pref = {
        async get(key) {
            var P = _P('Preferences');
            if (!P) return null;
            try {
                var r = await P.get({ key: key });
                return (r && r.value != null) ? r.value : null;
            } catch (_) { return null; }
        },
        async set(key, value) {
            var P = _P('Preferences');
            if (!P) return false;
            try { await P.set({ key: key, value: String(value) }); return true; }
            catch (_) { return false; }
        },
        async getJSON(key, fallback) {
            var v = await this.get(key);
            if (v === null) return fallback !== undefined ? fallback : null;
            try { return JSON.parse(v); } catch (_) { return fallback !== undefined ? fallback : null; }
        },
        async setJSON(key, value) {
            return await this.set(key, JSON.stringify(value));
        }
    };

    /* ════════════════════════════════════════════════════════════════════
       WodNotif — مدير الإشعارات المركزي (Singleton)
       المهمة الوحيدة: نقطة دخول واحدة لكل إشعار في التطبيق.
       يمنع التكرار عبر Deduplication Key محفوظ في Capacitor Preferences.
    ════════════════════════════════════════════════════════════════════ */
    var WodNotif = (function () {

        // تحقق من كون الإشعار أُرسل بالفعل خلال آخر 3 ساعات
        async function _isDuplicate(dedupId) {
            var sent = await _Pref.getJSON('notif_sent_ids', {});
            var ts   = sent && sent[dedupId];
            return ts && (Date.now() - ts) < NOTIF_TTL_MS;
        }

        // سجّل معرف الإشعار بعد إرساله
        async function _markSent(dedupId) {
            var sent = await _Pref.getJSON('notif_sent_ids', {});
            if (!sent) sent = {};
            sent[dedupId] = Date.now();

            // احذف السجلات القديمة لمنع تراكم البيانات
            var cutoff = Date.now() - NOTIF_TTL_MS * 2;
            Object.keys(sent).forEach(function (k) {
                if (sent[k] < cutoff) delete sent[k];
            });

            await _Pref.setJSON('notif_sent_ids', sent);
        }

        return {

            /**
             * send(dedupId, title, body, opts)
             *
             * @param {string}  dedupId - معرف فريد للحدث (مثل: "dust-storm-2026-04-23")
             * @param {string}  title
             * @param {string}  body
             * @param {object}  opts - { urgent, channelId, sticky, silent }
             */
            async send(dedupId, title, body, opts) {
                opts = opts || {};

                await _waitCapacitor(4000);
                var LN = _P('LocalNotifications');
                if (!LN) return null;

                // منع إرسال نفس الإشعار مرتين خلال 3 ساعات
                if (dedupId && !opts.forceResend) {
                    var dup = await _isDuplicate(dedupId);
                    if (dup) return null;
                }

                var notifId = opts.sticky
                    ? STICKY_ID
                    : (opts.id || (Math.floor(Math.random() * 7000) + 1000));

                var channelId = opts.channelId ||
                    (opts.sticky  ? CH_PERSISTENT :
                     opts.urgent  ? CH_ALERTS     : CH_DAILY);

                try {
                    await LN.schedule({
                        notifications: [{
                            id:         notifId,
                            title:      title,
                            body:       body,
                            channelId:  channelId,
                            ongoing:    !!opts.sticky,
                            autoCancel: !opts.sticky,
                            silent:     !!opts.silent,
                            smallIcon:  'ic_weather_notif',
                            iconColor:  opts.urgent ? '#ef4444' : '#f59e0b',
                            schedule:   { at: new Date(Date.now() + 300) },
                            extra: {
                                type:    opts.type || 'weather_alert',
                                dedupId: dedupId,
                                urgent:  !!opts.urgent
                            }
                        }]
                    });

                    if (dedupId) await _markSent(dedupId);
                    return notifId;

                } catch (e) {
                    return null;
                }
            },

            // تحديث الإشعار الدائم (درجة الحرارة في الشريط)
            async updateSticky(temp, desc, city) {
                city = city || 'السودان';
                desc = desc || '---';
                var title = '☁ طقس السودان — ' + city;
                var body  = Math.round(temp) + '°م  ·  ' + desc;

                return await this.send(
                    null, title, body,
                    { sticky: true, silent: true, forceResend: true }
                );
            },

            // تنبيه حرج (هبوب / عاصفة / حر شديد)
            async sendAlert(eventKey, title, body) {
                return await this.send(eventKey, title, body, { urgent: true });
            }
        };
    })();

    window.WodNotif = WodNotif;

    /* ════════════════════════════════════════════════════════════════════
       WodSync — مزامنة المفضلة بين localStorage و Firestore
       خوارزمية Three-Way Merge:
         - التغييرات المحلية (إضافة/حذف) تُخزَّن في قائمة عمليات (ops queue)
         - عند المزامنة: تُطبَّق العمليات على الحالة البعيدة
         - النتيجة: لا يُفقد تغيير من أي جهاز
    ════════════════════════════════════════════════════════════════════ */
    var WodSync = (function () {

        var _timer = null;

        // إضافة عملية للقائمة المعلقة
        function _pushOp(op, cityKey) {
            var queue = _readQueue();
            // ألغِ العملية المعاكسة إذا وجدت (add ثم del لنفس المدينة = لا شيء)
            var opposite = op === 'add' ? 'del' : 'add';
            var existingIdx = queue.findIndex(function (e) {
                return e.city === cityKey && e.op === opposite;
            });
            if (existingIdx !== -1) {
                queue.splice(existingIdx, 1);
            } else {
                queue.push({ op: op, city: cityKey, ts: Date.now() });
            }
            _writeQueue(queue);
        }

        function _readQueue() {
            try {
                return JSON.parse(localStorage.getItem(FAV_OPS_KEY) || '[]');
            } catch (_) { return []; }
        }

        function _writeQueue(queue) {
            try {
                localStorage.setItem(FAV_OPS_KEY, JSON.stringify(queue));
            } catch (_) {}
        }

        function _clearQueue() {
            try { localStorage.removeItem(FAV_OPS_KEY); } catch (_) {}
        }

        /**
         * syncFavoritesWithFirestore(uid)
         *
         * Three-Way Merge:
         *   1. اقرأ الحالة البعيدة (Firestore) ← base
         *   2. اقرأ العمليات المحلية المعلقة ← ops
         *   3. طبّق العمليات على base:
         *      - add: أضف المدينة إن لم تكن موجودة
         *      - del: احذف المدينة من النتيجة
         *   4. احفظ النتيجة في Firestore + localStorage + memory
         *
         * سيناريو جهازين:
         *   جهاز A حذف "kassala" → del op محفوظة
         *   جهاز B أضاف "nyala"  → add op محفوظة
         *   النتيجة عند مزامنة كليهما: يبقى nyala ويُحذف kassala ✓
         */
        async function syncFavoritesWithFirestore(uid) {
            if (!uid || !window._fbDB) return;

            var db  = window._fbDB;
            var ops = _readQueue();
            if (!ops.length) return;   // لا تغييرات محلية

            try {
                var { doc, runTransaction } = await import(
                    'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js'
                );

                var docRef = doc(db, 'users', uid);

                await runTransaction(db, async function (tx) {
                    var snap   = await tx.get(docRef);
                    var remote = (snap.exists() && snap.data().favCities)
                        ? snap.data().favCities
                        : [];

                    // deep copy لمنع الطفرة
                    var merged = remote.slice();

                    ops.forEach(function (op) {
                        if (op.op === 'add') {
                            if (merged.indexOf(op.city) === -1) {
                                merged.push(op.city);
                            }
                        } else if (op.op === 'del') {
                            var idx = merged.indexOf(op.city);
                            if (idx !== -1) merged.splice(idx, 1);
                        }
                    });

                    tx.set(docRef, { favCities: merged, updatedAt: Date.now() }, { merge: true });

                    // تحديث الذاكرة المحلية بعد النجاح
                    window.favorites = merged;
                    try {
                        localStorage.setItem('favCities', JSON.stringify(merged));
                    } catch (_) {}
                });

                _clearQueue();

            } catch (e) {
                // الشبكة غير متاحة — الـ ops تبقى في القائمة للمحاولة التالية
            }
        }

        // جدوِل مزامنة مع debounce (لا ترسل كل ضغطة)
        function scheduleSync(uid) {
            if (_timer) clearTimeout(_timer);
            _timer = setTimeout(function () {
                _timer = null;
                syncFavoritesWithFirestore(uid);
            }, SYNC_DELAY_MS);
        }

        return {
            pushAdd:     function (cityKey) { _pushOp('add', cityKey); },
            pushDel:     function (cityKey) { _pushOp('del', cityKey); },
            scheduleSync: scheduleSync,
            syncNow:     syncFavoritesWithFirestore
        };
    })();

    window.WodSync = WodSync;

    /* ════════════════════════════════════════════════════════════════════
       الجسر الرئيسي WodBridge
    ════════════════════════════════════════════════════════════════════ */
    window.WodBridge = {

        // 1. GPS
        getLocation: async function () {
            var ready = await _waitCapacitor();
            if (!ready) return _browserGeolocation();

            var Geo = _P('Geolocation');
            try {
                var perm = await Geo.requestPermissions({ permissions: ['location', 'coarseLocation'] });
                if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
                    throw new Error('رُفض إذن الموقع');
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

                await _Pref.setJSON('lastKnownLocation', result);
                return result;

            } catch (e) {
                // fallback: آخر موقع محفوظ
                var cached = await _Pref.getJSON('lastKnownLocation', null);
                if (cached) {
                    cached.fromCache = true;
                    cached.name = cached.name || 'آخر موقع معروف';
                    return cached;
                }
                throw e;
            }
        },

        // 2. بحث المدن
        searchCity: async function (query) {
            if (!query || query.trim().length < 2) return [];
            var local = _searchLocalCities(query);
            if (local.length >= 3) return local;

            try {
                var url = GEOCODING_API
                    + '?name=' + encodeURIComponent(query)
                    + '&count=8&language=ar&format=json';
                var res  = await fetch(url, {
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

                var names  = local.map(function (c) { return c.name; });
                var unique = remote.filter(function (c) { return names.indexOf(c.name) === -1; });
                return local.concat(unique).slice(0, 8);

            } catch (_) {
                return local;
            }
        },

        // 3. تنبيه طقس (يستخدم WodNotif داخلياً)
        scheduleWeatherAlert: async function (opts) {
            opts = opts || {};
            var dedupId = opts.dedupId ||
                ('alert-' + (opts.type || 'wx') + '-' + new Date().toDateString());
            return await WodNotif.send(
                dedupId,
                opts.title || 'تنبيه طقس السودان',
                opts.body  || '',
                { urgent: !!opts.urgent, channelId: opts.channelId }
            );
        },

        // 4. الإشعار الدائم
        updateStickyNotif: async function (temp, desc, city) {
            return await WodNotif.updateSticky(temp, desc, city);
        },

        // 5. حفظ بيانات الأوفلاين
        saveOfflineData: async function (cityKey, data) {
            await _Pref.setJSON('offline_wx_' + cityKey, {
                ts:   Date.now(),
                data: data
            });
        },

        // 6. قراءة بيانات الأوفلاين
        getOfflineData: async function (cityKey) {
            return await _Pref.getJSON('offline_wx_' + cityKey, null);
        },

        // تهيئة القنوات + مستمعات Capacitor
        init: async function () {
            if (window._capBridgeLoaded) return;
            window._capBridgeLoaded = true;

            var ready = await _waitCapacitor(8000);
            if (!ready) return;

            // إنشاء قنوات الإشعارات
            await _ensureChannels();

            // مستمع: تغيير الشبكة
            var Net = _P('Network');
            if (Net) {
                try {
                    var status = await Net.getStatus();
                    window._wodOnline = status.connected;
                    _showOfflineBanner(!status.connected);
                } catch (_) {}

                Net.addListener('networkStatusChange', function (s) {
                    window._wodOnline = s.connected;
                    _showOfflineBanner(!s.connected);
                    window.dispatchEvent(
                        new CustomEvent('wodNetworkChange', { detail: { connected: s.connected } })
                    );
                });
            }

            // مستمع: الإشعار الصامت من BackgroundRunner (id: 9999)
            var LN = _P('LocalNotifications');
            if (LN) {
                LN.addListener('localNotificationActionPerformed', function (ev) {
                    var notif = ev.notification || {};
                    var extra = notif.extra || {};

                    // إيقاظ من BackgroundRunner
                    if (notif.id === BG_WAKEUP_ID && extra.wakeup) {
                        _silentRefresh();
                        return;
                    }

                    // نقر على إشعار تنبيه → فتح التطبيق في الصدارة
                    if (typeof window.showMain === 'function') window.showMain();
                });
            }
        },

        refreshWeather: async function () {
            return await _silentRefresh();
        }
    };

    /* ════════════════════════════════════════════════════════════════════
       تحديث صامت (يُستدعى عند إيقاظ BackgroundRunner)
    ════════════════════════════════════════════════════════════════════ */
    async function _silentRefresh() {
        var city = window.currentCity || 'khartoum';
        var loc  = window.allCities && window.allCities[city];
        if (!loc) return;

        try {
            var url = 'https://api.open-meteo.com/v1/forecast'
                + '?latitude='  + loc.lat
                + '&longitude=' + loc.lon
                + '&current=temperature_2m,weather_code,wind_speed_10m'
                + '&wind_speed_unit=kmh'
                + '&timezone=Africa%2FKhartoum';

            var res  = await fetch(url, {
                signal: (typeof makeTimeout === 'function') ? makeTimeout(10000) : undefined
            });
            var data = await res.json();
            var cur  = data.current || {};
            var temp = cur.temperature_2m;
            var code = cur.weather_code || 0;
            var wind = cur.wind_speed_10m || 0;

            // تحديث الإشعار الدائم
            var desc = _wxDesc(code);
            await WodNotif.updateSticky(temp, desc, loc.name);

            // تنبيه إذا كانت الأحوال خطيرة
            if (_isAlertCondition(code, temp, wind)) {
                var eventKey = _alertKey(code, temp, wind, loc.name);
                await WodNotif.sendAlert(
                    eventKey,
                    _alertTitle(code, temp, wind),
                    _alertBody(code, temp, wind, loc.name)
                );
            }

            // أبلغ التطبيق بوجود بيانات جديدة
            window.dispatchEvent(new CustomEvent('wodBgRefresh', {
                detail: { temp: temp, desc: desc, city: loc.name, code: code, wind: wind }
            }));

            // إذا كان التطبيق مفتوحاً، حدّث الواجهة
            if (typeof window.loadWeather === 'function') {
                window.loadWeather(city, true);
            }

        } catch (_) {
            // الشبكة غير متاحة — لا شيء
        }
    }

    // ── دوال تصنيف الطقس ────────────────────────────────────────────────

    function _wxDesc(code) {
        if (code === 0)               return 'صحو';
        if (code <= 3)                return 'غيوم جزئية';
        if (code <= 49)               return 'ضباب';
        if (code <= 67)               return 'أمطار';
        if (code <= 77)               return 'ثلج';
        if (code <= 82)               return 'زخات مطر';
        if (code >= 95 && code <= 99) return 'عواصف رعدية';
        return 'متغير';
    }

    function _isAlertCondition(code, temp, wind) {
        return code >= 95 || temp > 45 || wind > 50;
    }

    function _alertKey(code, temp, wind, city) {
        // مفتاح حتمي يمنع تكرار نفس الحدث
        var type = code >= 95 ? 'storm' : temp > 45 ? 'heat' : 'wind';
        return type + '-' + (city || '').replace(/\s/g, '') + '-' + new Date().toDateString();
    }

    function _alertTitle(code, temp, wind) {
        if (code >= 95) return '⚡ تحذير: عواصف رعدية';
        if (temp > 45)  return '🌡 تحذير: موجة حر شديدة';
        if (wind > 50)  return '💨 تحذير: رياح شديدة / هبوب';
        return '⚠ تنبيه طقس';
    }

    function _alertBody(code, temp, wind, city) {
        if (code >= 95) return city + ': عواصف رعدية. ابتعد عن الأماكن المكشوفة.';
        if (temp > 45)  return city + ': درجة الحرارة ' + Math.round(temp) + '°م. تجنّب الشمس المباشرة.';
        if (wind > 50)  return city + ': رياح ' + Math.round(wind) + ' كم/س. هبوب محتمل.';
        return city + ': تنبيه طقس. افتح التطبيق للتفاصيل.';
    }

    /* ════════════════════════════════════════════════════════════════════
       قنوات الإشعارات
    ════════════════════════════════════════════════════════════════════ */
    async function _ensureChannels() {
        var LN = _P('LocalNotifications');
        if (!LN || !LN.createChannel) return;

        var channels = [
            {
                id:          CH_ALERTS,
                name:        'تنبيهات الطقس الخطيرة',
                description: 'هبوب وعواصف ترابية وتنبيهات جوية حرجة',
                importance:  5,
                vibration:   true,
                sound:       'default',
                lights:      true,
                lightColor:  '#f59e0b',
                visibility:  1
            },
            {
                id:          CH_PERSISTENT,
                name:        'حالة الطقس الحالية',
                description: 'درجة الحرارة الحالية في الشريط',
                importance:  2,
                vibration:   false,
                sound:       null,
                visibility:  1
            },
            {
                id:          CH_DAILY,
                name:        'تنبيهات الطقس اليومية',
                description: 'ملخص الطقس اليومي',
                importance:  3,
                vibration:   true,
                sound:       'default',
                visibility:  1
            }
        ];

        for (var ch of channels) {
            try { await LN.createChannel(ch); } catch (_) {}
        }
    }

    /* ════════════════════════════════════════════════════════════════════
       GPS في المتصفح (fallback عند عدم توفر Capacitor)
    ════════════════════════════════════════════════════════════════════ */
    function _browserGeolocation() {
        return new Promise(function (resolve, reject) {
            if (!navigator.geolocation) {
                reject(new Error('GPS غير مدعوم'));
                return;
            }
            navigator.geolocation.getCurrentPosition(
                function (pos) {
                    resolve({
                        lat:     pos.coords.latitude,
                        lon:     pos.coords.longitude,
                        name:    'موقعك الحالي',
                        fromGps: true
                    });
                },
                function (err) { reject(err); },
                { enableHighAccuracy: true, timeout: 10000 }
            );
        });
    }

    /* ════════════════════════════════════════════════════════════════════
       بحث المدن المحلية (قاموس allCities)
    ════════════════════════════════════════════════════════════════════ */
    function _searchLocalCities(q) {
        if (!window.allCities) return [];
        q = q.trim().toLowerCase();
        return Object.entries(window.allCities)
            .filter(function (pair) {
                var k = pair[0], c = pair[1];
                return c.name.includes(q) || k.toLowerCase().includes(q);
            })
            .map(function (pair) {
                return {
                    key:    pair[0],
                    name:   pair[1].name,
                    lat:    pair[1].lat,
                    lon:    pair[1].lon,
                    region: pair[1].region || '',
                    elev:   pair[1].elev   || 0
                };
            })
            .slice(0, 6);
    }

    /* ════════════════════════════════════════════════════════════════════
       شريط البحث + GPS (مُحقَن في الواجهة)
    ════════════════════════════════════════════════════════════════════ */
    function _injectSearchBar() {
        // لا تُحقن إذا كان شريط البحث الأصلي موجوداً
        if (document.getElementById('citySearchInput')) return;
        if (document.getElementById('wodSearchBar'))    return;

        var css = [
            '#wodSearchWrap{display:flex;align-items:center;gap:8px;padding:10px 15px;',
            'background:var(--bg-secondary,#1c1c1c);border-bottom:1px solid rgba(255,255,255,.1);}',
            '#wodSearchBar{flex:1;background:rgba(255,255,255,.07);border:1.5px solid rgba(255,255,255,.15);',
            'border-radius:12px;padding:10px 14px;color:#f1f5f9;font-size:.9rem;',
            "font-family:'Cairo','DM Sans',sans-serif;outline:none;direction:rtl;}",
            '#wodSearchBar:focus{border-color:#f59e0b;}',
            '#wodGpsBtn{background:rgba(245,158,11,.12);border:1.5px solid rgba(245,158,11,.35);',
            'border-radius:12px;width:42px;height:42px;display:flex;align-items:center;',
            'justify-content:center;cursor:pointer;font-size:1.1rem;transition:background .2s;}',
            '#wodGpsBtn:active{background:rgba(245,158,11,.3);}',
            '#wodSearchResults{position:absolute;right:0;left:0;top:calc(100% + 4px);',
            'background:var(--bg-card,#2a2a2a);border:1.5px solid rgba(255,255,255,.12);',
            'border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.7);',
            'z-index:9999;max-height:240px;overflow-y:auto;display:none;scrollbar-width:none;}',
            '#wodSearchResults.open{display:block;}',
            '.wod-sri{display:flex;align-items:center;gap:10px;padding:12px 16px;',
            'cursor:pointer;border-bottom:1px solid rgba(255,255,255,.06);direction:rtl;',
            'font-family:Cairo,sans-serif;font-size:.9rem;transition:background .15s;}',
            '.wod-sri:last-child{border-bottom:none;}',
            '.wod-sri:hover{background:rgba(245,158,11,.1);}',
            '.wod-reg{font-size:.74rem;color:rgba(241,245,249,.45);margin-right:auto;}',
            '#wodCityBadge{font-size:.75rem;color:#f59e0b;font-family:Cairo,sans-serif;',
            'pointer-events:none;white-space:nowrap;max-width:80px;',
            'overflow:hidden;text-overflow:ellipsis;display:none;}'
        ].join('');

        var style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);

        var wrap = document.createElement('div');
        wrap.id = 'wodSearchWrap';
        wrap.style.position = 'relative';

        var gpsBtn = document.createElement('button');
        gpsBtn.id = 'wodGpsBtn';
        gpsBtn.textContent = '📍';
        gpsBtn.setAttribute('aria-label', 'تحديد موقعي');

        var badge = document.createElement('span');
        badge.id = 'wodCityBadge';

        var searchWrapper = document.createElement('div');
        searchWrapper.style.cssText = 'position:relative;flex:1;';

        var searchBar = document.createElement('input');
        searchBar.id          = 'wodSearchBar';
        searchBar.type        = 'search';
        searchBar.placeholder = '🏙 ابحث عن مدينتك...';
        searchBar.autocomplete = 'off';
        searchBar.setAttribute('inputmode', 'search');

        var results = document.createElement('div');
        results.id = 'wodSearchResults';

        searchWrapper.appendChild(searchBar);
        searchWrapper.appendChild(badge);
        searchWrapper.appendChild(results);

        wrap.appendChild(gpsBtn);
        wrap.appendChild(searchWrapper);

        var header = document.querySelector('.header, .city-selector, #mainHeader');
        if (header && header.parentNode) {
            header.parentNode.insertBefore(wrap, header.nextSibling);
        } else {
            var first = document.body.firstChild;
            document.body.insertBefore(wrap, first);
        }

        _bindSearchBar(searchBar, results, gpsBtn, badge);
    }

    function _bindSearchBar(inp, results, gpsBtn, badge) {
        var debounce = null;

        inp.addEventListener('input', function () {
            clearTimeout(debounce);
            var q = inp.value.trim();
            if (!q) { results.classList.remove('open'); return; }
            debounce = setTimeout(async function () {
                var cities = await WodBridge.searchCity(q);
                _renderResults(cities, results);
            }, 250);
        });

        inp.addEventListener('blur', function () {
            setTimeout(function () { results.classList.remove('open'); }, 200);
        });

        gpsBtn.addEventListener('click', async function () {
            gpsBtn.textContent = '⏳';
            gpsBtn.disabled    = true;
            try {
                var loc = await WodBridge.getLocation();
                _setCityBadge(badge, loc.name);
                await _loadWeatherByCoords(loc.lat, loc.lon, loc.name);
                if (typeof window.showToast === 'function') {
                    window.showToast(loc.fromCache ? 'آخر موقع محفوظ' : 'تم تحديد موقعك ✓',
                                     loc.fromCache ? 'warn' : 'success');
                }
            } catch (_) {
                if (typeof window.showToast === 'function') {
                    window.showToast('تعذّر الموقع — تحقق من إذن GPS', 'error');
                }
            }
            gpsBtn.textContent = '📍';
            gpsBtn.disabled    = false;
        });
    }

    function _renderResults(cities, container) {
        container.innerHTML = '';
        if (!cities || !cities.length) {
            var empty = document.createElement('div');
            empty.className = 'wod-sri';
            empty.style.color = 'rgba(241,245,249,.4)';
            empty.style.justifyContent = 'center';
            empty.style.cursor = 'default';
            empty.textContent = 'لا توجد نتائج';
            container.appendChild(empty);
            container.classList.add('open');
            return;
        }

        cities.slice(0, 7).forEach(function (city) {
            var item = document.createElement('div');
            item.className = 'wod-sri';

            var icon = document.createElement('span');
            icon.textContent = '🏙';

            var nameEl = document.createElement('span');
            nameEl.textContent = city.name || '';

            item.appendChild(icon);
            item.appendChild(nameEl);

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

    window.WodBridge._pick = async function (lat, lon, name, key) {
        var results   = document.getElementById('wodSearchResults');
        var searchBar = document.getElementById('wodSearchBar');
        var badge     = document.getElementById('wodCityBadge')
                     || document.getElementById('cityCurBadge');

        if (results)   results.classList.remove('open');
        if (searchBar) searchBar.value = name;
        _setCityBadge(badge, name);
        await _loadWeatherByCoords(lat, lon, name, key);
    };

    async function _loadWeatherByCoords(lat, lon, name, key) {
        window._currentCityCoords = { lat: lat, lon: lon, name: name, key: key };

        if (key && window.allCities && window.allCities[key]) {
            window.currentCity = key;
            if (typeof selectCityFromDropdown === 'function') {
                selectCityFromDropdown(key); return;
            }
            if (typeof changeCity === 'function') {
                changeCity(key); return;
            }
        }

        if (window.allCities) {
            window.allCities['gps'] = { name: name || 'موقعك', lat: lat, lon: lon, elev: 0, region: 'GPS' };
        }
        window.currentCity = 'gps';

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

    function _setCityBadge(badge, name) {
        if (!badge) return;
        badge.textContent = name;
        badge.style.display = 'block';
        setTimeout(function () { badge.style.opacity = '.7'; }, 5000);
    }

    function _showOfflineBanner(show) {
        var banner = document.getElementById('wodOfflineBanner');
        if (show) {
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'wodOfflineBanner';
                banner.style.cssText = [
                    'position:fixed;bottom:72px;left:50%;',
                    'transform:translateX(-50%);',
                    'background:#1e293b;border:1.5px solid #475569;',
                    'border-radius:20px;padding:8px 18px;',
                    'color:#94a3b8;font-size:.82rem;',
                    "font-family:'Cairo',sans-serif;",
                    'z-index:9990;display:flex;gap:8px;',
                    'align-items:center;pointer-events:none;',
                    'box-shadow:0 4px 24px rgba(0,0,0,.6);',
                    'white-space:nowrap;direction:rtl;'
                ].join('');
                banner.textContent = '📵 وضع الأوفلاين — آخر بيانات محفوظة';
                document.body.appendChild(banner);
            }
            banner.style.display = 'flex';
        } else {
            if (banner) banner.style.display = 'none';
        }
    }

    // ── مستمعات الأحداث ──────────────────────────────────────────────────

    window.addEventListener('wodWeatherUpdated', async function (e) {
        var d = e.detail || {};
        if (d.temp !== undefined) {
            await WodBridge.updateStickyNotif(d.temp, d.desc, d.city);
        }
        if (d.fullData) {
            await WodBridge.saveOfflineData(window.currentCity || 'gps', d.fullData);
        }
    });

    window.addEventListener('wodNetworkChange', function (e) {
        _showOfflineBanner(!e.detail.connected);
    });

    // ── تهيئة عند تحميل DOM ──────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', async function () {
        _injectSearchBar();
        await WodBridge.init();

        if (window._wodOnline !== false && _isNative()) {
            var cached = await _Pref.getJSON('lastKnownLocation', null);
            if (cached) {
                await _loadWeatherByCoords(cached.lat, cached.lon, cached.name || 'موقعك السابق');
                var badge = document.getElementById('cityCurBadge')
                         || document.getElementById('wodCityBadge');
                _setCityBadge(badge, cached.name || 'موقعك');
            }
        }
    });

})();
