(function (win, doc) {
    'use strict';

    if (win._capBridgeLoaded) {
        return;
    }
    win._capBridgeLoaded = true;

    const IS_CAP = !!(
        win.Capacitor &&
        win.Capacitor.isNativePlatform &&
        win.Capacitor.isNativePlatform()
    );

    const plug = (name) => win.Capacitor?.Plugins?.[name] ?? null;

    win._isCapacitorNative = IS_CAP;

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
            }
        } catch (e) { result.location = 'error'; }

        try {
            const notif = plug('LocalNotifications');
            if (notif) {
                const cur = await notif.checkPermissions();
                const st  = cur.display ?? 'prompt';
                result.notifications = (st === 'prompt' || st === 'prompt-with-rationale')
                    ? (await notif.requestPermissions()).display ?? 'denied'
                    : st;
                if (result.notifications === 'granted') await _createChannels(notif);
            }
        } catch (e) { result.notifications = 'error'; }

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
    }

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
                            let clearRequested = false;
                            _capGeo.watchPosition(opts ?? {}, (p, e) => {
                                if (e) { if (err) err(e); return; }
                                ok(_w3c(p));
                            }).then(id => {
                                ref = id;
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
                                    else { h._kill?.(); }
                                } else {
                                    _capGeo.clearWatch({ id: h });
                                }
                            } catch (_) {}
                        },
                    },
                });
            } catch (e) {}
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

    let _nid = (Date.now() % 100000) + 1;
    const _nextId = () => (_nid = (_nid % 2000000000) + 1);

    async function _fire({ title, body, channel = 'wx_alerts', iconColor = '#f59e0b', vibrate = null }) {
        if (!IS_CAP) {
            if ('Notification' in win) {
                const g = Notification.permission === 'granted' ? 'granted' : (Notification.permission !== 'denied' ? await Notification.requestPermission() : 'denied');
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
        } catch (e) {}
    }

    function _stripHtml(str) {
        return (str ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    }

    function _scenarioChannel(sc) {
        return ['downburst', 'dust-storm'].includes(sc) ? 'wx_emergency' : 'wx_alerts';
    }

    const _SCENARIO_COLOR = {
        'downburst': '#8b5cf6', 'dust-storm': '#ef4444',
        'strong-wind': '#f97316', 'blowing-dust': '#f59e0b',
        'muggy': '#eab308', 'dense-dust-haze': '#b45309', 'dust-haze': '#60a5fa',
    };

    const _SCENARIO_VIBRATE = {
        'downburst':  [0, 400, 200, 400, 200, 400],
        'dust-storm': [0, 300, 150, 300, 150, 300],
    };

    const _CD = {
        dustStorm:   { last: 0, ms: 15 * 60 * 1000 },
        ati:         { last: 0, ms: 10 * 60 * 1000 },
        atiLastId:   '',
        downburst:   { last: 0, ms: 10 * 60 * 1000 },
        cb:          { last: 0, ms: 15 * 60 * 1000 },
        cbLastKey:   '',
        rain:        { last: 0, ms: 30 * 60 * 1000 },
        wind:        {},
        WIND_MS:     10 * 60 * 1000,
    };

    function _cooldownOk(cd) {
        const now = Date.now();
        if (now - cd.last < cd.ms) return false;
        cd.last = now;
        return true;
    }

    function _hookAlerts() {
        if (win._capBridgeHooked) {
            return;
        }
        win._capBridgeHooked = true;

        let hooked = 0;

        const _orig1 = win._showDustStormAlert;
        if (typeof _orig1 === 'function') {
            win._showDustStormAlert = function (aqiR, visR, alertType) {
                _orig1.apply(this, arguments);
                if (!_cooldownOk(_CD.dustStorm)) return;
                const title = alertType === 'haboob' ? (win._adminMessages?.haboob || win._adminMessages?.dustStorm || 'هبوب وعاصفة رملية') : (win._adminMessages?.dustStorm || 'عاصفة ترابية خطيرة');
                const body = 'رؤية: ' + (visR?.displayText ?? '—') + ' · AQI: ' + (aqiR?.aqi ?? '—') + ' — ' + (aqiR?.category ?? '') + '\nابقَ في المنزل، أغلق النوافذ تماماً.';
                _fire({ title: '🚨 ' + title, body, channel: 'wx_emergency', iconColor: '#ef4444', vibrate: [0, 300, 150, 300, 150, 300] });
            };
            hooked++;
        }

        const _orig2 = win._showATIAlert;
        if (typeof _orig2 === 'function') {
            win._showATIAlert = function (r) {
                _orig2.apply(this, arguments);
                if (!r || r.id === 'freshAir') return;
                if (r.id !== _CD.atiLastId) {
                    _CD.atiLastId = r.id;
                    _CD.ati.last = 0;
                }
                if (!_cooldownOk(_CD.ati)) return;
                const title = ((r.icon ?? '') + ' ' + (r.title ?? '')).trim();
                const body = ((r.message ?? '') + (r.ati ? '\nATI: ' + r.ati : '')).trim();
                _fire({ title, body, channel: 'wx_emergency', iconColor: r.color ?? '#f97316', vibrate: [0, 200, 100, 200] });
            };
            hooked++;
        }

        const WIND_NOTIF_SCENARIOS = new Set(['strong-wind', 'blowing-dust', 'muggy', 'dense-dust-haze', 'dust-haze']);
        const _origWind = win.applyWindForecastToUI;
        if (typeof _origWind === 'function') {
            win.applyWindForecastToUI = function (r) {
                _origWind.apply(this, arguments);
                if (!win._windAlertsEnabled) return;
                const sc = r?.windScenario;
                const alertText = r?.smartAlert;
                if (!alertText || !sc || !WIND_NOTIF_SCENARIOS.has(sc)) return;
                const now = Date.now();
                if (now - (_CD.wind[sc] ?? 0) < _CD.WIND_MS) return;
                _CD.wind[sc] = now;
                const sep = alertText.search(/ [—–] /);
                const title = sep > 0 ? alertText.slice(0, sep).trim() : alertText.trim();
                _fire({ title, body: alertText.trim(), channel: _scenarioChannel(sc), iconColor: _SCENARIO_COLOR[sc] ?? '#f59e0b', vibrate: _SCENARIO_VIBRATE[sc] ?? null });
            };
            hooked++;
        }

        const _orig4 = win._showDownburstAlert;
        if (typeof _orig4 === 'function') {
            win._showDownburstAlert = function (windR) {
                _orig4.apply(this, arguments);
                if (!_cooldownOk(_CD.downburst)) return;
                const body = 'هبات ' + (windR?.windGusts ?? '?') + ' كم/س (ضعف الرياح المستمرة ' + (windR?.rawSpeed ?? '?') + ' كم/س)\nابتعد عن الأشجار والمنشآت غير المثبّتة فوراً.';
                _fire({ title: '⬇️⚡ رياح هابطة مفاجئة — خطر فوري', body, channel: 'wx_emergency', iconColor: '#8b5cf6', vibrate: [0, 400, 200, 400, 200, 400] });
            };
            hooked++;
        }

        const _orig5 = win._showCbSmartCard;
        if (typeof _orig5 === 'function') {
            win._showCbSmartCard = function (type, content, options) {
                _orig5.apply(this, arguments);
                const cbKey = type + '|' + (content?.title ?? '');
                if (cbKey !== _CD.cbLastKey) {
                    _CD.cbLastKey = cbKey;
                    _CD.cb.last = 0;
                }
                if (!_cooldownOk(_CD.cb)) return;
                const icon = type === 'pre' ? '⚠️' : type === 'microburst' ? '🚨' : '🌩️';
                const title = (icon + ' ' + _stripHtml(content?.title ?? '')).trim();
                const body = (_stripHtml(content?.body ?? '') + (content?.factors ? '\n' + _stripHtml(content.factors) : '')).trim();
                const isCritical = type === 'microburst' || type === 'post' || content?.severity === 'severe' || content?.severity === 'high';
                _fire({ title, body, channel: isCritical ? 'wx_emergency' : 'wx_alerts', iconColor: type === 'pre' ? '#fb923c' : type === 'microburst' ? '#ef4444' : '#c084fc', vibrate: isCritical ? [0, 400, 200, 400] : null });
            };
            hooked++;
        }

        const _orig6 = win.checkNearRainAlert;
        if (typeof _orig6 === 'function') {
            win.checkNearRainAlert = function (rainProbs) {
                _orig6.apply(this, arguments);
                if (!rainProbs?.length) return;
                const next2h  = rainProbs.slice(0, 2);
                const maxProb = Math.max(...next2h);
                if (maxProb < 60) return;
                if (!_cooldownOk(_CD.rain)) return;
                const hourIdx = next2h.indexOf(maxProb);
                const title = maxProb >= 80 ? '⚠️ مطر قريب جداً!' : '🌧️ فرصة مطر قريبة';
                const body = 'احتمال ' + maxProb + '% خلال ' + (hourIdx === 0 ? 'ساعة' : 'ساعتين');
                _fire({ title, body, channel: 'wx_alerts', iconColor: '#3b82f6' });
            };
            hooked++;
        }

        if (hooked < 6) {
            win._capBridgeHooked = false;
            setTimeout(_hookAlerts, 2000);
        }
    }

    if (IS_CAP) {
        let _lastFG = Date.now();
        doc.addEventListener('pause', function () { _lastFG = Date.now(); win.CapPrefs.backupCriticalKeys(); }, false);
        doc.addEventListener('resume', function () {
            if (Date.now() - _lastFG > 10 * 60 * 1000) {
                _CD.dustStorm.last = 0;
                _CD.downburst.last = 0;
                _CD.ati.last       = 0;
                _CD.cb.last        = 0;
                Object.keys(_CD.wind).forEach(k => { _CD.wind[k] = 0; });
            }
            if (Date.now() - _lastFG > 5 * 60 * 1000) {
                win._lastWeatherLoad = 0;
                setTimeout(function () { try { if (typeof win.loadWeather === 'function') win.loadWeather(); } catch (_) {} }, 600);
            }
        }, false);
    }

    async function _onDOMReady() {
        await win.CapPrefs.restoreOnFirstLaunch();
        if (IS_CAP) {
            setTimeout(async function () { await win.checkPermissions(); }, 2000);
            setTimeout(function () { win.CapPrefs.backupCriticalKeys(); }, 8000);
            if (!win._capBridgeBackupIv) {
                win._capBridgeBackupIv = setInterval(function () { win.CapPrefs.backupCriticalKeys(); }, 5 * 60 * 1000);
            }
        }
    }

    function _onFullLoad() {
        setTimeout(_hookAlerts, 3500);
    }

    if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', _onDOMReady);
    } else {
        _onDOMReady();
    }

    if (doc.readyState !== 'complete') {
        win.addEventListener('load', _onFullLoad);
    } else {
        setTimeout(_onFullLoad, 0);
    }

}(window, document));
