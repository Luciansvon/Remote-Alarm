package com.bima.wakemate;

import android.content.Context;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Daftarkan plugin native kustom WakeMate sebelum inisialisasi Bridge
        registerPlugin(WakeMateNativePlugin.class);
        super.onCreate(savedInstanceState);

        // Nyalakan layar dan tampilkan di atas layar kunci saat alarm aktif
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Izinkan pemutaran audio otomatis tanpa perlu sentuhan layar
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
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
    public void onBackPressed() {
        // Pindahkan aplikasi ke latar belakang daripada mematikan Activity langsung
        // Ini mencegah alarm terhenti secara tidak sengaja hanya karena usapan gestur Back
        moveTaskToBack(true);
    }
}
