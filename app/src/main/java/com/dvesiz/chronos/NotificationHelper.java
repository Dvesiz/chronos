package com.dvesiz.chronos;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.Icon;
import android.os.Build;

/** 通知渠道与通知构建 */
public final class NotificationHelper {

    public static final String CH_START = "chronos_start";
    public static final String CH_ADVANCE = "chronos_advance";

    private NotificationHelper() {}

    public static void ensureChannels(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        NotificationChannel start = new NotificationChannel(
                CH_START, "任务开始提醒", NotificationManager.IMPORTANCE_HIGH);
        start.setDescription("到点提醒你开始当前的学习任务");
        start.enableVibration(true);
        start.setVibrationPattern(new long[]{0, 110, 70, 110});
        start.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        start.setShowBadge(true);
        nm.createNotificationChannel(start);

        NotificationChannel advance = new NotificationChannel(
                CH_ADVANCE, "提前提醒", NotificationManager.IMPORTANCE_DEFAULT);
        advance.setDescription("任务开始前几分钟的轻声提示");
        advance.setSound(null, null);
        advance.enableVibration(false);
        advance.setShowBadge(false);
        nm.createNotificationChannel(advance);
    }

    public static boolean notificationsEnabled(Context c) {
        if (Build.VERSION.SDK_INT >= 33 &&
                c.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                        != PackageManager.PERMISSION_GRANTED) {
            return false;
        }
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        return nm != null && nm.areNotificationsEnabled();
    }

    public static void showReminder(Context c, Intent src) {
        ensureChannels(c);

        String title = src.getStringExtra("title");
        String subject = src.getStringExtra("subject");
        String taskId = src.getStringExtra("taskId");
        String date = src.getStringExtra("date");
        int start = src.getIntExtra("start", 0);
        int end = src.getIntExtra("end", 0);
        int kind = src.getIntExtra("kind", 0);
        int notifId = src.getIntExtra("notifId", (int) (System.currentTimeMillis() % 100000));

        if (title == null) title = "学习任务";
        String range = hm(start) + " — " + hm(end);
        String text = range + (subject == null || subject.isEmpty() ? "" : " · " + subject);

        String mainTitle = kind == 1 ? (title + " · 即将开始") : (title + " 该开始了");
        String big = kind == 1
                ? "还有几分钟，先收拾桌面、准备好资料。\n" + text
                : "现在开始这一段专注。\n" + text;

        // 三条动作意图都带上 date 与 notifId：date 用于跨零点定位任务，notifId 用于点击后消除本条通知
        Intent content = new Intent(c, MainActivity.class);
        content.setAction("com.dvesiz.chronos.OPEN_" + notifId);
        content.putExtra("taskId", taskId);
        content.putExtra("date", date);
        content.putExtra("action", "open");
        content.putExtra("notifId", notifId);
        content.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentPi = pi(c, notifId + 10, content);

        Intent startI = new Intent(c, MainActivity.class);
        startI.setAction("com.dvesiz.chronos.START_" + notifId);
        startI.putExtra("taskId", taskId);
        startI.putExtra("date", date);
        startI.putExtra("action", "start");
        startI.putExtra("notifId", notifId);
        startI.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent startPi = pi(c, notifId + 11, startI);

        Intent delayI = new Intent(c, MainActivity.class);
        delayI.setAction("com.dvesiz.chronos.DELAY_" + notifId);
        delayI.putExtra("taskId", taskId);
        delayI.putExtra("date", date);
        delayI.putExtra("action", "delay");
        delayI.putExtra("notifId", notifId);
        delayI.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent delayPi = pi(c, notifId + 12, delayI);

        Intent doneI = new Intent(c, ReminderReceiver.class);
        doneI.setAction(ReminderReceiver.ACTION_COMPLETE);
        doneI.putExtra("taskId", taskId);
        doneI.putExtra("date", date);
        doneI.putExtra("notifId", notifId);
        PendingIntent donePi = piBroadcast(c, notifId + 13, doneI);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(c, kind == 1 ? CH_ADVANCE : CH_START)
                : new Notification.Builder(c);

        b.setSmallIcon(R.drawable.ic_stat_chronos)
                .setColor(0xFF4B7BFF)
                .setContentTitle(mainTitle)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(big))
                .setCategory(Notification.CATEGORY_REMINDER)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setAutoCancel(true)
                .setContentIntent(contentPi)
                .setShowWhen(false);

        if (Build.VERSION.SDK_INT >= 23) {
            b.addAction(new Notification.Action.Builder(
                    Icon.createWithResource(c, R.drawable.ic_notif_play), "开始专注", startPi).build());
            b.addAction(new Notification.Action.Builder(
                    Icon.createWithResource(c, R.drawable.ic_notif_later), "延后 10 分钟", delayPi).build());
            b.addAction(new Notification.Action.Builder(
                    Icon.createWithResource(c, R.drawable.ic_notif_check), "完成", donePi).build());
        }

        Notification n = b.build();
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            try {
                nm.notify(notifId, n);
            } catch (SecurityException ignored) {
            }
        }
    }

    /**
     * 专注段结束提示。
     * 由 FocusGuardService 在 endAt 到点时调用——WebView 在息屏/后台会被冻结，
     * 纯 JS 的 tickPomo 无法保证准点响铃，这条通知是兜底。
     */
    public static void notifySessionEnd(Context c, String title, int minutes) {
        ensureChannels(c);
        String name = (title == null || title.trim().isEmpty()) ? "专注" : title.trim();
        int id = 800 + Math.abs((name + minutes).hashCode() % 100);

        Intent content = new Intent(c, MainActivity.class);
        content.setAction("com.dvesiz.chronos.SESSION_END_" + id);
        content.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);

        Notification.Builder b = new Notification.Builder(c, CH_START)
                .setSmallIcon(R.drawable.ic_stat_chronos)
                .setColor(0xFFFF5A1F)
                .setContentTitle("这一轮结束了")
                .setContentText(name + " · " + minutes + " 分钟，站起来走两步")
                .setStyle(new Notification.BigTextStyle().bigText(
                        "这一轮结束了\n" + name + " · " + minutes + " 分钟。\n记一句复盘，再决定下一段。"))
                .setCategory(Notification.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setContentIntent(pi(c, id + 1, content))
                .setShowWhen(false);

        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            try {
                nm.notify(id, b.build());
            } catch (SecurityException ignored) {
            }
        }
    }

    private static PendingIntent pi(Context c, int code, Intent intent) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(c, code, intent, flags);
    }

    private static PendingIntent piBroadcast(Context c, int code, Intent intent) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(c, code, intent, flags);
    }

    private static String hm(int minutes) {
        if (minutes < 0) minutes = 0;
        return String.format(java.util.Locale.US, "%02d:%02d", minutes / 60 % 24, minutes % 60);
    }
}
