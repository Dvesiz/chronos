package com.dvesiz.chronos;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;

/**
 * 依据前端下发的 7 天计划，重建 AlarmManager 精确提醒。
 * 每次全量重建，避免任务修改后出现重复 / 过期提醒。
 */
public final class AlarmScheduler {

    private static final String PREF = "chronos";
    private static final String KEY_PAYLOAD = "payload";
    private static final String KEY_CODES = "codes";
    private static final String ACTION = "com.dvesiz.chronos.REMIND";
    private static final String TAG = "Chronos";
    /** 关机 / Doze / 改时钟跨过的提醒，这个窗口内补发一次 */
    private static final long CATCH_UP_MS = 10 * 60 * 1000L;

    private AlarmScheduler() {}

    public static void saveAndSchedule(Context ctx, String json) {
        SharedPreferences sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
        sp.edit().putString(KEY_PAYLOAD, json).apply();
        rebuild(ctx, json);
    }

    public static void rebuildFromStore(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
        String json = sp.getString(KEY_PAYLOAD, null);
        if (json != null) rebuild(ctx, json);
    }

    public static boolean canExact(Context ctx) {
        if (Build.VERSION.SDK_INT >= 31) {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            return am != null && am.canScheduleExactAlarms();
        }
        return true;
    }

    private static void rebuild(Context ctx, String json) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        cancelAll(ctx, am);

        List<JSONObject> scheduled = new ArrayList<>();
        long now = System.currentTimeMillis();

        JSONObject root;
        try {
            root = new JSONObject(json);
        } catch (Exception e) {
            Log.w(TAG, "payload 无法解析，本轮不排程", e);
            writeCodes(ctx, scheduled);
            return;
        }
        JSONArray days = root.optJSONArray("days");
        if (days == null) {
            writeCodes(ctx, scheduled);
            return;
        }

        // 按天隔离：某一天的数据坏掉，不应该连带其余 6 天都不排程
        for (int d = 0; d < days.length(); d++) {
            try {
                scheduleDay(ctx, am, days.getJSONObject(d), now, scheduled);
            } catch (Exception e) {
                Log.w(TAG, "第 " + (d + 1) + " 天排程失败，已跳过", e);
            }
        }

        writeCodes(ctx, scheduled);
    }

    private static void scheduleDay(Context ctx, AlarmManager am, JSONObject day,
                                    long now, List<JSONObject> scheduled) {
        String date = day.optString("date");
        int[] ymd = parseDate(date);
        if (ymd == null) return;

        Calendar cal = Calendar.getInstance();
        cal.set(ymd[0], ymd[1] - 1, ymd[2], 0, 0, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long dayStart = cal.getTimeInMillis();

        JSONArray tasks = day.optJSONArray("tasks");
        if (tasks == null) return;

        for (int i = 0; i < tasks.length(); i++) {
            JSONObject t;
            try {
                t = tasks.getJSONObject(i);
            } catch (Exception e) {
                continue;
            }
            String id = t.optString("id");
            String status = t.optString("status", "todo");
            if ("done".equals(status) || "skipped".equals(status)) continue;
            if (!t.optBoolean("reminder", true)) continue;

            int start = t.optInt("start", -1);
            int end = t.optInt("end", -1);
            int advance = t.optInt("advance", 0);
            if (start < 0 || id.isEmpty()) continue;

            long trigger = dayStart + start * 60000L;
            if (trigger <= now) {
                // 已经过点了：10 分钟内补发一次（开机、Doze 结束、改时间都能救回来），
                // 超过 10 分钟就不打扰了
                if (trigger > now - CATCH_UP_MS) {
                    trigger = now + 2000L;
                } else {
                    continue;
                }
            }

            if (advance > 0) {
                long advTime = (dayStart + start * 60000L) - advance * 60000L;
                if (advTime > now + 3000L && advTime < trigger) {
                    int advCode = code(date, id, 1);
                    if (schedule(ctx, am, advCode, advTime, t, date, id, 1, start, end)) {
                        scheduled.add(entry(advCode, date, id, 1));
                    }
                }
            }

            int code = code(date, id, 0);
            if (schedule(ctx, am, code, trigger, t, date, id, 0, start, end)) {
                scheduled.add(entry(code, date, id, 0));
            }
        }
    }

    private static void writeCodes(Context ctx, List<JSONObject> scheduled) {
        JSONArray arr = new JSONArray();
        for (JSONObject o : scheduled) arr.put(o);
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                .edit().putString(KEY_CODES, arr.toString()).apply();
    }

    private static boolean schedule(Context ctx, AlarmManager am, int code, long time,
                                    JSONObject task, String date, String id,
                                    int kind, int start, int end) {
        Intent intent = new Intent(ctx, ReminderReceiver.class);
        intent.setAction(ACTION);
        intent.putExtra("taskId", id);
        intent.putExtra("date", date);
        intent.putExtra("kind", kind);
        intent.putExtra("title", task.optString("title", "学习任务"));
        intent.putExtra("subject", task.optString("subject", ""));
        intent.putExtra("start", start);
        intent.putExtra("end", end);
        intent.putExtra("notifId", code);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(ctx, code, intent, flags);

        try {
            if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, time, pi);
            } else if (Build.VERSION.SDK_INT >= 23) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, time, pi);
            } else {
                am.setExact(AlarmManager.RTC_WAKEUP, time, pi);
            }
            return true;
        } catch (SecurityException e) {
            Log.w(TAG, "精确闹钟被拒，降级为非精确闹钟", e);
            try {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, time, pi);
                return true;
            } catch (Exception e2) {
                Log.w(TAG, "排程失败 code=" + code, e2);
                return false;
            }
        } catch (Exception e) {
            Log.w(TAG, "排程失败 code=" + code, e);
            return false;
        }
    }

    private static void cancelAll(Context ctx, AlarmManager am) {
        SharedPreferences sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
        try {
            JSONArray arr = new JSONArray(sp.getString(KEY_CODES, "[]"));
            for (int i = 0; i < arr.length(); i++) {
                cancelByCode(ctx, am, arr.getJSONObject(i).optInt("code", -1));
            }
        } catch (Exception e) {
            Log.w(TAG, "取消历史闹钟失败", e);
        }
        sp.edit().putString(KEY_CODES, "[]").apply();
    }

    /**
     * 按 requestCode 取消一条闹钟。
     * 用 FLAG_NO_CREATE 而不是 UPDATE_CURRENT：后者"有则更新、无则创建"，
     * 会把根本不存在的提醒建成一个空壳再取消掉，且让"是否真的命中"无法验证。
     */
    private static void cancelByCode(Context ctx, AlarmManager am, int code) {
        if (code < 0) return;
        Intent intent = new Intent(ctx, ReminderReceiver.class);
        intent.setAction(ACTION);
        int flags = PendingIntent.FLAG_NO_CREATE;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getBroadcast(ctx, code, intent, flags);
        if (pi == null) return;
        am.cancel(pi);
        pi.cancel();
    }

    public static void cancelTask(Context ctx, String date, String taskId) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        SharedPreferences sp = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
        try {
            JSONArray arr = new JSONArray(sp.getString(KEY_CODES, "[]"));
            JSONArray keep = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                if (date.equals(o.optString("date")) && taskId.equals(o.optString("id"))) {
                    cancelByCode(ctx, am, o.optInt("code", -1));
                } else {
                    keep.put(o);
                }
            }
            sp.edit().putString(KEY_CODES, keep.toString()).apply();
        } catch (Exception e) {
            Log.w(TAG, "取消单个任务提醒失败", e);
        }
    }

    private static int code(String date, String id, int kind) {
        return Math.abs((date + "|" + id + "|" + kind).hashCode() % 1000000000);
    }

    private static JSONObject entry(int code, String date, String id, int kind) {
        JSONObject o = new JSONObject();
        try {
            o.put("code", code);
            o.put("date", date);
            o.put("id", id);
            o.put("kind", kind);
        } catch (Exception ignored) {
        }
        return o;
    }

    private static int[] parseDate(String s) {
        try {
            String[] p = s.split("-");
            if (p.length != 3) return null;
            return new int[]{Integer.parseInt(p[0]), Integer.parseInt(p[1]), Integer.parseInt(p[2])};
        } catch (Exception e) {
            return null;
        }
    }
}
