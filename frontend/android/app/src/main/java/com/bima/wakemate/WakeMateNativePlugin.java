package com.bima.wakemate;

import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Build;
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
