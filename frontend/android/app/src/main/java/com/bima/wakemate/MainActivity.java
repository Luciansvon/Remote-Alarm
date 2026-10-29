package com.bima.wakemate;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 100;
    public static volatile boolean isActivityVisible = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Daftarkan plugin native kustom WakeMate sebelum inisialisasi Bridge
        registerPlugin(WakeMateNativePlugin.class);
        super.onCreate(savedInstanceState);

        // Nyalakan service penjaga native sejak awal sebelum WebView selesai dimuat
        try {
            Intent svcIntent = new Intent(this, WakeMateKeeperService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(svcIntent);
            } else {
                startService(svcIntent);
            }
        } catch (Exception ignored) {
        }

        // API 33+: izin notifikasi wajib agar alarm bisa tampil di layar kunci
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATION_PERMISSION_REQUEST_CODE);
        }

        // API 23+: minta pengecualian penghemat baterai agar service latar belakang tidak dibunuh
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                    Intent batteryIntent = new Intent(
                            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:" + getPackageName())
                    );
                    startActivity(batteryIntent);
                }
            } catch (Exception ignored) {
            }
        }

        // Nyalakan layar dan tampilkan di atas layar kunci saat alarm aktif
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Izinkan pemutaran audio otomatis tanpa perlu sentuhan layar dan izinkan websocket lokal
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
            getBridge().getWebView().getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // Paksa volume media Android (STREAM_MUSIC) ke tingkat maksimal
        try {
            AudioManager audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (audioManager != null) {
                int maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, maxVolume, 0);
            }
        } catch (Exception e) {
            // Abaikan jika dicegah sistem tertentu
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        isActivityVisible = true;
        WakeMateKeeperService.onActivityResumed(this);
    }

    @Override
    public void onPause() {
        isActivityVisible = false;
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        // Pindahkan aplikasi ke latar belakang daripada mematikan Activity langsung
        // Ini mencegah alarm terhenti secara tidak sengaja hanya karena usapan gestur Back
        moveTaskToBack(true);
    }
}
