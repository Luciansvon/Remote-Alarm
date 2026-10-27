# Project Incidents: Wake-Mate (Remote Alarm)

## INC-0001 — Java 21 vs Java 17 Compatibility Mismatch Saat Build APK

Status: Resolved  
First observed: 2026-10-27  
Affected version/commit: Initial Build v1.0  
Environment: Windows 11, Microsoft JDK 17 (`jdk-17.0.20.8-hotspot`), Capacitor 8  

### Symptom
Kompilasi Gradle gagal pada task `:capacitor-android:compileDebugJavaWithJavac` dengan pesan:
`error: invalid source release: 21`

### Reproduction
Jalankan `.\gradlew.bat assembleDebug` pada repositori Android Capacitor 8 yang baru di-generate di lingkungan lokal yang hanya memiliki JDK 17.

### Evidence
Log kegagalan pada background task Gradle (Task 198):
```text
Execution failed for task ':capacitor-android:compileDebugJavaWithJavac'.
> Java compilation initialization error
    error: invalid source release: 21
BUILD FAILED in 1m 30s
```

### Root cause
Capacitor 8 secara default mengonfigurasi `sourceCompatibility JavaVersion.VERSION_21` dan `targetCompatibility JavaVersion.VERSION_21` pada berkas generator `update.js`, `capacitor.build.gradle`, dan sub-projek plugin, sedangkan mesin compiler lokal Windows menggunakan Microsoft OpenJDK 17.

### Fix
Menyelaraskan konfigurasi Java compiler ke `JavaVersion.VERSION_17` pada:
1. `frontend/node_modules/@capacitor/cli/dist/android/update.js`
2. `frontend/node_modules/@capacitor/android/capacitor/build.gradle`
3. `frontend/android/app/capacitor.build.gradle`
4. `frontend/android/capacitor-cordova-android-plugins/build.gradle`

### Validation
Kompilasi ulang Gradle `.\gradlew.bat assembleDebug` berhasil (`BUILD SUCCESSFUL in 1m 49s`). Berkas APK terverifikasi terbentuk di `frontend/android/app/build/outputs/apk/debug/app-debug.apk` (4.5 MB), berhasil diinstal (`Success: streamed 4517587 bytes`), dan berjalan normal di emulator Android.

### Recurrence risk
Jika perintah `npx cap update` atau instalasi ulang `node_modules` dijalankan, berkas `capacitor.build.gradle` mungkin akan ter-generate ulang dengan target Java 21.

### Global promotion check
- [ ] Same root cause seen in another project
- [ ] Root cause belongs to shared infrastructure
- [ ] Shared prevention/change required
