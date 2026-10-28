package com.bima.wakemate;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

/**
 * AUD-06: Foreground Service untuk mempertahankan koneksi WebSocket semalaman
 * dan mencegah Android Doze Mode memutus jaringan saat layar HP pacar dimatikan.
 */
public class WakeMateKeeperService extends Service {
    private static final String CHANNEL_ID = "wakemate_keeper_channel";
    private static final int NOTIFICATION_ID = 1001;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("WakeMate Siaga")
                .setContentText("Koneksi alarm jarak jauh aktif semalaman")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();

        startForeground(NOTIFICATION_ID, notification);

        acquireLocks();
    }

    private void acquireLocks() {
        // Kunci prosesor agar tidak tertidur saat Doze Mode
        try {
            PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (powerManager != null) {
                if (wakeLock == null) {
                    wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "WakeMate::KeeperLock");
                    wakeLock.setReferenceCounted(false);
                }
                if (wakeLock.isHeld()) {
                    wakeLock.release();
                }
                // acquire ulang memperpanjang timeout saat service di-restart sistem
                wakeLock.acquire(24 * 60 * 60 * 1000L);
            }
        } catch (Exception e) {
            // Abaikan jika device membatasi
        }

        // Kunci sambungan Wi-Fi agar tidak sleep saat layar mati
        try {
            WifiManager wifiManager = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifiManager != null) {
                if (wifiLock == null) {
                    wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "WakeMate::WifiLock");
                }
                if (!wifiLock.isHeld()) {
                    wifiLock.acquire();
                }
            }
        } catch (Exception e) {
            // Abaikan jika device membatasi
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "WakeMate Penjaga Alarm",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Menjaga koneksi alarm jarak jauh tetap aktif saat HP tidur");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Restart oleh sistem: segarkan kembali wake lock 24 jam
        acquireLocks();
        return START_STICKY;
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception e) {}
            wakeLock = null;
        }

        if (wifiLock != null && wifiLock.isHeld()) {
            try {
                wifiLock.release();
            } catch (Exception e) {}
            wifiLock = null;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
