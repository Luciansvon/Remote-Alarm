# Laporan Analisis Reverse Engineering (REA): PingPal (com.zlazgarusr.alarm)

Laporan ini memuat temuan teknis mendalam hasil dekompilasi, inspeksi AndroidManifest, disassembler Dalvik Executable (DEX), dan ekstraksi Hermes Bytecode bundle dari aplikasi **PingPal** (Versi `1.0.9`, Target SDK `36`, Package `com.zlazgarusr.alarm`).

---

## Ringkasan Eksekutif & Fondasi Arsitektur

PingPal dibangun menggunakan stack **React Native / Expo SDK 54.0.0** dengan engine JavaScript **Hermes (Bytecode v96)**, didukung oleh modul native tingkat rendah (Java/Kotlin):
* **Push & Background Orchestration:** `expo-notifications` (`ExpoFirebaseMessagingService`) dan `expo-task-manager` (`BACKGROUND_NOTIFICATION_TASK`).
* **Sistem Alarm & Notifikasi Interaktif:** `@notifee/react-native` (`app.notifee.core`).
* **Manipulasi Audio & Penembusan DND:** `react-native-volume-manager` (`com.reactnativevolumemanager.VolumeManagerModule`) dipadukan dengan `expo-av`.
* **Backend Transmisi:** Cloud Firestore + Firebase Cloud Functions (`us-central1-socialalarmapp-1060b.cloudfunctions.net`) + Firebase Storage (`socialalarmapp-1060b.firebasestorage.app`) + Web Portal Domain `alarmsend.com`.

---

## 1. Pemicu Jarak Jauh (Remote Trigger)

### 1.1 Komponen Penerima Sinyal (Receiver & Service)
Dalam berkas `AndroidManifest.xml`, PingPal mendaftarkan service penanganan pesan Firebase Cloud Messaging (FCM):
```xml
<service
    android:name="expo.modules.notifications.service.ExpoFirebaseMessagingService"
    android:exported="false">
    <intent-filter android:priority="-1">
        <action android:name="com.google.firebase.MESSAGING_EVENT" />
    </intent-filter>
</service>
```
* **Alur Eksekusi Native (`classes8.dex`):**
  Saat push notification FCM tipe data-message tiba dari cloud:
  1. `ExpoFirebaseMessagingService.onMessageReceived(RemoteMessage remoteMessage)` dieksekusi oleh OS Android di background.
  2. Service meneruskan `RemoteMessage` ke `FirebaseMessagingDelegate.onMessageReceived(remoteMessage)`.
  3. Mengaktifkan runtime background worker Expo Task Manager.

### 1.2 Registrasi Background Task di JavaScript (Hermes Bundle)
Di layer JavaScript/React Native, aplikasi mendaftarkan handler background task:
* Nama Task: `BACKGROUND_NOTIFICATION_TASK` via `TaskManager.defineTask` dan `Notifications.registerTaskAsync`.
* Handler ini menangkap payload FCM bahkan ketika aplikasi dalam kondisi tertutup (killed/terminated), lalu memicu `@notifee/react-native` untuk menampilkan alarm full-screen seketika.

### 1.3 Backend Endpoint & Cloud Functions
* **Firebase Cloud Functions Base URL:**
  `https://us-central1-socialalarmapp-1060b.cloudfunctions.net/`
* **Cloud Storage CDN untuk Media Alarm:**
  `https://storage.googleapis.com/socialalarmapp-1060b.firebasestorage.app/assets/sounds/{sound_id}.mp3`
* **Domain Backend / Deep Linking:**
  `https://alarmsend.com/share/:shareId` dan scheme `alarmapp://` untuk sinkronisasi alarm antar pasangan melalui link URL.

---

## 2. Penembusan Mode Senyap (Silent Bypass & DND)

PingPal menggunakan teknik multi-layer untuk memastikan alarm berdering maksimal 100% meskipun perangkat target berada di mode Hening (Silent), Getar (Vibrate), atau Jangan Ganggu (Do Not Disturb - DND).

### 2.1 Izin Manifest yang Digunakan
```xml
<uses-permission android:name="android.permission.ACCESS_NOTIFICATION_POLICY" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
```

### 2.2 Manipulasi Audio di Native (`VolumeManagerModule.java` di `classes7.dex`)
Aplikasi mengintegrasikan pustaka native `com.reactnativevolumemanager.VolumeManagerModule`. Berikut adalah dekompilasi logika internalnya:

1. **Pengecekan Akses DND (`hasDndAccess`):**
   ```java
   NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
   boolean granted = nm.isNotificationPolicyAccessGranted();
   ```
2. **Permintaan Hak DND (`requestDndAccess`):**
   Jika hak belum diberikan, aplikasi melempar intent:
   ```java
   Intent intent = new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS);
   context.startActivity(intent);
   ```
3. **Memaksa Keluar dari Silent/Vibrate (`setRingerMode`):**
   ```java
   AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
   am.setRingerMode(AudioManager.RINGER_MODE_NORMAL); // Nilai 2 = NORMAL (membatalkan Silent / Vibrate)
   ```
4. **Menaikkan Volume ke 100% (`setVolume` & `getVolType`):**
   ```java
   // getVolType memetakan string "alarm" ke AudioManager.STREAM_ALARM (4)
   int streamType = AudioManager.STREAM_ALARM; 
   int maxVol = am.getStreamMaxVolume(streamType);
   int targetVol = (int) (maxVol * volumeValue); // volumeValue = 1.0 (100%)
   am.setStreamVolume(streamType, targetVol, flags);
   ```

### 2.3 Bypass DND melalui Notification Channel Notifee (`classes4.dex`)
Di tingkat saluran notifikasi Android 8.0+ (Oreo ke atas), `Lapp/notifee/core/a;` mengonfigurasi `NotificationChannel`:
* **`setBypassDnd(true)`**: Mengizinkan notifikasi menembus filter Do Not Disturb.
* **`setImportance(NotificationManager.IMPORTANCE_HIGH)` (atau 4/5)**: Memastikan notifikasi muncul sebagai Heads-up / Full-screen.
* **`AudioAttributes`**: Dikonfigurasi dengan `USAGE_ALARM` dan konten audio tipe alarm.

---

## 3. Membangunkan Layar (Wake & Full Screen Intent)

### 3.1 Izin Manifest Terkait
```xml
<uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
<uses-permission android:name="android.permission.DISABLE_KEYGUARD" />
<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_SYSTEM_EXEMPT" />
```

### 3.2 Deklarasi Kunci pada Activity (`MainActivity`)
Konfigurasi `MainActivity` di `AndroidManifest.xml` (diinjeksi otomatis oleh plugin kustom `./withFullScreenIntent.js`):
```xml
<activity
    android:name="com.zlazgarusr.alarm.MainActivity"
    android:exported="true"
    android:launchMode="singleTask"
    android:showWhenLocked="true"
    android:turnScreenOn="true"
    android:theme="@style/AppTheme">
    ...
</activity>
```
* **`android:showWhenLocked="true"`**: Mengizinkan Activity dirender langsung di atas Lockscreen (menggantikan `FLAG_SHOW_WHEN_LOCKED` di Android 8.0+).
* **`android:turnScreenOn="true"`**: Memerintahkan sistem untuk menyalakan panel layar fisik saat Activity dibuat atau diaktifkan.
* **`android:launchMode="singleTask"`**: Menjamin bahwa jika alarm baru tiba saat aktivitas sudah ada di background, activity dipanggil ulang tanpa membuat instance bertumpuk (`onNewIntent`).

### 3.3 Eksekusi Full Screen Intent (`Lapp/notifee/core/c;` di `classes4.dex`)
Notifee membungkus pemanggilan sistem notifikasi Android:
```java
Intent intent = new Intent(context, MainActivity.class);
intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
intent.putExtra("mainComponent", "main");
intent.putExtra("notification", notificationBundle);

PendingIntent fullScreenPendingIntent = PendingIntent.getActivity(
    context, 
    notificationId, 
    intent, 
    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
);

NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
    .setFullScreenIntent(fullScreenPendingIntent, true)
    .setPriority(NotificationCompat.PRIORITY_MAX)
    .setCategory(NotificationCompat.CATEGORY_ALARM);
```

### 3.4 Mekanisme WakeLock Kuat (Hardware Screen Wake)
Dalam `Lapp/notifee/core/c;` baris bytecode `27bf3c` - `27bf7e`:
Notifee memeriksa apakah layar sedang mati (`!powerManager.isInteractive()`). Jika mati dan parameter `lightUpScreen: true` diset:
```java
PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
if (!pm.isInteractive()) {
    // Flag 0x3000001a:
    // PowerManager.FULL_WAKE_LOCK (0x1a) 
    // | PowerManager.ACQUIRE_CAUSES_WAKEUP (0x10000000) 
    // | PowerManager.ON_AFTER_RELEASE (0x20000000)
    WakeLock wl = pm.newWakeLock(0x3000001a, "Notifee:lock");
    wl.acquire();

    // CPU WakeLock agar prosesor tidak kembali tidur
    WakeLock cpuLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Notifee:cpuLock");
    cpuLock.acquire();
}
```

### 3.5 Foreground Service Pengaman (`app.notifee.core.ForegroundService`)
Untuk mencegah sistem membunuh proses alarm:
* Notifee memanggil `context.startForegroundService(intent)` dengan aksi `"app.notifee.core.ForegroundService.START"`.
* Service berjalan dengan atribut `android:foregroundServiceType="0x800"` (System Exempt / Media Playback).

---

## 4. Format Komunikasi & Payload Data Antar Pengguna

### 4.1 Skema Data Alarm
Dalam Hermes Bytecode, data transmisi tersusun dalam struktur objek berikut:

```typescript
interface RemoteAlarmPayload {
  // Identitas & Sesi
  sharedAlarmId: string;           // UUID unik sesi alarm
  sharedSecretKey: string;         // Kunci otentikasi pasangan
  
  // Informasi Aktor
  sender_uid: string;              // UID pengirim di Firebase Auth
  senderUsername: string;          // Username pembuat alarm
  senderName: string;              // Nama tampilan pengirim
  recipient_uid: string;           // UID target pasangan
  recipientUsername: string;       // Username target
  recipientName: string;           // Nama tampilan target
  
  // Properti Alarm
  time: string;                    // Waktu pemicu (HH:mm / ISO timestamp)
  soundUrl: string;                // URL audio di Firebase Storage / assets
  alarmType: "audio" | "video" | "voice" | "mission";
  
  // Misi & Interaksi
  missionType?: "dance" | "selfie" | "shake"; // Misi untuk mematikan alarm
  videoUrl?: string;               // Rekaman video/pesan pribadi pengirim
  giftMessage?: string;            // Pesan khusus
}
```

### 4.2 Tipe Notifikasi Acara (`notifications.*`)
1. `notifications.new_alarm`: Sinyal masuk pemicu alarm jarak jauh untuk membangunkan pasangan.
2. `notifications.alarm_accepted`: Konfirmasi saat pasangan menyetujui alarm yang diset.
3. `notifications.wake_me_up_accepted`: Konfirmasi saat pasangan meminta dibangunkan ("Wake Me Up Mode").
4. `notifications.new_proof_received`: Pengiriman bukti bahwa pasangan sudah bangun (Selfie/Video Proof).
5. `notifications.morning_reaction`: Pengiriman emoji/reaksi setelah alarm berhasil dihentikan.
6. `notifications.friend_request` & `notifications.friend_request_accepted`: Handshake pertemanan/pasangan.

---

## 5. Ringkasan Rekomendasi Implementasi untuk `couple-remote-alarm`

Untuk mereplikasi fitur alarm pasangan jarak jauh dengan performa dan keandalan setara PingPal:

1. **Gunakan Notifee (`@notifee/react-native`) atau Native Android Service:**
   * Konfigurasi channel: `importance: AndroidImportance.HIGH`, `bypassDnd: true`.
   * Konfigurasi notification: `fullScreenAction: { id: 'default', launchActivity: 'default' }`, `lightUpScreen: true`, `asForegroundService: true`.
2. **Deklarasikan Atribut Activity di AndroidManifest:**
   * `android:showWhenLocked="true"`
   * `android:turnScreenOn="true"`
   * `android:launchMode="singleTask"`
3. **Gunakan Izin DND & Volume Manager:**
   * Minta `android.permission.ACCESS_NOTIFICATION_POLICY`.
   * Set Ringer Mode ke `NORMAL` dan volume `STREAM_ALARM` ke 100% menggunakan `AudioManager.setStreamVolume`.
4. **Gunakan FCM High-Priority Data Messages:**
   * Kirim pesan FCM dengan `"priority": "high"` dan `"content_available": true` agar `onMessageReceived` langsung dieksekusi oleh OS Android dalam kondisi ponsel terkunci dan Doze mode.
