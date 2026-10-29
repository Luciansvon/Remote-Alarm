package com.bima.wakemate;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Base64;
import androidx.core.app.NotificationCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

/**
 * AUD-06: Jembatan native Capacitor untuk memaksa volume suara ke 100%
 * saat alarm berdering serta mengontrol Foreground Service siaga.
 */
@CapacitorPlugin(name = "WakeMateNative")
public class WakeMateNativePlugin extends Plugin {
    public static final String PREFS_NAME = "wakemate_native";
    private static final int ALARM_NOTIFICATION_ID = 2001;
    private static volatile WakeMateNativePlugin activeInstance = null;

    @Override
    public void load() {
        super.load();
        activeInstance = this;
    }

    public static void notifyAlarmStoppedFromNative() {
        WakeMateNativePlugin inst = activeInstance;
        if (inst != null) {
            try {
                JSObject payload = new JSObject();
                payload.put("stopped", true);
                inst.notifyListeners("nativeAlarmStopped", payload);
            } catch (Exception ignored) {
            }
        }
    }

    @PluginMethod
    public void syncConfig(PluginCall call) {
        try {
            Context context = getContext();
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            SharedPreferences.Editor editor = prefs.edit();

            String serverUrl = call.getString("serverUrl");
            String roomId = call.getString("roomId");
            String roomPin = call.getString("roomPin");
            String deviceId = call.getString("deviceId");
            String role = call.getString("role");
            String schedulesJson = call.getString("schedulesJson");

            if (serverUrl != null) editor.putString("serverUrl", serverUrl);
            if (roomId != null) editor.putString("roomId", roomId);
            if (roomPin != null) editor.putString("roomPin", roomPin);
            if (deviceId != null) editor.putString("deviceId", deviceId);
            if (role != null) editor.putString("role", role);
            if (schedulesJson != null) editor.putString("schedulesJson", schedulesJson);
            editor.apply();

            Intent intent = new Intent(context, WakeMateKeeperService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }

            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Gagal sinkronisasi konfigurasi: " + e.getMessage());
        }
    }

    @PluginMethod
    public void saveNativeAudio(PluginCall call) {
        String audioId = call.getString("audioId", "");
        String b64 = call.getString("dataUrl", call.getString("base64", ""));
        if (audioId == null || audioId.isEmpty() || b64 == null || b64.isEmpty()) {
            call.reject("audioId dan dataUrl wajib diisi");
            return;
        }
        try {
            int commaIdx = b64.indexOf(',');
            if (commaIdx >= 0) {
                b64 = b64.substring(commaIdx + 1);
            }
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            String safeAudioId = audioId.replaceAll("[^a-zA-Z0-9._-]", "_");
            File outFile = new File(getContext().getFilesDir(), "audio_" + safeAudioId + ".mp3");
            try (FileOutputStream fos = new FileOutputStream(outFile)) {
                fos.write(bytes);
            }
            JSObject ret = new JSObject();
            ret.put("saved", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Gagal menyimpan audio native: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getBatteryStatus(PluginCall call) {
        boolean ignoring = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                ignoring = pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
            }
        }
        JSObject ret = new JSObject();
        ret.put("ignoringBatteryOptimizations", ignoring);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimization(PluginCall call) {
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                Intent intent = new Intent(
                        Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + context.getPackageName())
                );
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
            } catch (Exception e) {
                try {
                    Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(fallback);
                } catch (Exception ignored) {
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void showAlarmNotification(PluginCall call) {
        String id = call.getString("id", "");
        String title = call.getString("title", "🚨 Wake-Mate Alarm");
        String message = call.getString("message", "Waktunya bangun!");
        String sound = call.getString("sound", "siren");
        String audioId = call.getString("audioId", "");
        Context context = getContext();

        try {
            WakeMateKeeperService.showOrTriggerFromPlugin(context, id, title, message, sound, audioId);
            call.resolve();
        } catch (SecurityException e) {
            call.reject("Izin notifikasi ditolak: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopAlarmNotification(PluginCall call) {
        Context context = getContext();
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.cancel(ALARM_NOTIFICATION_ID);
        }
        WakeMateKeeperService.stopNativeAlarm(context);
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
            boolean force = Boolean.TRUE.equals(call.getBoolean("force", false));
            if (force) {
                Context context = getContext();
                Intent intent = new Intent(context, WakeMateKeeperService.class);
                context.stopService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Gagal menghentikan service: " + e.getMessage());
        }
    }
}
