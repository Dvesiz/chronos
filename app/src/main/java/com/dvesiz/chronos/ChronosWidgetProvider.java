package com.dvesiz.chronos;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.view.View;
import android.widget.RemoteViews;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * 2×2 桌面小组件：显示今日进度、下一项任务、考试倒计时，并支持一键开始。
 * 数据直接用 AlarmScheduler 存在 SharedPreferences 里的 7 天 payload，
 * 不再额外维护一份状态；系统每 30 分钟会拉起一次 onUpdate 兜底。
 */
public class ChronosWidgetProvider extends AppWidgetProvider {

    private static final String ACTION_REFRESH = "com.dvesiz.chronos.WIDGET_REFRESH";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        for (int id : ids) update(context, manager, id);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (intent != null && ACTION_REFRESH.equals(intent.getAction())) refresh(context);
    }

    /** 应用内数据变化时调用 */
    public static void refresh(Context context) {
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(context);
            int[] ids = manager.getAppWidgetIds(new ComponentName(context, ChronosWidgetProvider.class));
            for (int id : ids) update(context, manager, id);
        } catch (Exception ignored) {
        }
    }

    private static void update(Context context, AppWidgetManager manager, int widgetId) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_chronos);
        SharedPreferences sp = context.getSharedPreferences("chronos", Context.MODE_PRIVATE);

        String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        JSONArray tasks = null;
        String examLabel = null;
        int examDays = -1;

        try {
            JSONObject root = new JSONObject(sp.getString("payload", "{}"));
            JSONArray days = root.optJSONArray("days");
            for (int i = 0; days != null && i < days.length(); i++) {
                JSONObject day = days.getJSONObject(i);
                if (today.equals(day.optString("date"))) {
                    tasks = day.optJSONArray("tasks");
                    break;
                }
            }
            JSONObject exam = root.optJSONObject("exam");
            if (exam != null && exam.optString("date").length() >= 10) {
                examLabel = exam.optString("label", "考研");
                Date target = new SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(exam.optString("date"));
                if (target != null) {
                    Calendar start = Calendar.getInstance();
                    start.set(Calendar.HOUR_OF_DAY, 0);
                    start.set(Calendar.MINUTE, 0);
                    start.set(Calendar.SECOND, 0);
                    start.set(Calendar.MILLISECOND, 0);
                    examDays = (int) Math.round((target.getTime() - start.getTimeInMillis()) / 86400000.0);
                }
            }
        } catch (Exception ignored) {
        }

        Calendar cal = Calendar.getInstance();
        int now = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);
        int done = 0, total = 0;
        JSONObject current = null, next = null;
        int nextStart = Integer.MAX_VALUE;

        try {
            for (int i = 0; tasks != null && i < tasks.length(); i++) {
                JSONObject t = tasks.getJSONObject(i);
                total++;
                String status = t.optString("status", "todo");
                if ("done".equals(status)) { done++; continue; }
                if ("skipped".equals(status)) continue;
                int start = t.optInt("start", -1);
                int end = t.optInt("end", -1);
                if (start < 0) continue;
                if (start <= now && now < end) {
                    if (current == null) current = t;
                } else if (start > now && start < nextStart) {
                    nextStart = start;
                    next = t;
                }
            }
        } catch (Exception ignored) {
        }

        JSONObject target = current != null ? current : next;

        views.setTextViewText(R.id.widget_progress, total == 0
                ? "打开时序同步计划"
                : "已完成 " + done + " / " + total);

        if (target != null) {
            String subject = target.optString("subject", "");
            String label = (current != null ? "进行中 · " : "下一项 · ") + hm(target.optInt("start", 0))
                    + (subject.isEmpty() ? "" : " " + subject);
            views.setTextViewText(R.id.widget_next_label, label);
            views.setTextViewText(R.id.widget_next_title, target.optString("title", "学习任务"));
        } else {
            views.setTextViewText(R.id.widget_next_label, total > 0 ? "今天" : " ");
            views.setTextViewText(R.id.widget_next_title, total > 0 ? "安排走完了，休息一下" : "还没有今日计划");
        }

        if (examDays >= 0) {
            views.setTextViewText(R.id.widget_exam, "距" + (examLabel == null ? "考研" : examLabel) + " " + examDays + " 天");
            views.setViewVisibility(R.id.widget_exam, View.VISIBLE);
        } else {
            views.setViewVisibility(R.id.widget_exam, View.GONE);
        }

        Intent open = new Intent(context, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPi = PendingIntent.getActivity(context, 1001, open, piFlags());
        views.setOnClickPendingIntent(R.id.widget_root, openPi);

        if (target != null) {
            String taskId = target.optString("id", "");
            Intent start = new Intent(context, MainActivity.class);
            start.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            start.setAction("com.dvesiz.chronos.WIDGET_START_" + taskId);
            start.putExtra("taskId", taskId);
            start.putExtra("date", today);
            start.putExtra("action", "start");
            PendingIntent startPi = PendingIntent.getActivity(context, 1002, start, piFlags());
            views.setOnClickPendingIntent(R.id.widget_btn, startPi);
            views.setTextViewText(R.id.widget_btn, "开始专注");
        } else {
            views.setOnClickPendingIntent(R.id.widget_btn, openPi);
            views.setTextViewText(R.id.widget_btn, "打开时序");
        }

        manager.updateAppWidget(widgetId, views);
    }

    private static int piFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (android.os.Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return flags;
    }

    private static String hm(int minutes) {
        if (minutes < 0) minutes = 0;
        return String.format(Locale.US, "%02d:%02d", minutes / 60 % 24, minutes % 60);
    }
}
