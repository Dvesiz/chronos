package com.dvesiz.chronos;

import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONObject;

/** 接收闹钟事件并弹出系统通知；也处理通知上的「完成」动作。 */
public class ReminderReceiver extends BroadcastReceiver {

    public static final String ACTION_COMPLETE = "com.dvesiz.chronos.COMPLETE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();

        if (ACTION_COMPLETE.equals(action)) {
            String taskId = intent.getStringExtra("taskId");
            String date = intent.getStringExtra("date");
            int notifId = intent.getIntExtra("notifId", -1);

            if (taskId != null && date != null) {
                markDone(context, date, taskId);
                AlarmScheduler.cancelTask(context, date, taskId);
            }
            if (notifId >= 0) {
                NotificationManager nm = (NotificationManager)
                        context.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.cancel(notifId);
            }
            return;
        }

        NotificationHelper.showReminder(context, intent);
    }

    private void markDone(Context context, String date, String taskId) {
        SharedPreferences sp = context.getSharedPreferences("chronos", Context.MODE_PRIVATE);
        try {
            JSONObject root = new JSONObject(sp.getString("overlay", "{}"));
            JSONObject day = root.optJSONObject(date);
            if (day == null) day = new JSONObject();
            day.put(taskId, "done");
            root.put(date, day);

            // 同步 payload：否则 BootReceiver.rebuildFromStore 会用旧数据把这条提醒重新排上
            JSONObject payload = new JSONObject(sp.getString("payload", "{}"));
            org.json.JSONArray days = payload.optJSONArray("days");
            for (int d = 0; days != null && d < days.length(); d++) {
                JSONObject pd = days.getJSONObject(d);
                if (!date.equals(pd.optString("date"))) continue;
                org.json.JSONArray tasks = pd.optJSONArray("tasks");
                for (int i = 0; tasks != null && i < tasks.length(); i++) {
                    JSONObject t = tasks.getJSONObject(i);
                    if (taskId.equals(t.optString("id"))) t.put("status", "done");
                }
            }
            sp.edit().putString("overlay", root.toString())
                    .putString("payload", payload.toString()).apply();
        } catch (Exception e) {
            android.util.Log.w("Chronos", "markDone failed", e);
        }
    }
}
