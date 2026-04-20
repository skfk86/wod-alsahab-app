/**
 * ══════════════════════════════════════════════════════════════════════
 *  capacitor-bridge.js  — طبقة تكامل Capacitor
 *  تطبيق "ود السحاب - طقس السودان"
 *  الإصدار: 5.0.0  (Production-Hardened)
 *
 *  المشاكل الحرجة المُصلَحة في هذا الإصدار:
 *
 *  PROD-1: إشعار مزدوج للعاصفة الترابية
 *    السبب: applySmartEngines تستدعي applyWindForecastToUI ثم _showDustStormAlert
 *           → Hook 3 + Hook 1 يُطلقان معاً = إشعاران لنفس الحدث
 *    الحل: إزالة 'dust-storm' و'downburst' من NOTIF_SCENARIOS في Hook 3
 *          لأن Hook 1 و Hook 4 يتكفّلان بهما
 *
 *  PROD-2: إشعار يُرسل كل 5 دقائق طالما التنبيه ظاهر
 *    السبب: _orig.apply() تعود (return) مبكراً إذا التنبيه موجود،
 *           لكن الكود الذي بعدها في الـ hook ينفَّذ على أي حال
 *    الحل: cooldown مستقل لكل hook لا يعتمد على سلوك الأصلي

 *  PROD-3: Hook 6 يتجاوز حارس nearRainAlerted
 *    السبب: nearRainAlerted متغير closure خاص لا يمكن الوصول إليه
 *           فالـ hook يرسل إشعاراً في كل استدعاء عندما maxProb>=60
 *    الحل: cooldown مستقل 30 دقيقة للمطر
 *
 *  PROD-4: toggleWindAlerts تُشغّل Hook 3 بشكل خاطئ
 *    السبب: toggleWindAlerts تستدعي applyWindForecastToUI(_lastWindResult)
 *           → إشعار عند تغيير الإعداد فقط
 *    الحل: فحص window._windAlertsEnabled داخل Hook 3
 *
 *  الحمايات الإضافية:
 *    - حارس تطبيق مزدوج (idempotent hooks)
 *    - فحص readyState لـ DOMContentLoaded / load
 *    - حارس interval للـ backup الدوري
 *    - _windNotifLast على مستوى الـ module لا داخل _hookAlerts
 * ══════════════════════════════════════════════════════════════════════
 */

(function (win, doc) {
    'use strict';

    // ═══════════════════════════════════════════════════════════════════
    // §0  حارس التطبيق المزدوج (Idempotency Guard)
    //     يمنع تطبيق الـ hooks مرتين إذا حُمّل الملف مرتين
    // ═══════════════════════════════════════════════════════════════════

    if (win._capBridgeLoaded) {
        _logGlobal('⚠️ capacitor-bridge: تم تحميله مسبقاً — تجاهل التحميل المكرر');
        return;
    }
    win._capBridgeLoaded = true;

    // ═══════════════════════════════════════════════════════════════════
    // §1  اكتشاف البيئة
    // ═══════════════════════════════════════════════════════════════════

    const IS_CAP = !!(
        win.Capacitor &&
        win.Capacitor.isNativePlatform &&
        win.Capacitor.isNativePlatform()
    );

    const plug = (name) => win.Capacitor?.Plugins?.[name] ?? null;

    win._isCapacitorNative = IS_CAP;
    _log('بيئة التشغيل:', IS_CAP ? '✅ أندرويد أصيل' : '🌐 متصفح ويب');

    // ═══════════════════════════════════════════════════════════════════
    // §2  checkPermissions
    // ═══════════════════════════════════════════════════════════════════

    win.checkPermissions = async function () {
        if (!IS_CAP) return { location: 'browser', notifications: 'browser' };
        const result = { location: 'unknown', notifications: 'unknown' };

        try {
            const geo = plug('Geolocation');
            if (geo) {
                const cur = await geo.checkPermissions();
                const st  = cur.location ?? cur.coarseLocation ?? 'prompt';
                result.location = (st === 'prompt' || st === 'prompt-with-rationale')
                    ? (await geo.requestPermissions({ permissions: ['location'] })).location ?? 'denied'
                    : st;
                _log('صلاحية الموقع:', result.location);
            }
        } catch (e) { _warn('geo perm:', e.message); result.location = 'error'; }

        try {
            const notif = plug('LocalNotifications');
            if (notif) {
                const cur = await notif.checkPermissions();
                const st  = cur.display ?? 'prompt';
                result.notifications = (st === 'prompt' || st === 'prompt-with-rationale')
                    ? (await notif.requestPermissions()).display ?? 'denied'
                    : st;
                _log('صلاحية الإشعارات:', result.notifications);
                if (result.notifications === 'granted') await _createChannels(notif);
            }
        } catch (e) { _warn('notif perm:', e.message); result.notifications = 'error'; }

        win._capPermissions = result;
        return result;
    };

    async function _createChannels(notif) {
        const chs = [
            { id: 'wx_emergency', name: 'تحذيرات طارئة',  importance: 5, vibration: true,  lights: true, lightColor: '#ef4444' },
            { id: 'wx_alerts',    name: 'تنبيهات الطقس',   importance: 4, vibration: true,  lights: true, lightColor: '#f59e0b' },
            { id: 'wx_info',      name: 'معلومات الطقس',   importance: 3, vibration: false, lights: false },
        ];
        for (const ch of chs) {
            try { await notif.createChannel({ ...ch, sound: 'default' }); } catch (_) {}
        }
        _log('✅ قنوات الإشعارات جاهزة');
    }

    // ═══════════════════════════════════════════════════════════════════
    // §3  Geolocation — استبدال navigator.geolocation بـ Capacitor
    // ═══════════════════════════════════════════════════════════════════

    if (IS_CAP) {
        const _capGeo = plug('Geolocation');
        if (_capGeo) {
            try {
                Object.defineProperty(navigator, 'geolocation', {
                    configurable: true, enumerable: true,
                    value: {
                        getCurrentPosition(ok, err, opts) {
                            _capGeo.getCurrentPosition({
                                enableHighAccuracy: opts?.enableHighAccuracy ?? true,
                                timeout:            opts?.timeout            ?? 12000,
                                maximumAge:         opts?.maximumAge         ?? 0,
                            })
                            .then(p  => ok(_w3c(p)))
                            .catch(e => { if (err) err({ code: e.code ?? 2, message: e.message }); });
                        },
                        watchPosition(ok, err, opts) {
                            let ref = null;
                            // حالة: clearWatch قد تُستدعى قبل حل الـ Promise
                            let clearRequested = false;
                            _capGeo.watchPosition(opts ?? {}, (p, e) => {
                                if (e) { if (err) err(e); return; }
                                ok(_w3c(p));
                            }).then(id => {
                                ref = id;
                                // إذا طُلب الإلغاء قبل حل الـ Promise، ننفّذه الآن
                                if (clearRequested) _capGeo.clearWatch({ id: ref });
                            });
                            return {
                                _cap:  true,
                                _ref:  () => ref,
                                _kill: () => { clearRequested = true; },
                            };
                        },
                        clearWatch(h) {
                            try {
                                if (h?._ref) {
                                    const id = h._ref();
                                    if (id != null) { _capGeo.clearWatch({ id }); }
                                    else { h._kill?.(); } // طلب الإلغاء المؤجل
                                } else {
                                    _capGeo.clearWatch({ id: h });
                                }
                            } catch (_) {}
                        },
                    },
                });
                _log('✅ navigator.geolocation → Capacitor Native');
            } catch (e) { _warn('geolocation override failed:', e.message); }
        }
    }

    function _w3c(p) {
        return {
            coords: {
                latitude: p.coords.latitude, longitude: p.coords.longitude,
                accuracy: p.coords.accuracy ?? 50, altitude: p.coords.altitude ?? null,
                altitudeAccuracy: p.coords.altitudeAccuracy ?? null,
                heading: p.coords.heading ?? null, speed: p.coords.speed ?? null,
            },
            timestamp: p.timestamp ?? Date.now(),
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    // §4  Capacitor Preferences
    // ═══════════════════════════════════════════════════════════════════

    const CRITICAL_KEYS = [
        'appSettings','favCities','currentCity','selectedCity',
        'userName','appTheme','iconStyle','windAlerts',
        'cumulusAlerts','onboardingComplete','lastFBSync',
    ];

    win.CapPrefs = {
        async set(key, value) {
            const s = typeof value === 'string' ? value : JSON.stringify(value);
            try { localStorage.setItem(key, s); } catch (_) {}
            if (!IS_CAP) return;
            const p = plug('Preferences');
            if (p) try { await p.set({ key, value: s }); } catch (_) {}
        },
        async get(key) {
            if (!IS_CAP) return localStorage.getItem(key);
            const p = plug('Preferences');
            if (p) try {
                const r = await p.get({ key });
                if (r.value != null) {
                    try { localStorage.setItem(key, r.value); } catch (_) {}
                    return r.value;
                }
            } catch (_) {}
            return localStorage.getItem(key);
        },
        async backupCriticalKeys() {
            if (!IS_CAP) return;
            const p = plug('Preferences');
            if (!p) return;
            for (const k of CRITICAL_KEYS) {
                const v = localStorage.getItem(k);
                if (v != null) try { await p.set({ key: k, value: v }); } catch (_) {}
            }
        },
        async restoreOnFirstLaunch() {
            if (!IS_CAP || localStorage.getItem('appSettings') !== null) return;
            const p = plug('Preferences');
            if (!p) return;
            for (const k of CRITICAL_KEYS) {
                try {
                    const r = await p.get({ key: k });
                    if (r.value != null) localStorage.setItem(k, r.value);
                } catch (_) {}
            }
        },
    };

    // ═══════════════════════════════════════════════════════════════════
    // §5  نواة الإشعارات — _fire()
    // ═══════════════════════════════════════════════════════════════════

    let _nid = (Date.now() % 100000) + 1;   // يبدأ من رقم صغير آمن < 2^31
    const _nextId = () => (_nid = (_nid % 2000000000) + 1);

    async function _fire({ title, body, channel = 'wx_alerts', iconColor = '#f59e0b', vibrate = null }) {
        if (!IS_CAP) {
            // المتصفح — للاختبار فقط
            if ('Notification' in win) {
                const g = Notification.permission === 'granted'
                    ? 'granted'
                    : (Notification.permission !== 'denied' ? await Notification.requestPermission() : 'denied');
                if (g === 'granted') new Notification(title, { body });
            }
            return;
        }
        const notif = plug('LocalNotifications');
        if (!notif) return;
        try {
            const perm = await notif.checkPermissions();
            if (perm.display !== 'granted') return;
            const payload = {
                id: _nextId(), title, body, channelId: channel,
                smallIcon: 'ic_weather_notif', iconColor, sound: 'default',
                actionTypeId: 'OPEN_APP',
            };
            if (vibrate) payload.vibrate = vibrate;
            await notif.schedule({ notifications: [payload] });
        } catch (e) { _warn('_fire:', e.message); }
    }

    // ═══════════════════════════════════════════════════════════════════
    // §6  أدوات مساعدة
    // ═══════════════════════════════════════════════════════════════════

    // تجريد وسوم HTML — نصوص _showCbSmartCard تحتوي <strong> و <br>
    function _stripHtml(str) {
        return (str ?? '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .trim();
    }

    // قاموس: windScenario → قناة الإشعار
    function _scenarioChannel(sc) {
        return ['downburst', 'dust-storm'].includes(sc) ? 'wx_emergency' : 'wx_alerts';
    }

    // قاموس: windScenario → لون الأيقونة
    const _SCENARIO_COLOR = {
        'downburst': '#8b5cf6', 'dust-storm': '#ef4444',
        'strong-wind': '#f97316', 'blowing-dust': '#f59e0b',
        'muggy': '#eab308', 'dense-dust-haze': '#b45309', 'dust-haze': '#60a5fa',
    };

    // قاموس: windScenario → نمط الاهتزاز
    const _SCENARIO_VIBRATE = {
        'downburst':  [0, 400, 200, 400, 200, 400],
        'dust-storm': [0, 300, 150, 300, 150, 300],
    };

    // ═══════════════════════════════════════════════════════════════════
    // §7  مخازن الـ Cooldowns (على مستوى الـ module لأمان الـ scope)
    //
    //  كل hook له cooldown مستقل بالكامل.
    //  لا يعتمد على سلوك الأصلي (return مبكر) — الأصلي قد يعود بصمت
    //  لكن كودنا بعد .apply() ينفَّذ على أي حال [PROD-2].
    // ═══════════════════════════════════════════════════════════════════

    const _CD = {
        dustStorm:   { last: 0, ms: 15 * 60 * 1000 }, // 15 دقيقة
        ati:         { last: 0, ms: 10 * 60 * 1000 }, // 10 دقائق — يُعاد تعيينه بـ r.id
        atiLastId:   '',
        downburst:   { last: 0, ms: 10 * 60 * 1000 }, // 10 دقائق
        cb:          { last: 0, ms: 15 * 60 * 1000 }, // 15 دقيقة — يُعاد تعيينه بـ type+title
        cbLastKey:   '',
        rain:        { last: 0, ms: 30 * 60 * 1000 }, // 30 دقيقة [PROD-3]
        wind:        {},                                 // مفتاح per-scenario
        WIND_MS:     10 * 60 * 1000,
    };

    function _cooldownOk(cd) {
        const now = Date.now();
        if (now - cd.last < cd.ms) return false;
        cd.last = now;
        return true;
    }

    // ═══════════════════════════════════════════════════════════════════
    // §8  الـ HOOKS
    //
    //  ┌──────────────────────────────────────────────────────────────────┐
    //  │ Hook 1 — _showDustStormAlert(aqiR, visR, alertType)             │
    //  │ Hook 2 — _showATIAlert(r)                                       │
    //  │ Hook 3 — applyWindForecastToUI(r)  → r.smartAlert               │
    //  │          [PROD-1] 'dust-storm'/'downburst' مُستثنَيان            │
    //  │          [PROD-4] فحص _windAlertsEnabled                        │
    //  │ Hook 4 — _showDownburstAlert(windR)                             │
    //  │ Hook 5 — _showCbSmartCard(type, content, options)               │
    //  │ Hook 6 — checkNearRainAlert(rainProbs)  [PROD-3] cooldown 30min │
    //  └──────────────────────────────────────────────────────────────────┘
    // ═══════════════════════════════════════════════════════════════════

    function _hookAlerts() {

        // ── حارس التطبيق المزدوج ──────────────────────────────────────
        if (win._capBridgeHooked) {
            _log('Hooks مُطبَّقة مسبقاً — تخطي');
            return;
        }
        win._capBridgeHooked = true;

        let hooked = 0;

        // ──────────────────────────────────────────────────────────────
        // Hook 1 — عاصفة ترابية / هبوب
        // _showDustStormAlert(aqiR, visR, alertType)
        //
        // Cooldown 15 دقيقة (مستقل تماماً — لا يعتمد على وجود الـ div)
        // ──────────────────────────────────────────────────────────────

        const _orig1 = win._showDustStormAlert;
        if (typeof _orig1 === 'function') {
            win._showDustStormAlert = function (aqiR, visR, alertType) {
                _orig1.apply(this, arguments);           // الأصلي أولاً

                if (!_cooldownOk(_CD.dustStorm)) return; // [PROD-2]

                const title = alertType === 'haboob'
                    ? (win._adminMessages?.haboob || win._adminMessages?.dustStorm || 'هبوب وعاصفة رملية')
                    : (win._adminMessages?.dustStorm || 'عاصفة ترابية خطيرة');

                const body = 'رؤية: '   + (visR?.displayText ?? '—')
                           + ' · AQI: '  + (aqiR?.aqi         ?? '—')
                           + ' — '       + (aqiR?.category     ?? '')
                           + '\nابقَ في المنزل، أغلق النوافذ تماماً.';

                _fire({ title: '🚨 ' + title, body,
                        channel: 'wx_emergency', iconColor: '#ef4444',
                        vibrate: [0, 300, 150, 300, 150, 300] });
            };
            hooked++;
            _log('✅ Hook 1: _showDustStormAlert');
        } else { _warn('Hook 1: _showDustStormAlert غير موجودة'); }

        // ──────────────────────────────────────────────────────────────
        // Hook 2 — مؤشر الاضطراب الجوي ATI
        // _showATIAlert(r)
        //
        // Cooldown 10 دقائق — يُعاد تعيين العداد إذا تغيّر r.id
        // (حالة جديدة تستحق إشعاراً حتى قبل انتهاء cooldown الحالة السابقة)
        // ──────────────────────────────────────────────────────────────

        const _orig2 = win._showATIAlert;
        if (typeof _orig2 === 'function') {
            win._showATIAlert = function (r) {
                _orig2.apply(this, arguments);

                if (!r || r.id === 'freshAir') return;

                // حالة جديدة → أعد تعيين الـ cooldown [PROD-2]
                if (r.id !== _CD.atiLastId) {
                    _CD.atiLastId = r.id;
                    _CD.ati.last = 0;
                }
                if (!_cooldownOk(_CD.ati)) return;

                const title = ((r.icon ?? '') + ' ' + (r.title   ?? '')).trim();
                const body  = ((r.message ?? '') + (r.ati ? '\nATI: ' + r.ati : '')).trim();

                _fire({ title, body, channel: 'wx_emergency',
                        iconColor: r.color ?? '#f97316', vibrate: [0, 200, 100, 200] });
            };
            hooked++;
            _log('✅ Hook 2: _showATIAlert');
        } else { _warn('Hook 2: _showATIAlert غير موجودة'); }

        // ──────────────────────────────────────────────────────────────
        // Hook 3 — رياح / غبار عالق / كتمة حارة
        // applyWindForecastToUI(r) → r.smartAlert
        //
        // [PROD-1] 'dust-storm' و'downburst' مُستثنَيان:
        //          Hook 1 و Hook 4 يتكفّلان بهما — لو أبقيناهما هنا
        //          ستُرسَل إشعارَين لنفس الحدث في نفس الثانية
        //
        // [PROD-4] فحص _windAlertsEnabled:
        //          toggleWindAlerts() تستدعي applyWindForecastToUI(_lastWindResult)
        //          بعد تغيير الإعداد مباشرةً — لا نريد إشعاراً عند ذلك
        //
        // Cooldown 10 دقائق per-scenario
        // ──────────────────────────────────────────────────────────────

        // السيناريوهات التي تُطلق Hook 3 فقط (بدون dust-storm وdownburst)
        const WIND_NOTIF_SCENARIOS = new Set([
            'strong-wind', 'blowing-dust', 'muggy', 'dense-dust-haze', 'dust-haze',
        ]);

        const _origWind = win.applyWindForecastToUI;
        if (typeof _origWind === 'function') {
            win.applyWindForecastToUI = function (r) {
                _origWind.apply(this, arguments);

                // [PROD-4] لا إشعار إذا كانت تنبيهات الرياح مُعطَّلة
                if (!win._windAlertsEnabled) return;

                const sc        = r?.windScenario;
                const alertText = r?.smartAlert;

                if (!alertText || !sc || !WIND_NOTIF_SCENARIOS.has(sc)) return;

                // Cooldown per-scenario [PROD-2]
                const now = Date.now();
                if (now - (_CD.wind[sc] ?? 0) < _CD.WIND_MS) return;
                _CD.wind[sc] = now;

                // العنوان = أول جملة (قبل ' — ' أو ' – ')
                const sep   = alertText.search(/ [—–] /);
                const title = sep > 0 ? alertText.slice(0, sep).trim() : alertText.trim();

                _fire({
                    title,
                    body:      alertText.trim(),
                    channel:   _scenarioChannel(sc),
                    iconColor: _SCENARIO_COLOR[sc] ?? '#f59e0b',
                    vibrate:   _SCENARIO_VIBRATE[sc] ?? null,
                });
            };
            hooked++;
            _log('✅ Hook 3: applyWindForecastToUI (بدون dust-storm/downburst)');
        } else { _warn('Hook 3: applyWindForecastToUI غير موجودة'); }

        // ──────────────────────────────────────────────────────────────
        // Hook 4 — رياح هابطة (Downburst) — الحالة الأخطر
        // _showDownburstAlert(windR)
        //
        // مصدر النص (السطر ~17989):
        //   title = 'رياح هابطة مفاجئة — خطر فوري'
        //   body  = 'هبات windR.windGusts كم/س (ضعف windR.rawSpeed كم/س)
        //            \nابتعد عن الأشجار والمنشآت غير المثبّتة فوراً.'
        //
        // Cooldown 10 دقائق
        // ──────────────────────────────────────────────────────────────

        const _orig4 = win._showDownburstAlert;
        if (typeof _orig4 === 'function') {
            win._showDownburstAlert = function (windR) {
                _orig4.apply(this, arguments);

                if (!_cooldownOk(_CD.downburst)) return; // [PROD-2]

                const body = 'هبات '        + (windR?.windGusts ?? '?') + ' كم/س'
                           + ' (ضعف الرياح المستمرة ' + (windR?.rawSpeed ?? '?') + ' كم/س)'
                           + '\nابتعد عن الأشجار والمنشآت غير المثبّتة فوراً.';

                _fire({
                    title:     '⬇️⚡ رياح هابطة مفاجئة — خطر فوري',
                    body,
                    channel:   'wx_emergency',
                    iconColor: '#8b5cf6',
                    vibrate:   [0, 400, 200, 400, 200, 400],
                });
            };
            hooked++;
            _log('✅ Hook 4: _showDownburstAlert');
        } else { _warn('Hook 4: _showDownburstAlert غير موجودة'); }

        // ──────────────────────────────────────────────────────────────
        // Hook 5 — سحب ركامية مزنية (Cb)
        // _showCbSmartCard(type, content, options)
        //
        // content = { title, body, factors, severity }
        //   body: قد يحتوي HTML → نُجرّده بـ _stripHtml()
        //
        // Cooldown 15 دقيقة — يُعاد تعيينه إذا تغيّر type+title
        // (حدث جديد = إشعار جديد)
        // ──────────────────────────────────────────────────────────────

        const _orig5 = win._showCbSmartCard;
        if (typeof _orig5 === 'function') {
            win._showCbSmartCard = function (type, content, options) {
                _orig5.apply(this, arguments);

                const cbKey = type + '|' + (content?.title ?? '');
                // نوع أو عنوان جديد → أعد تعيين الـ cooldown [PROD-2]
                if (cbKey !== _CD.cbLastKey) {
                    _CD.cbLastKey = cbKey;
                    _CD.cb.last = 0;
                }
                if (!_cooldownOk(_CD.cb)) return;

                const icon  = type === 'pre' ? '⚠️' : type === 'microburst' ? '🚨' : '🌩️';
                const title = (icon + ' ' + _stripHtml(content?.title ?? '')).trim();
                const body  = (
                    _stripHtml(content?.body ?? '') +
                    (content?.factors ? '\n' + _stripHtml(content.factors) : '')
                ).trim();

                const isCritical = type === 'microburst' || type === 'post'
                    || content?.severity === 'severe' || content?.severity === 'high';

                _fire({
                    title, body,
                    channel:   isCritical ? 'wx_emergency' : 'wx_alerts',
                    iconColor: type === 'pre' ? '#fb923c' : type === 'microburst' ? '#ef4444' : '#c084fc',
                    vibrate:   isCritical ? [0, 400, 200, 400] : null,
                });
            };
            hooked++;
            _log('✅ Hook 5: _showCbSmartCard');
        } else { _warn('Hook 5: _showCbSmartCard غير موجودة'); }

        // ──────────────────────────────────────────────────────────────
        // Hook 6 — مطر قريب
        // checkNearRainAlert(rainProbs)
        //
        // [PROD-3] nearRainAlerted هو closure خاص لا نصل إليه.
        //          بدونه سيُرسَل إشعار في كل استدعاء (كل تحميل للبيانات).
        //          Cooldown 30 دقيقة مستقل يعوض هذا.
        //
        // مصدر النص (السطر ~9041):
        //   title = maxProb>=80 ? '⚠️ مطر قريب جداً!' : '🌧️ فرصة مطر قريبة'
        //   body  = 'احتمال X% خلال ساعة/ساعتين'
        // ──────────────────────────────────────────────────────────────

        const _orig6 = win.checkNearRainAlert;
        if (typeof _orig6 === 'function') {
            win.checkNearRainAlert = function (rainProbs) {
                _orig6.apply(this, arguments);

                if (!rainProbs?.length) return;
                const next2h  = rainProbs.slice(0, 2);
                const maxProb = Math.max(...next2h);
                if (maxProb < 60) return;

                if (!_cooldownOk(_CD.rain)) return; // [PROD-3]

                const hourIdx = next2h.indexOf(maxProb);
                const title   = maxProb >= 80 ? '⚠️ مطر قريب جداً!' : '🌧️ فرصة مطر قريبة';
                const body    = 'احتمال ' + maxProb + '% خلال '
                              + (hourIdx === 0 ? 'ساعة' : 'ساعتين');

                _fire({ title, body, channel: 'wx_alerts', iconColor: '#3b82f6' });
            };
            hooked++;
            _log('✅ Hook 6: checkNearRainAlert');
        } else { _warn('Hook 6: checkNearRainAlert غير موجودة'); }

        _log(`✅ Hooks مفعَّلة: ${hooked}/6`);

        // إذا لم تُطبَّق جميع الـ Hooks → حاول مرة أخرى بعد ثانيتين
        // (يحمي من الأجهزة البطيئة التي تحمّل الكود بعد 3.5 ثانية)
        if (hooked < 6) {
            _warn(`⚠️ ${6 - hooked} Hooks لم تُطبَّق — إعادة المحاولة بعد 2 ثانية`);
            win._capBridgeHooked = false; // السماح بإعادة التطبيق
            setTimeout(_hookAlerts, 2000);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // §9  App Lifecycle — Pause / Resume
    // ═══════════════════════════════════════════════════════════════════

    if (IS_CAP) {
        let _lastFG = Date.now();

        doc.addEventListener('pause', function () {
            _lastFG = Date.now();
            win.CapPrefs.backupCriticalKeys();
        }, false);

        doc.addEventListener('resume', function () {
            // إعادة تعيين cooldowns العاصفة عند العودة
            // (الحدث الذي أشعل التنبيه قد ينتهي بينما التطبيق في الخلفية)
            if (Date.now() - _lastFG > 10 * 60 * 1000) {
                _CD.dustStorm.last = 0;
                _CD.downburst.last = 0;
                _CD.ati.last       = 0;
                _CD.cb.last        = 0;
                Object.keys(_CD.wind).forEach(k => { _CD.wind[k] = 0; });
                _log('cooldowns أُعيدت بعد غياب طويل');
            }

            // تحديث تلقائي للطقس إذا مضى أكثر من 5 دقائق
            if (Date.now() - _lastFG > 5 * 60 * 1000) {
                win._lastWeatherLoad = 0;
                setTimeout(function () {
                    try { if (typeof win.loadWeather === 'function') win.loadWeather(); } catch (_) {}
                }, 600);
            }
        }, false);
    }

    // ═══════════════════════════════════════════════════════════════════
    // §10  التهيئة
    //      [حماية] فحص readyState في حال حُمّل البريدج بعد الـ events
    // ═══════════════════════════════════════════════════════════════════

    async function _onDOMReady() {
        await win.CapPrefs.restoreOnFirstLaunch();

        if (IS_CAP) {
            setTimeout(async function () {
                const perms = await win.checkPermissions();
                _log('الصلاحيات:', JSON.stringify(perms));
            }, 2000);

            // backup أولي + دوري — مع حارس لمنع تكرار الـ interval
            setTimeout(function () { win.CapPrefs.backupCriticalKeys(); }, 8000);
            if (!win._capBridgeBackupIv) {
                win._capBridgeBackupIv = setInterval(function () {
                    win.CapPrefs.backupCriticalKeys();
                }, 5 * 60 * 1000);
            }
        }
    }

    function _onFullLoad() {
        // أول محاولة بعد 3.5 ثانية
        // إذا لم تُطبَّق كل الـ hooks → _hookAlerts تُعيد المحاولة تلقائياً
        setTimeout(_hookAlerts, 3500);
    }

    // [حماية readyState] — DOMContentLoaded
    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', _onDOMReady);
    } else {
        _onDOMReady();
    }

    // [حماية readyState] — load
    if (doc.readyState !== 'complete') {
        win.addEventListener('load', _onFullLoad);
    } else {
        // الصفحة محمّلة بالفعل → نطبّق الـ Hooks بعد tick واحد
        setTimeout(_onFullLoad, 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    // §11  Logging
    // ═══════════════════════════════════════════════════════════════════

    function _log(...a)  { console.log ('[CapBridge]', ...a); }
    function _warn(...a) { console.warn('[CapBridge]', ...a); }

    _log('✅ capacitor-bridge.js v5.0.0 (Production-Hardened) جاهز');

}(window, document));

// دالة مساعدة خارج الـ IIFE — للاستدعاء قبل تهيئة _log
function _logGlobal(...a) { console.log('[CapBridge]', ...a); }
