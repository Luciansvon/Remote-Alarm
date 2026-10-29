package com.bima.wakemate;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Base64;
import androidx.core.app.NotificationCompat;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * AUD-06: Foreground Service mandiri untuk mempertahankan polling alarm & jadwal lokal
 * saat aplikasi di-swipe dari Recent Apps atau layar terkunci dalam Doze Mode.
 */
public class WakeMateKeeperService extends Service {
    private static final String CHANNEL_ID = "wakemate_keeper_channel";
    private static final String ALARM_CHANNEL_ID = "wakemate_alarm_channel";
    private static final String MESSAGE_CHANNEL_ID = "wakemate_message_channel";
    private static final int NOTIFICATION_ID = 1001;
    private static final int ALARM_NOTIFICATION_ID = 2001;
    private static final int MESSAGE_NOTIFICATION_ID = 2002;

    private static MediaPlayer mediaPlayer;
    private static Vibrator vibrator;
    private static volatile String activeAlarmKey = null;
    private static volatile String lastStoppedAlarmKey = null;
    private static volatile String lastTextId = null;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private ScheduledExecutorService scheduler;

    public static synchronized void stopNativeMediaOnly() {
        if (mediaPlayer != null) {
            try {
                if (mediaPlayer.isPlaying()) {
                    mediaPlayer.stop();
                }
            } catch (Exception ignored) {
            }
            try {
                mediaPlayer.release();
            } catch (Exception ignored) {
            }
            mediaPlayer = null;
        }
        if (vibrator != null) {
            try {
                vibrator.cancel();
            } catch (Exception ignored) {
            }
            vibrator = null;
        }
    }

    public static synchronized void stopNativeAlarm(Context ctx) {
        stopNativeMediaOnly();
        if (activeAlarmKey != null) {
            lastStoppedAlarmKey = activeAlarmKey;
            activeAlarmKey = null;
        }
        if (ctx != null) {
            NotificationManager manager = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.cancel(ALARM_NOTIFICATION_ID);
            }
            final Context appCtx = ctx.getApplicationContext();
            new Thread(() -> {
                try {
                    SharedPreferences prefs = appCtx.getSharedPreferences(WakeMateNativePlugin.PREFS_NAME, Context.MODE_PRIVATE);
                    String serverUrl = normalizeServerUrl(prefs.getString("serverUrl", ""));
                    String roomId = prefs.getString("roomId", "");
                    String roomPin = prefs.getString("roomPin", "");
                    String role = prefs.getString("role", "Pasangan");
                    if (serverUrl.isEmpty() || roomId.isEmpty() || roomPin.isEmpty()) return;

                    String urlStr = serverUrl + "/api/stop?roomId=" + URLEncoder.encode(roomId, "UTF-8")
                            + "&pin=" + URLEncoder.encode(roomPin, "UTF-8")
                            + "&stopper=" + URLEncoder.encode(role.isEmpty() ? "Pasangan" : role, "UTF-8");
                    HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
                    conn.setRequestMethod("POST");
                    conn.setConnectTimeout(4000);
                    conn.setReadTimeout(4000);
                    conn.getResponseCode();
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            }).start();
        }
    }

    public static void onActivityResumed(Context ctx) {
        // Media tetap berbunyi sampai WebView memanggil showAlarmNotification atau stopAlarmNotification
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("WakeMate Siaga")
                .setContentText("Penjaga alarm & jadwal aktif di latar belakang")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();

        startForeground(NOTIFICATION_ID, notification);
        acquireLocks();
        startPollingLoop();
    }

    private synchronized void startPollingLoop() {
        if (scheduler != null && !scheduler.isShutdown()) {
            return;
        }
        scheduler = Executors.newSingleThreadScheduledExecutor();
        scheduler.scheduleWithFixedDelay(this::runGuardianTick, 1, 4, TimeUnit.SECONDS);
    }

    private void runGuardianTick() {
        try {
            SharedPreferences prefs = getSharedPreferences(WakeMateNativePlugin.PREFS_NAME, Context.MODE_PRIVATE);
            String serverUrl = normalizeServerUrl(prefs.getString("serverUrl", ""));
            String roomId = prefs.getString("roomId", "");
            String roomPin = prefs.getString("roomPin", "");
            String deviceId = prefs.getString("deviceId", "");
            String role = prefs.getString("role", "");
            String schedulesJson = prefs.getString("schedulesJson", "[]");

            checkLocalSchedules(prefs, schedulesJson, deviceId, role);
            pollServer(prefs, serverUrl, roomId, roomPin, deviceId, role);
        } catch (Exception ignored) {
        }
    }

    private void checkLocalSchedules(SharedPreferences prefs, String schedulesJson, String deviceId, String role) {
        if (schedulesJson == null || schedulesJson.isEmpty()) return;
        try {
            JSONArray arr = new JSONArray(schedulesJson);
            long now = System.currentTimeMillis();
            boolean modified = false;

            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.optJSONObject(i);
                if (item == null) continue;
                boolean fired = item.optBoolean("fired", false);
                long triggerTime = item.optLong("triggerTime", 0L);
                if (!fired && triggerTime > 0 && now >= triggerTime && (now - triggerTime) < 300_000L) {
                    String senderDev = item.optString("senderDeviceId", "");
                    if ("simulasi".equals(role) || senderDev.isEmpty() || !senderDev.equals(deviceId)) {
                        item.put("fired", true);
                        modified = true;

                        String id = item.optString("id", String.valueOf(triggerTime));
                        String key = "sched_" + id;
                        if (!key.equals(activeAlarmKey) && !key.equals(lastStoppedAlarmKey)) {
                            String sender = item.optString("creator", "Pasangan");
                            String message = item.optString("message", "Waktunya bangun!");
                            String sound = item.optString("sound", "siren");
                            String audioId = item.optString("audioId", "");
                            triggerNativeAlarm(key, sender, message, sound, audioId);
                        }
                    }
                }
            }

            if (modified) {
                prefs.edit().putString("schedulesJson", arr.toString()).apply();
            }
        } catch (Exception ignored) {
        }
    }

    private void pollServer(SharedPreferences prefs, String serverUrl, String roomId, String roomPin, String deviceId, String role) {
        if (serverUrl.isEmpty() || roomId.isEmpty() || roomPin.isEmpty()) return;

        HttpURLConnection conn = null;
        try {
            String urlStr = serverUrl + "/api/poll?roomId=" + URLEncoder.encode(roomId, "UTF-8")
                    + "&pin=" + URLEncoder.encode(roomPin, "UTF-8")
                    + "&deviceId=" + URLEncoder.encode(deviceId, "UTF-8");
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);

            if (conn.getResponseCode() != 200) return;
            String body = readStream(conn.getInputStream());
            JSONObject resp = new JSONObject(body);

            // 1. Sinkronisasi jadwal alarm dari server (pertahankan status fired lokal)
            if (resp.has("scheduledAlarms")) {
                JSONArray serverSchedules = resp.optJSONArray("scheduledAlarms");
                if (serverSchedules != null) {
                    Set<String> firedIds = getLocallyFiredIds(prefs.getString("schedulesJson", "[]"));
                    for (int i = 0; i < serverSchedules.length(); i++) {
                        JSONObject item = serverSchedules.optJSONObject(i);
                        if (item != null && firedIds.contains(item.optString("id", ""))) {
                            item.put("fired", true);
                        }
                    }
                    prefs.edit().putString("schedulesJson", serverSchedules.toString()).apply();
                }
            }

            // 2. Unduh audio kustom yang belum tersimpan di memori internal native
            if (resp.has("customAudios")) {
                JSONArray audios = resp.optJSONArray("customAudios");
                if (audios != null) {
                    for (int i = 0; i < audios.length(); i++) {
                        JSONObject audioObj = audios.optJSONObject(i);
                        String audioId = audioObj != null
                                ? audioObj.optString("id", audioObj.optString("audioId", ""))
                                : audios.optString(i, "");
                        if (!audioId.isEmpty()) {
                            ensureCustomAudioCached(serverUrl, roomId, roomPin, audioId);
                        }
                    }
                }
            }

            // 3. Cek pesan cepat / custom text terbaru
            JSONObject lastText = resp.optJSONObject("lastCustomText");
            if (lastText != null) {
                long ts = lastText.optLong("timestamp", 0L);
                String id = lastText.optString("id", String.valueOf(ts));
                String senderDev = lastText.optString("senderDeviceId", "");
                String sender = lastText.optString("sender", "Pasangan");
                String message = lastText.optString("message", "");
                if (!id.isEmpty()
                        && !id.equals(lastTextId)
                        && ts > 0
                        && (System.currentTimeMillis() - ts) < 120_000L
                        && ("simulasi".equals(role) || !deviceId.equals(senderDev))) {
                    lastTextId = id;
                    showCustomTextNotification(sender, message);
                }
            }

            // 4. Cek status alarm aktif dari server
            boolean isAlarmActive = resp.optBoolean("isAlarmActive", false);
            JSONObject cur = resp.optJSONObject("currentAlarm");
            if (isAlarmActive && cur != null) {
                String senderDev = cur.optString("senderDeviceId", "");
                boolean isMe = !"simulasi".equals(role) && !deviceId.isEmpty() && deviceId.equals(senderDev);
                String key = String.valueOf(cur.optLong("timestamp", cur.optLong("firedAt", 1L)));
                if (!isMe && !key.equals(activeAlarmKey) && !key.equals(lastStoppedAlarmKey)) {
                    String sender = cur.optString("sender", "Pasangan");
                    String message = cur.optString("message", "Waktunya bangun!");
                    String sound = cur.optString("sound", "siren");
                    String audioId = cur.optString("audioId", "");
                    if (!audioId.isEmpty()) {
                        ensureCustomAudioCached(serverUrl, roomId, roomPin, audioId);
                    }
                    triggerNativeAlarm(key, sender, message, sound, audioId);
                }
            } else if (!isAlarmActive && activeAlarmKey != null && !activeAlarmKey.startsWith("sched_")) {
                stopNativeMediaOnly();
                activeAlarmKey = null;
                NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (manager != null) {
                    manager.cancel(ALARM_NOTIFICATION_ID);
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private Set<String> getLocallyFiredIds(String schedulesJson) {
        Set<String> set = new HashSet<>();
        try {
            JSONArray arr = new JSONArray(schedulesJson);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.optJSONObject(i);
                if (item != null && item.optBoolean("fired", false)) {
                    String id = item.optString("id", "");
                    if (!id.isEmpty()) set.add(id);
                }
            }
        } catch (Exception ignored) {
        }
        return set;
    }

    private void ensureCustomAudioCached(String serverUrl, String roomId, String roomPin, String audioId) {
        String safeId = audioId.replaceAll("[^a-zA-Z0-9._-]", "_");
        File outFile = new File(getFilesDir(), "audio_" + safeId + ".mp3");
        if (outFile.exists() && outFile.length() > 0) return;

        HttpURLConnection conn = null;
        try {
            String urlStr = serverUrl + "/api/audio?roomId=" + URLEncoder.encode(roomId, "UTF-8")
                    + "&pin=" + URLEncoder.encode(roomPin, "UTF-8")
                    + "&audioId=" + URLEncoder.encode(audioId, "UTF-8");
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);

            if (conn.getResponseCode() != 200) return;
            JSONObject obj = new JSONObject(readStream(conn.getInputStream()));
            String dataUrl = obj.optString("voiceDataUrl", obj.optString("dataUrl", ""));
            if (dataUrl.isEmpty()) return;

            int commaIdx = dataUrl.indexOf(',');
            String b64 = commaIdx >= 0 ? dataUrl.substring(commaIdx + 1) : dataUrl;
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            try (FileOutputStream fos = new FileOutputStream(outFile)) {
                fos.write(bytes);
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private void showCustomTextNotification(String sender, String message) {
        try {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;

            Intent intent = new Intent(this, MainActivity.class);
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pendingIntent = PendingIntent.getActivity(
                    this,
                    2,
                    intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            NotificationCompat.Builder builder = new NotificationCompat.Builder(this, MESSAGE_CHANNEL_ID)
                    .setContentTitle("💬 Pesan dari " + sender)
                    .setContentText(message)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                    .setContentIntent(pendingIntent)
                    .setAutoCancel(true);

            manager.notify(MESSAGE_NOTIFICATION_ID, builder.build());
        } catch (Exception ignored) {
        }
    }

    private synchronized void triggerNativeAlarm(String key, String sender, String message, String sound, String audioId) {
        activeAlarmKey = key;

        // 1. Maksimalkan volume STREAM_ALARM & STREAM_MUSIC
        try {
            AudioManager audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (audioManager != null) {
                int maxAlarm = audioManager.getStreamMaxVolume(AudioManager.STREAM_ALARM);
                audioManager.setStreamVolume(AudioManager.STREAM_ALARM, maxAlarm, 0);
                int maxMusic = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, maxMusic, 0);
            }
        } catch (Exception ignored) {
        }

        // 2. Tampilkan notifikasi layar penuh (FullScreenIntent)
        Intent activityIntent = new Intent(this, MainActivity.class);
        activityIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        try {
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                PendingIntent pendingIntent = PendingIntent.getActivity(
                        this,
                        0,
                        activityIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                );

                NotificationCompat.Builder builder = new NotificationCompat.Builder(this, ALARM_CHANNEL_ID)
                        .setContentTitle("🚨 Alarm dari " + sender)
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
            }
        } catch (Exception ignored) {
        }

        // 3. Jika Activity sedang tertutup/di-swipe, bunyikan MediaPlayer native + Vibrator dan angkat Activity
        if (!MainActivity.isActivityVisible) {
            try {
                startActivity(activityIntent);
            } catch (Exception ignored) {
            }

            stopNativeMediaOnly();

            try {
                mediaPlayer = new MediaPlayer();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    mediaPlayer.setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build());
                } else {
                    mediaPlayer.setAudioStreamType(AudioManager.STREAM_ALARM);
                }

                boolean customLoaded = false;
                if (("tiktok".equals(sound) || "voice".equals(sound)) && audioId != null && !audioId.isEmpty()) {
                    String safeId = audioId.replaceAll("[^a-zA-Z0-9._-]", "_");
                    File customFile = new File(getFilesDir(), "audio_" + safeId + ".mp3");
                    if (customFile.exists() && customFile.length() > 0) {
                        try {
                            mediaPlayer.setDataSource(customFile.getAbsolutePath());
                            customLoaded = true;
                        } catch (Exception e) {
                            mediaPlayer.reset();
                        }
                    }
                }

                if (!customLoaded) {
                    File wavFile = new File(getCacheDir(), "native_siren.wav");
                    if (!wavFile.exists() || wavFile.length() == 0) {
                        writeSirenWav(wavFile);
                    }
                    mediaPlayer.setDataSource(wavFile.getAbsolutePath());
                }

                mediaPlayer.setLooping(true);
                mediaPlayer.prepare();
                mediaPlayer.start();
            } catch (Exception ignored) {
            }

            try {
                vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (vibrator != null && vibrator.hasVibrator()) {
                    long[] pattern = new long[] { 0, 800, 400, 800, 400, 1000 };
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
                    } else {
                        vibrator.vibrate(pattern, 0);
                    }
                }
            } catch (Exception ignored) {
            }
        }
    }

    private void writeSirenWav(File wavFile) throws Exception {
        int sampleRate = 22050;
        int numSamples = sampleRate * 2;
        int dataSize = numSamples * 2;
        ByteBuffer buf = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN);

        buf.put("RIFF".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(36 + dataSize);
        buf.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(16);
        buf.putShort((short) 1);
        buf.putShort((short) 1);
        buf.putInt(sampleRate);
        buf.putInt(sampleRate * 2);
        buf.putShort((short) 2);
        buf.putShort((short) 16);
        buf.put("data".getBytes(StandardCharsets.US_ASCII));
        buf.putInt(dataSize);

        double phase = 0.0;
        for (int i = 0; i < numSamples; i++) {
            double t = (double) i / sampleRate;
            double sweep = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * t));
            double freq = 650.0 + (1200.0 - 650.0) * sweep;
            phase += 2.0 * Math.PI * freq / sampleRate;
            buf.putShort((short) (Math.sin(phase) * 30000));
        }

        try (FileOutputStream fos = new FileOutputStream(wavFile)) {
            fos.write(buf.array());
        }
    }

    private static String normalizeServerUrl(String url) {
        if (url == null) return "";
        String trimmed = url.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed;
    }

    private static String readStream(InputStream is) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
        }
        return sb.toString();
    }

    private void acquireLocks() {
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
                wakeLock.acquire(24 * 60 * 60 * 1000L);
            }
        } catch (Exception ignored) {
        }

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
        } catch (Exception ignored) {
        }
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager == null) return;

            NotificationChannel keeperChannel = new NotificationChannel(
                    CHANNEL_ID,
                    "WakeMate Penjaga Alarm",
                    NotificationManager.IMPORTANCE_LOW
            );
            keeperChannel.setDescription("Menjaga koneksi alarm jarak jauh tetap aktif saat HP tidur");
            manager.createNotificationChannel(keeperChannel);

            NotificationChannel alarmChannel = new NotificationChannel(
                    ALARM_CHANNEL_ID,
                    "WakeMate Alarm",
                    NotificationManager.IMPORTANCE_HIGH
            );
            alarmChannel.setSound(null, null);
            alarmChannel.enableVibration(false);
            manager.createNotificationChannel(alarmChannel);

            NotificationChannel messageChannel = new NotificationChannel(
                    MESSAGE_CHANNEL_ID,
                    "WakeMate Pesan Pasangan",
                    NotificationManager.IMPORTANCE_HIGH
            );
            manager.createNotificationChannel(messageChannel);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        acquireLocks();
        startPollingLoop();
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        acquireLocks();
        try {
            Intent restartIntent = new Intent(this, WakeMateBootReceiver.class)
                    .setAction("com.bima.wakemate.RESTART_SERVICE");
            PendingIntent pi = PendingIntent.getBroadcast(
                    this,
                    1,
                    restartIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                long triggerAt = System.currentTimeMillis() + 1500L;
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi);
                    } else {
                        am.set(AlarmManager.RTC_WAKEUP, triggerAt, pi);
                    }
                } catch (Exception e) {
                    am.set(AlarmManager.RTC_WAKEUP, triggerAt, pi);
                }
            }
        } catch (Exception ignored) {
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (scheduler != null) {
            scheduler.shutdownNow();
            scheduler = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception ignored) {
            }
            wakeLock = null;
        }
        if (wifiLock != null && wifiLock.isHeld()) {
            try {
                wifiLock.release();
            } catch (Exception ignored) {
            }
            wifiLock = null;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
