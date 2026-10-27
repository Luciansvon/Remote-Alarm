# Project Architecture: Wake-Mate (Remote Alarm)

## Project identity

- Name: Wake-Mate (Remote Alarm)
- Repository: https://github.com/Luciansvon/Remote-Alarm
- Type: Fullstack Mobile & Realtime Web Application
- Platforms: Android (APK via Capacitor), Web Browser
- Primary runtime/toolchain: Node.js, Express, Socket.io, React (Vite), Capacitor Android, Java 17

## System overview

```text
[HP Bima (Sender)] 
      |  (Sinyal Realtime: Room ID, Alarm Trigger / Jadwal / Audio Data URL)
      v
[Socket.io Backend Server (Port 4000)]
      |  (Push Event Realtime / Scheduler Tick 1s)
      v
[HP Pacar (Receiver)] 
      |
      +--> Bypass Do Not Disturb / Mode Hening (Volume 100%)
      +--> Putar Suara (Sirine / Jam Beker / TikTok Audio / Suara Bima)
      +--> Misi Bangun (Wajib Ketuk 3x)
```

## Major components

| Component | Responsibility | Technology | Notes |
|---|---|---|---|
| `backend/server.js` | Mengelola Room pasangan, status alarm realtime, penjadwalan alarm per detik, dan relay berkas audio kustom. | Node.js, Express, Socket.io | Port 4000, max payload 20MB |
| `frontend/src/App.jsx` | Antarmuka pengguna bergaya Neubrutalism, navigasi tab jempol (Kilat, Jadwal, Daftar, Profil), pengunggah audio TikTok. | React, Vite, Lucide Icons | Responsive Mobile-First |
| `frontend/src/soundManager.js` | Synthesizer Web Audio API (Sirine, Jam Beker) dan pemutar rekaman audio/TikTok kustom. | Web Audio API / HTML5 Audio | Support MP3, WebM, WAV, AAC |
| `frontend/android` | Shell native Android Capacitor untuk mempaketkan aplikasi ke berkas APK mandiri. | Capacitor 8, Android SDK, Gradle | Target Android API 24-36 |

## Build / test / release interface

- Build Frontend: `npm run build` (di folder `frontend`)
- Sync Android: `npx cap sync android` (di folder `frontend`)
- Build APK Debug: `.\gradlew.bat assembleDebug` (di folder `frontend/android`)
- Artifact Path: `frontend/android/app/build/outputs/apk/debug/app-debug.apk`
- Runner requirements: Java 17 (Local) / Java 21 (GitHub Actions), Android SDK Platform 36

## Constraints

- OS: Android 7.0+ (API 24+)
- Network: Membutuhkan koneksi internet/WiFi yang terhubung ke server backend
- Permissions: Internet, WakeLock, Vibrate, Modify Audio Settings, Record Audio, usesCleartextTraffic
