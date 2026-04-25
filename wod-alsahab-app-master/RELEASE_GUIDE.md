# دليل النشر — طقس السودان

## الخطوة 1: إنشاء Keystore (مرة واحدة فقط)

```bash
keytool -genkey -v \
  -keystore sudan-weather-release.keystore \
  -alias sudan-weather \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

احفظ الـ keystore في مكان آمن. **لا ترفعه على GitHub أبداً.**

---

## الخطوة 2: إعداد key.properties (للبناء المحلي)

```bash
cp android/key.properties.example android/key.properties
```

ثم افتح `android/key.properties` واملأ:
```
storeFile=../../sudan-weather-release.keystore
storePassword=كلمة_المرور
keyAlias=sudan-weather
keyPassword=كلمة_المرور
```

---

## الخطوة 3: إعداد GitHub Secrets (للـ CI/CD)

في إعدادات الريبو → Settings → Secrets → Actions، أضف:

| Secret | القيمة |
|--------|--------|
| `KEYSTORE_BASE64` | `base64 -i sudan-weather-release.keystore` |
| `KEYSTORE_PASSWORD` | كلمة مرور الـ keystore |
| `KEY_ALIAS` | `sudan-weather` |
| `KEY_PASSWORD` | كلمة مرور المفتاح |

---

## الخطوة 4: البناء المحلي

```bash
npm install
npx cap sync android
cd android
./gradlew bundleRelease   # ← AAB للـ Play Store
./gradlew assembleRelease # ← APK للتوزيع المباشر
```

الـ AAB يكون في:
`android/app/build/outputs/bundle/release/app-release.aab`

---

## الخطوة 5: رفع على Play Store

1. افتح [Google Play Console](https://play.google.com/console)
2. Production → Create new release
3. ارفع ملف `app-release.aab`
4. أضف Release notes بالعربية
5. راجع وأرسل للمراجعة

---

## تحديث الإصدار

في `android/app/build.gradle`:
```gradle
versionCode 2        // ← زِد بمقدار 1 في كل تحديث
versionName "1.1"    // ← اسم الإصدار للمستخدم
```
