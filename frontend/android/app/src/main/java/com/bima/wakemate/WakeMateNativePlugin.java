package com.bima.wakemate;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * AUD-06: Jembatan native Capacitor untuk memaksa volume suara ke 100%
 * saat alarm berdering serta mengontrol Foreground Service siaga.
 */
@CapacitorPlugin(name = "WakeMateNative")
public class WakeMateNativePlugin extends Plugin {
    private static final String ALARM_CHANNEL_ID = "wakemate_alarm_channel";
    private static final int ALARM_NOTIFICATION_ID = 2001;

    @PluginMethod
    public void showAlarmNotification(PluginCall call) {
        String title = call.getString("title", "Wake-Mate");
        String message = call.getString("message", "Alarm aktif");
        Context context = getContext();

        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) {
                call.reject("NotificationManager tidak tersedia");
                return;
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = new NotificationChannel(
                        ALARM_CHANNEL_ID,
                        "WakeMate Alarm",
                        NotificationManager.IMPORTANCE_HIGH
                );
                channel.setSound(null, null);
                channel.enableVibration(false);
                manager.createNotificationChannel(channel);
            }

            Intent intent = new Intent(context, MainActivity.class);
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pendingIntent = PendingIntent.getActivity(
                    context,
                    0,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, ALARM_CHANNEL_ID)
                    .setContentTitle(title)
                    .setContentText(message)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setFullScreenIntent(pendingIntent, true)
                    .setContentIntent(pendingIntent)
                    .setOngoing(true)
                    .setAutoCancel(false)
                    .setSilent(true);

            manager.notify(ALARM_NOTIFICATION_ID, builder.build());
            call.resolve();
        } catch (SecurityException e) {
            call.reject("Izin notifikasi ditolak: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopAlarmNotification(PluginCall call) {
        NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel(ALARM_NOTIFICATION_ID);
        }
        call.resolve();
    }

    @PluginMethod
    public void maximizeVolume(PluginCall call) {
        try {
            AudioManager audioManager = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (audioManager != null) {
                int maxMusic = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, maxMusic, 0);

                int maxAlarm = audioManager.getStreamMaxVolume(AudioManager.STREAM_ALARM);
                audioManager.setStreamVolume(AudioManager.STREAM_ALARM, maxAlarm, 0);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Gagal memaksimalkan volume: " + e.getMessage());
        }
    }

    @PluginMethod
    public void startForegroundService(PluginCall call) {
        try {
            Context context = getContext();
            Intent intent = new Intent(context, WakeMateKeeperService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Gagal memulai service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopForegroundService(PluginCall call) {
        try {
            Context context = getContext();
            Intent intent = new Intent(context, WakeMateKeeperService.class);
            context.stopService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Gagal menghentikan service: " + e.getMessage());
        }
    }
}
