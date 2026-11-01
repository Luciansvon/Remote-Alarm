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
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
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
    public static final String ACTION_STOP_ALARM = "com.bima.wakemate.STOP_ALARM";
    private static final String CHANNEL_ID = "wakemate_keeper_channel";
    public static final String ALARM_CHANNEL_ID = "wakemate_alarm_popup_v3";
    private static final String MESSAGE_CHANNEL_ID = "wakemate_message_channel";
    private static final int NOTIFICATION_ID = 1001;
    public static final int ALARM_NOTIFICATION_ID = 2001;
    private static final int MESSAGE_NOTIFICATION_ID = 2002;

    private static MediaPlayer mediaPlayer;
    private static Vibrator vibrator;
    private static volatile String activeAlarmKey = null;
    private static volatile String lastStoppedAlarmKey = null;
    private static volatile long activeAlarmStartedAt = 0L;
    private static volatile long lastStopTimestamp = 0L;
    private static volatile String lastTextId = null;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private ScheduledExecutorService scheduler;
    private final Set<String> audioDownloadsInProgress = Collections.synchronizedSet(new HashSet<>());
    private ExecutorService audioExecutor;

    public static String getLastStoppedAlarmKey() {
        return lastStoppedAlarmKey;
    }

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
        stopNativeAlarm(ctx, false);
    }

    public static synchronized void stopNativeAlarm(Context ctx, boolean forceServerStop) {
        boolean hadActiveNativeAlarm = (activeAlarmKey != null || mediaPlayer != null);
        lastStopTimestamp = System.currentTimeMillis();
        stopNativeMediaOnly();
        if (activeAlarmKey != null) {
            lastStoppedAlarmKey = activeAlarmKey;
            activeAlarmKey = null;
        }
        final String stoppedAlarmId = lastStoppedAlarmKey;
        if (ctx != null) {
            NotificationManager manager = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.cancel(ALARM_NOTIFICATION_ID);
            }
            if (!hadActiveNativeAlarm && !forceServerStop) return;
            final Context appCtx = ctx.getApplicationContext();
            new Thread(() -> {
                try {
                    SharedPreferences prefs = appCtx.getSharedPreferences(WakeMateNativePlugin.PREFS_NAME, Context.MODE_PRIVATE);
                    String serverUrl = normalizeServerUrl(prefs.getString("serverUrl", ""));
                    String roomId = prefs.getString("roomId", "");
                    String roomPin = prefs.getString("roomPin", "");
                    String role = prefs.getString("role", "Pasangan");
                    if (stoppedAlarmId != null) {
                        prefs.edit().putString("lastStoppedAlarmKey", stoppedAlarmId).apply();
                    }
                    if (serverUrl.isEmpty() || roomId.isEmpty() || roomPin.isEmpty()) return;

                    String stopperName = "bima".equalsIgnoreCase(role) ? "Bima" : ("pacar".equalsIgnoreCase(role) ? "Pacar" : role);
                    String urlStr = serverUrl + "/api/stop?roomId=" + URLEncoder.encode(roomId, "UTF-8")
                            + "&pin=" + URLEncoder.encode(roomPin, "UTF-8")
                            + "&stopper=" + URLEncoder.encode(stopperName.isEmpty() ? "Pasangan" : stopperName, "UTF-8")
                            + "&alarmId=" + URLEncoder.encode(stoppedAlarmId == null ? "" : stoppedAlarmId, "UTF-8");
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

    public static void ensureAlarmChannel(NotificationManager manager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel alarmChannel = new NotificationChannel(
                    ALARM_CHANNEL_ID,
                    "WakeMate Alarm Darurat",
                    NotificationManager.IMPORTANCE_HIGH
            );
            alarmChannel.setDescription("Pop-up alarm darurat dengan tombol Aku Udah Bangun Sayang");
            alarmChannel.setSound(null, null);
            alarmChannel.enableVibration(true);
            alarmChannel.setVibrationPattern(new long[] { 0, 500, 250, 500 });
            alarmChannel.setBypassDnd(true);
            alarmChannel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            manager.createNotificationChannel(alarmChannel);
        }
    }

    public static void postAlarmPopupNotification(Context ctx, String title, String message) {
        try {
            NotificationManager manager = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            ensureAlarmChannel(manager);

            Intent activityIntent = new Intent(ctx, MainActivity.class);
            activityIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pendingIntent = PendingIntent.getActivity(
                    ctx,
                    0,
                    activityIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Intent stopIntent = new Intent(ctx, WakeMateBootReceiver.class)
                    .setAction(ACTION_STOP_ALARM);
            PendingIntent stopPendingIntent = PendingIntent.getBroadcast(
                    ctx,
                    2001,
                    stopIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            NotificationCompat.Builder builder = new NotificationCompat.Builder(ctx, ALARM_CHANNEL_ID)
                    .setContentTitle(title)
                    .setContentText(message)
                    .setStyle(new NotificationCompat.BigTextStyle().bigText(message))
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setDefaults(NotificationCompat.DEFAULT_VIBRATE | NotificationCompat.DEFAULT_LIGHTS)
                    .setContentIntent(pendingIntent)
                    .setOngoing(true)
                    .setAutoCancel(false)
                    .addAction(android.R.drawable.ic_lock_idle_alarm, "✅ Aku Udah Bangun Sayang", stopPendingIntent);

            manager.notify(ALARM_NOTIFICATION_ID, builder.build());
        } catch (Exception ignored) {
        }
    }

    public static synchronized void startNativeMedia(Context ctx, String sound, String audioId) {
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
                File customFile = new File(ctx.getFilesDir(), "audio_" + safeId + ".mp3");
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
                File wavFile = new File(ctx.getCacheDir(), "native_siren.wav");
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
            vibrator = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
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

    public static synchronized void showOrTriggerFromPlugin(
            Context ctx,
            String key,
            String title,
            String message,
            String sound,
            String audioId
    ) {
        if (key != null && !key.isEmpty()) {
            activeAlarmKey = key;
            activeAlarmStartedAt = System.currentTimeMillis();
        }
        postAlarmPopupNotification(ctx, title, message);
        if (MainActivity.isActivityVisible) {
            stopNativeMediaOnly();
        } else {
            startNativeMedia(ctx, sound, audioId);
        }
    }

    public static void onActivityResumed(Context ctx) {
        // Media tetap berbunyi sampai WebView memanggil showAlarmNotification atau stopAlarmNotification
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
        // Bertahan setelah proses dibunuh: jangan bunyikan ulang alarm yang sudah dihentikan.
        if (lastStoppedAlarmKey == null) {
            lastStoppedAlarmKey = getSharedPreferences(WakeMateNativePlugin.PREFS_NAME, Context.MODE_PRIVATE)
                    .getString("lastStoppedAlarmKey", null);
        }
        if (audioExecutor == null) {
            audioExecutor = Executors.newSingleThreadExecutor();
        }

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
        if (System.currentTimeMillis() - lastStopTimestamp < 5000L) return;
        try {
            JSONArray arr = new JSONArray(schedulesJson);
            long now = System.currentTimeMillis();
            boolean modified = false;
            String myName = "bima".equalsIgnoreCase(role) ? "Bima" : "Pacar";

            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.optJSONObject(i);
                if (item == null) continue;
                boolean fired = item.optBoolean("fired", false);
                long triggerTime = item.optLong("triggerTime", 0L);
                if (!fired && triggerTime > 0 && now >= triggerTime && (now - triggerTime) < 300_000L) {
                    String senderDev = item.optString("senderDeviceId", "");
                    String target = item.optString("target", item.optString("targetName", ""));
                    boolean isSender = !"simulasi".equalsIgnoreCase(role)
                            && !deviceId.isEmpty()
                            && deviceId.equals(senderDev)
                            && !myName.equalsIgnoreCase(target);
                    item.put("fired", true);
                    modified = true;

                    if (!isSender) {
                        String key = item.optString("id", String.valueOf(triggerTime));
                        if (!key.equals(activeAlarmKey) && !key.equals(lastStoppedAlarmKey)) {
                            String sender = item.optString("creator", item.optString("sender", "Pasangan"));
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
                if (serverSchedules == null) serverSchedules = new JSONArray();
                JSONArray localSchedules = new JSONArray(prefs.getString("schedulesJson", "[]"));
                Set<String> firedIds = new HashSet<>();
                Set<String> serverIds = new HashSet<>();
                Set<String> deletedIds = new HashSet<>();

                for (int i = 0; i < localSchedules.length(); i++) {
                    JSONObject local = localSchedules.optJSONObject(i);
                    if (local != null && local.optBoolean("fired", false)) {
                        String id = local.optString("id", "");
                        if (!id.isEmpty()) firedIds.add(id);
                    }
                }
                JSONArray deleted = resp.optJSONArray("deletedScheduleIds");
                if (deleted != null) {
                    for (int i = 0; i < deleted.length(); i++) {
                        deletedIds.add(deleted.optString(i, ""));
                    }
                }
                for (int i = 0; i < serverSchedules.length(); i++) {
                    JSONObject item = serverSchedules.optJSONObject(i);
                    if (item == null) continue;
                    String id = item.optString("id", "");
                    if (!id.isEmpty()) serverIds.add(id);
                    if (firedIds.contains(id)) item.put("fired", true);
                }
                // Jadwal yang dibuat saat offline belum ada di server: jangan dibuang.
                long now = System.currentTimeMillis();
                for (int i = 0; i < localSchedules.length(); i++) {
                    JSONObject local = localSchedules.optJSONObject(i);
                    if (local == null) continue;
                    String id = local.optString("id", "");
                    if (id.isEmpty() || serverIds.contains(id) || deletedIds.contains(id)) continue;
                    if (local.optBoolean("fired", false)) continue;
                    if (local.optLong("triggerTime", 0L) < now - 300_000L) continue;
                    serverSchedules.put(local);
                }
                prefs.edit().putString("schedulesJson", serverSchedules.toString()).apply();
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
            long lastStoppedAt = resp.optLong("lastStoppedAt", 0L);
            JSONObject cur = resp.optJSONObject("currentAlarm");
            if (isAlarmActive && cur != null && (System.currentTimeMillis() - lastStopTimestamp >= 5000L)) {
                String senderDev = cur.optString("senderDeviceId", "");
                String target = cur.optString("target", cur.optString("targetName", ""));
                String myName = "bima".equalsIgnoreCase(role) ? "Bima" : "Pacar";
                boolean isMe = !"simulasi".equalsIgnoreCase(role)
                        && !deviceId.isEmpty()
                        && deviceId.equals(senderDev)
                        && !myName.equalsIgnoreCase(target);
                String key = cur.optString("id", String.valueOf(cur.optLong("timestamp", cur.optLong("firedAt", 1L))));
                if (!isMe && !key.equals(activeAlarmKey) && !key.equals(lastStoppedAlarmKey)) {
                    String sender = cur.optString("sender", cur.optString("creator", "Pasangan"));
                    String message = cur.optString("message", "Waktunya bangun!");
                    String sound = cur.optString("sound", "siren");
                    String audioId = cur.optString("audioId", "");
                    if (!audioId.isEmpty()) {
                        ensureCustomAudioCached(serverUrl, roomId, roomPin, audioId);
                    }
                    triggerNativeAlarm(key, sender, message, sound, audioId);
                }
            } else if (!isAlarmActive && activeAlarmKey != null) {
                long elapsed = System.currentTimeMillis() - activeAlarmStartedAt;
                // 10 menit, bukan 15 detik: jam HP yang lebih cepat bisa memicu jadwal lokal
                // sebelum server sempat menandai alarm aktif.
                if (lastStoppedAt >= activeAlarmStartedAt || elapsed > 600_000L) {
                    lastStoppedAlarmKey = activeAlarmKey;
                    activeAlarmKey = null;
                    prefs.edit().putString("lastStoppedAlarmKey", lastStoppedAlarmKey).apply();
                    stopNativeMediaOnly();
                    NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                    if (manager != null) {
                        manager.cancel(ALARM_NOTIFICATION_ID);
                    }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private void ensureCustomAudioCached(final String serverUrl, final String roomId, final String roomPin, final String audioId) {
        final String safeId = audioId.replaceAll("[^a-zA-Z0-9._-]", "_");
        final File outFile = new File(getFilesDir(), "audio_" + safeId + ".mp3");
        if (outFile.exists() && outFile.length() > 0) return;
        if (!audioDownloadsInProgress.add(audioId)) return;
        if (audioExecutor == null) {
            audioDownloadsInProgress.remove(audioId);
            return;
        }

        // Unduh di thread terpisah: file audio besar tidak boleh memblokir cek jadwal alarm.
        audioExecutor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                String urlStr = serverUrl + "/api/audio?roomId=" + URLEncoder.encode(roomId, "UTF-8")
                        + "&pin=" + URLEncoder.encode(roomPin, "UTF-8")
                        + "&audioId=" + URLEncoder.encode(audioId, "UTF-8");
                conn = (HttpURLConnection) new URL(urlStr).openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(30000);

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
                audioDownloadsInProgress.remove(audioId);
            }
        });
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
        activeAlarmStartedAt = System.currentTimeMillis();

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

        // 2. Tampilkan notifikasi pop-up di depan layar dengan tombol "Aku Udah Bangun Sayang"
        postAlarmPopupNotification(this, "🚨 Alarm dari " + sender, message);

        // 3. Jika Activity sedang tertutup/di-swipe, nyalakan layar agar notifikasi
        //    dengan tombol "Aku Udah Bangun Sayang" langsung terlihat, lalu bunyikan
        //    MediaPlayer native + Vibrator tanpa membuka aplikasi.
        if (!MainActivity.isActivityVisible) {
            wakeScreenForAlarm();
            startNativeMedia(this, sound, audioId);
        }
    }

    private void wakeScreenForAlarm() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null || pm.isInteractive()) return;
            PowerManager.WakeLock screenLock = pm.newWakeLock(
                    PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                            | PowerManager.ACQUIRE_CAUSES_WAKEUP
                            | PowerManager.ON_AFTER_RELEASE,
                    "WakeMate::AlarmScreen");
            screenLock.acquire(15000L);
        } catch (Exception ignored) {
        }
    }

    private static void writeSirenWav(File wavFile) throws Exception {
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

            ensureAlarmChannel(manager);

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
        if (audioExecutor != null) {
            audioExecutor.shutdownNow();
            audioExecutor = null;
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
