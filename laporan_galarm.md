# LAPORAN HASIL REVERSE ENGINEERING (REA) APK GALARM (v11.6.3)
**Target File**: `com.galarmapp` (Versi 11.6.3 / Code 7341840)  
**Tanggal Analisis**: 27 Oktober 2026  
**Metode Analisis**: Disassembly DEX (`dexdump`), Decompilation Manifest (`aapt`), Analisis Bundle JavaScript Hermes (`index.android.bundle`), dan Rekonstruksi Alur Kode Native Java/Kotlin.

---

## RINGKASAN EKSEKUTIF & ARSITEKTUR UMUM

Galarm dibangun menggunakan arsitektur **hibrida (React Native + Native Android)**:
1. **Lapisan Logika Bisnis & Komunikasi (React Native / Hermes JS)**:
   - Mengelola UI, kontak buddy, sinkronisasi data cloud via **Firebase Realtime Database** & **Cloud Firestore**, serta memproses event notifikasi latar belakang melalui **React Native Headless JS Task**.
2. **Lapisan Eksekusi Perangkat Keras & OS (Native Android - Java/Kotlin)**:
   - Mengontrol `AlarmManager`, `WakeLock`, `AudioAttributes`, `AudioManager` (STREAM_ALARM), `NotificationManager` (Do Not Disturb Policy), dan `FullScreenIntent` dengan `Activity` mandiri untuk membangkitkan layar terkunci.

---

## 1. PEMICU JARAK JAUH (REMOTE TRIGGER - BUDDY ALARM)

### A. Alur Pendaftaran & Penyimpanan Token FCM
* Galarm mendaftarkan token perangkat melalui kelas native `com.galarmapp.firebasemessaging.FCMMessagingServiceListener` (extends `FirebaseMessagingService`).
* Pada method `onNewToken(String token)`:
  - Token diambil dan langsung diperbarui ke **Firebase Realtime Database** pada path:
    ```text
    userInfos/{UID}/deviceInfo/deviceToken
    userInfos/{UID}/deviceInfo/updatedAt
    ```
  - Ini memungkinkan server atau pasangan/buddy mengambil token penerima secara otomatis tanpa polling terus-menerus.

### B. Pengiriman Alarm Antar Pengguna ("Buddy Alarm")
* Di lapisan JavaScript (`index.android.bundle`), ketika pengguna membuat alarm untuk orang lain:
  - Dipanggil fungsi seperti `createFirebaseObjectForAddAlarm` dan `createFirebaseObjectForAddingUserAsContactParticipantToGroupAlarm`.
  - Objek alarm disimpan ke Firebase.
  - Server (Firebase Cloud Functions / Backend Galarm) mengirimkan payload **FCM High-Priority Data Push** ke perangkat penerima.

### C. Penerimaan Pesan Push di Latar Belakang (Background Wakeup)
1. **Penerimaan di `FCMMessagingServiceListener`**:
   - Method `onMessageReceived(RemoteMessage remoteMessage)` menerima data payload melalui `remoteMessage.getData()`.
   - Mengonversi data map menjadi `Bundle` dan membungkusnya ke dalam `FCMMessagingNotificationAttributes`.
   - Meneruskan ke `NotificationHandler.handleNotification(attributes, context)`.

2. **Dua Skenario Penanganan (Foreground vs Background)**:
   - **Jika Aplikasi Terbuka (Foreground)**:
     - Dicek via `DeviceStateUtil.isApplicationRunning(context)`.
     - Dikirim broadcast lokal `NotificationReceiver` dengan flag `foreground: true` agar UI React Native langsung diperbarui.
   - **Jika Aplikasi Tertutup / Mati (Background / Killed State)**:
     - Jika atribut `muteNotification != "true"`, sistem menampilkan notifikasi Heads-up.
     - Kunci Utamanya: Jika atribut `contentAvailable == "1"` atau `"true"`:
       ```java
       Intent intent = new Intent(context, RemoteNotificationHandlerService.class);
       intent.putExtra("notification", bundle);
       if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
           context.startForegroundService(intent);
       } else {
           context.startService(intent);
       }
       ```

3. **Peran `RemoteNotificationHandlerService` (Headless JS Task)**:
   - Di `AndroidManifest.xml`, service ini dideklarasikan dengan tipe data sync:
     ```xml
     <service android:name="com.galarmapp.notifications.RemoteNotificationHandlerService"
              android:foregroundServiceType="dataSync" />
     ```
   - Service ini extends `com.facebook.react.HeadlessJsTaskService`.
   - `getTaskConfig()` mengembalikan `HeadlessJsTaskConfig("RemoteNotificationHandler", extras, ...)`.
   - **Mekanisme**: Meskipun UI aplikasi tidak aktif, mesin JavaScript React Native dijalankan beberapa detik di latar belakang untuk memproses alarm masuk, mengunduh detail tambahan dari Firebase, lalu memanggil modul native `AlarmManagerUtils.setAlarm()` untuk mendaftarkan jam alarm ke chip sistem Android.

---

## 2. PENEMBUSAN MODE SENYAP (SILENT BYPASS & DO NOT DISTURB)

### A. Izin Khusus di Manifest
Galarm mendeklarasikan izin kebijakan notifikasi:
```xml
<uses-permission name="android.permission.ACCESS_NOTIFICATION_POLICY" />
```

### B. Pemeriksaan & Edukasi Izin DND (`DeviceStateModule`)
Di kelas `com.galarmapp.devicestate.DeviceStateModule`:
* **`isDndAccessGranted()`**:
  Memanggil API Android:
  ```java
  NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
  boolean granted = nm.isNotificationPolicyAccessGranted();
  ```
* **`openDndSettings()`**:
  Jika izin belum aktif, Galarm tidak membiarkan alarm gagal, melainkan menampilkan Toast edukasi dan membuka layar setelan DND sistem:
  ```java
  Intent intent = new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS);
  intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
  context.startActivity(intent);
  ```

### C. Strategi Audio Stream & Ringer Mode
Pada saat alarm berdering di `AlarmRingerService.setMediaStreamVolumeAndPlay()`:
1. **Pemilihan Stream Alarm (`STREAM_ALARM`)**:
   - Meminta audio stream alarm:
     ```java
     AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
     int maxVol = am.getStreamMaxVolume(AudioManager.STREAM_ALARM);
     am.setStreamVolume(AudioManager.STREAM_ALARM, calculatedVolume, 0);
     ```
2. **Penggunaan `AudioAttributes` Khusus Alarm**:
   - Saat membuat `MediaPlayer`:
     ```java
     AudioAttributes audioAttributes = new AudioAttributes.Builder()
         .setUsage(AudioAttributes.USAGE_ALARM)
         .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
         .build();
     mediaPlayer.setAudioAttributes(audioAttributes);
     ```
   - **Prinsip OS Android**: Suara yang dialirkan ke `USAGE_ALARM` memiliki perlakuan istimewa di kernel audio Android: suara alarm **tetap dibunyikan melalui speaker fisik ponsel** meskipun tombol fisik ponsel disetel ke Silent (Mode Hening) atau Vibrate (Mode Getar), kecuali pengguna menyetel DND ke level "Total Silence".
3. **Peningkatan Volume Bertahap (Volume Shaper)**:
   - Galarm memanfaatkan `VolumeShaper.Configuration.Builder` (Android 8.0+) untuk menaikkan volume secara perlahan (gradual fade-in / volume ramp-up) sehingga pengguna tidak terkejut.
4. **Vibrasi Berulang**:
   - Memanggil `AlarmRingerService.vibrate()` dengan pola getar terprogram untuk memperkuat efek bangun jika volume sangat rendah.

---

## 3. MEMBANGUNKAN LAYAR (WAKE & FULL SCREEN INTENT)

### A. Penjadwalan Tingkat Tinggi via `AlarmManager.setAlarmClock`
Di `AlarmManagerUtils.scheduleAlarm()`:
* Galarm **tidak** memakai alarm biasa yang bisa tertunda oleh mode Doze baterai.
* Galarm menggunakan API resmi jam weker Android:
  ```java
  AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
  AlarmManager.AlarmClockInfo clockInfo = new AlarmManager.AlarmClockInfo(triggerTime, pendingShowIntent);
  am.setAlarmClock(clockInfo, pendingAlarmIntent);
  ```
* Didukung dengan izin Android 12-15:
  ```xml
  <uses-permission name="android.permission.SCHEDULE_EXACT_ALARM" maxSdkVersion="32" />
  <uses-permission name="android.permission.USE_EXACT_ALARM" />
  <uses-permission name="android.permission.WAKE_LOCK" />
  ```
* Komponen receiver penerima: `com.galarmapp.alarmmanager.AlarmReceiver`.

### B. Transisi ke Foreground Service (`AlarmRingerService`)
Saat waktu alarm tercapai:
1. `AlarmReceiver.onReceive()` menerima broadcast.
2. Memulai service pemutar suara:
   ```java
   Intent intent = new Intent(context, AlarmRingerService.class);
   intent.setAction("playAlarmAction");
   intent.putExtra("alarm", alarmParcelable);
   context.startForegroundService(intent);
   ```
3. Di `AndroidManifest.xml`, `AlarmRingerService` dideklarasikan tahan-reboot dan tipe media playback:
   ```xml
   <service android:name="com.galarmapp.alarmmanager.AlarmRingerService"
            android:directBootAware="true"
            android:foregroundServiceType="mediaPlayback" />
   ```
   * `directBootAware="true"`: Alarm tetap dapat menyala meski HP baru saja restart dan user belum memasukkan PIN lockscreen pertama kali!

### C. Notifikasi Prioritas Tinggi & `setFullScreenIntent`
Di `AlarmNotificationHandler.getAlarmNotification()`:
1. **NotificationChannel**:
   - Menggunakan Channel bernama `"Alarm notifications"` dengan `NotificationManager.IMPORTANCE_HIGH` atau `IMPORTANCE_MAX`.
2. **Kategori Alarm**:
   - `builder.setCategory(NotificationCompat.CATEGORY_ALARM)`
   - `builder.setPriority(NotificationCompat.PRIORITY_MAX)`
3. **Pemicu Layar Penuh (`setFullScreenIntent`)**:
   ```java
   builder.setFullScreenIntent(pendingFullScreenIntent, true);
   ```
   * Didukung izin Android 14+:
     ```xml
     <uses-permission name="android.permission.USE_FULL_SCREEN_INTENT" />
     ```
   * `pendingFullScreenIntent` mengarah ke Activity layar penuh:
     - `FullScreenAlarmActivityWithSlider` (jika pengaturan geser untuk mematikan)
     - `FullScreenActivityWithButton` (jika pengaturan ketuk untuk mematikan)

### D. Bypass Kunci Layar di Activity (`FullScreenBaseActivity`)
Ketika Activity layar penuh diluncurkan saat HP tertidur / terkunci:
Di `FullScreenBaseActivity.onCreate()`:
```java
// 1. Hilangkan title bar
requestWindowFeature(Window.FEATURE_NO_TITLE);

// 2. Hidupkan layar & tampilkan di atas layar terkunci
if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) { // Android 27+
    setShowWhenLocked(true);
    setTurnScreenOn(true);
} else {
    getWindow().addFlags(
        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED |
        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
    );
}

// 3. Pertahankan layar tetap menyala selama berdering
getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

// 4. Mencegah user mematikan alarm secara tidak sengaja via tombol back
@Override
public void onBackPressed() {
    // Kosong (return-void)
}
```
Saat alarm dimatikan atau dikonfirmasi, Activity dapat meminta pembukaan kunci layar menggunakan `KeyguardManager.requestDismissKeyguard()`.

---

## 4. STRUKTUR DATA ALARM (DATA PAYLOAD SCHEMA)

### A. Format Objek Alarm (`com.galarmapp.alarmmanager.Alarm`)
Objek ini mengimplementasikan `Parcelable` dan mendukung serialisasi JSON (`toJson()` / `fromJson()`).

Berikut skema atribut lengkapnya:
```json
{
  "alarmId": "unique-uuid-string",
  "alarmName": "Bangun Sayang! Jangan Lupa Sarapan",
  "alarmDate": 1793088000000,
  "fireDate": 1793088000000,
  "alarmEndDate": 0,
  "alarmType": "buddyAlarm",
  "alarmCreationMode": "normalAlarm",
  "type": "alarm",
  "creatorTimezone": "Asia/Jakarta",
  "cascadingAlarmInterval": 300000,
  "recipientAlarmInterval": 600000,
  "notificationID": 104234,
  "volume": 100,
  "vibrate": "true",
  "ringOnVibrate": "true",
  "ringtonePath": "android.resource://com.galarmapp/raw/summer_soft",
  "ringtoneDuration": 60000,
  "autoSnooze": "true",
  "autoSnoozeCount": 3,
  "autoSnoozeDuration": 5,
  "preReminderDuration": 0,
  "announceAlarmName": "false",
  "shortAlarmAlert": "false",
  "repeat": "DAILY",
  "repeatType": "DAYS",
  "version": 1
}
```

#### Penjelasan Atribut Khusus Buddy Alarm:
* `cascadingAlarmInterval`: Interval waktu (ms) sebelum sistem menaikkan eskalasi alarm ke tingkat berikutnya jika penerima belum mematikan alarm.
* `recipientAlarmInterval`: Jeda waktu setelah jam alarm berdering untuk mengirim notifikasi status balik ke pembuat alarm (*"Pasanganmu belum mematikan alarm"* atau *"Alarm sudah dimatikan"*).
* `creatorTimezone`: Zona waktu pembuat alarm, memastikan sinkronisasi waktu tetap tepat meski pasangan berada di zona waktu berbeda (misal: WIB vs WITA).

### B. Format Payload Notifikasi FCM (`RemoteMessage.getData()`)
Dicerna oleh `FCMMessagingNotificationAttributes`:
```json
{
  "id": "alarm-12345",
  "type": "alarm",
  "title": "Alarm Baru dari Pasangan",
  "message": "Bima menyetel alarm untukmu jam 06:00 WIB",
  "contentAvailable": "1",
  "muteNotification": "false",
  "actions": "[{\"id\":\"dismiss\",\"title\":\"Tolak\"},{\"id\":\"accept\",\"title\":\"Terima\"}]",
  "bundle": {
    "alarmId": "alarm-12345",
    "alarmData": "{...json string model Alarm di atas...}"
  }
}
```
* `contentAvailable: "1"` adalah sinyal standar iOS/Android agar sistem operasi memberikan waktu eksekusi latar belakang (Wakeful execution) ke aplikasi tanpa mewajibkan interaksi klik dari user.

---

## 5. REKOMENDASI UNTUK APLIKASI `COUPLE-REMOTE-ALARM` KITA

Berdasarkan arsitektur Galarm yang telah terbukti di produksi (jutaan unduhan), berikut panduan desain untuk aplikasi Remote Alarm Pasangan kita:

1. **Sinkronisasi Pasangan (Remote Trigger)**:
   - Gunakan FCM dengan tipe pesan **High Priority Data Message** (`contentAvailable: true`).
   - Simpan device token pasangan di database cloud (Firebase / Supabase) di bawah profil user.
   - Saat push FCM tiba, gunakan Foreground Service singkat (`dataSync`) atau WorkManager untuk menyimpan alarm ke basis data lokal dan menjadwalkannya ke `AlarmManager`.

2. **Jaminan Eksekusi Tepat Waktu**:
   - Gunakan `AlarmManager.setAlarmClock()` karena ini satu-satunya API Android yang kebal Doze Mode dan memunculkan ikon jam di status bar.
   - Tambahkan izin `USE_EXACT_ALARM` dan `RECEIVE_BOOT_COMPLETED` (untuk menjadwalkan ulang alarm otomatis setelah ponsel dinyalakan ulang).

3. **Tembus Mode Senyap & Suara Kencang**:
   - Minta izin `ACCESS_NOTIFICATION_POLICY` agar aplikasi dapat membaca dan mengubah mode DND jika diperlukan.
   - Gunakan `AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()`.
   - Gunakan `AudioManager.setStreamVolume(AudioManager.STREAM_ALARM, maxVol, 0)` saat alarm mulai berdering.

4. **Tampilan Layar Penuh Saat Terkunci**:
   - Gunakan Notification Channel dengan `IMPORTANCE_HIGH`.
   - Pasang `setFullScreenIntent(pendingIntent, true)`.
   - Di Activity alarm: gunakan `setShowWhenLocked(true)`, `setTurnScreenOn(true)`, dan `FLAG_KEEP_SCREEN_ON`.
   - Override `onBackPressed()` agar pasangan tidak bisa mematikan alarm hanya dengan menekan tombol kembali secara reflek!

---
*Laporan ini disimpan secara otomatis dan siap dijadikan acuan arsitektur pengembangan modul `couple-remote-alarm`.*
