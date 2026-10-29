package com.bima.wakemate;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public class WakeMateBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null) return;
        String action = intent != null ? intent.getAction() : null;
        if (WakeMateKeeperService.ACTION_STOP_ALARM.equals(action)) {
            WakeMateKeeperService.stopNativeAlarm(context, true);
            WakeMateNativePlugin.notifyAlarmStoppedFromNative();
            return;
        }
        try {
            Intent svcIntent = new Intent(context, WakeMateKeeperService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(svcIntent);
            } else {
                context.startService(svcIntent);
            }
        } catch (Exception ignored) {
        }
    }
}
