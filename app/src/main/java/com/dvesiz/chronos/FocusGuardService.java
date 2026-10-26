package com.dvesiz.chronos;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.graphics.PixelFormat;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

import java.util.HashSet;
import java.util.Set;

/**
 * 极度沉浸守护：
 * 专注期间运行的前台服务。通过使用情况访问识别前台应用，
 * 一旦切到无关应用，立即用全屏悬浮窗把它盖住——这是一种真正生效的拦截，
 * 因为 Android 10+ 已禁止后台启动 Activity，只有悬浮窗能盖在其它应用之上。
 */
public class FocusGuardService extends Service implements LockPanel.Listener {

    public static final String CH_GUARD = "chronos_guard";
    private static final int NOTIF_ID = 900;
    private static final long POLL_MS = 1500;
    private static final String PKG_SYSTEMUI = "com.android.systemui";

    /** 轮询跑在独立线程：queryEvents 是跨进程查询，放主线程会造成周期性掉帧 */
    private HandlerThread pollThread;
    private Handler handler;
    private Handler mainHandler;
    private volatile String desiredBlock = null;
    private static volatile boolean running = false;
    private UsageStatsManager usm;
    private WindowManager wm;
    private LockPanel panel;
    private long endAt = 0L;
    private long durMs = 25 * 60 * 1000L;
    private String sessionTitle = "";
    private int sessionMinutes = 25;
    private String blockedPkg = null;
    private String lastFgPkg = null;
    private long lastFgTs = 0L;
    /** 点了「回到 Chronos」之后的短暂宽限期，避免遮罩又盖住正在启动的应用 */
    private long skipShowUntil = 0L;
    private final Set<String> whitelist = new HashSet<>();

    @Override
    public void onCreate() {
        super.onCreate();
        usm = (UsageStatsManager) getSystemService(Context.USAGE_STATS_SERVICE);
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        mainHandler = new Handler(Looper.getMainLooper());
        pollThread = new HandlerThread("chronos-guard");
        pollThread.start();
        handler = new Handler(pollThread.getLooper());
        buildWhitelist();
        running = true;
    }

    /** 供 JS 侧判断"守护是不是还活着"，避免界面显示"屏蔽中"而服务已被回收 */
    public static boolean isRunning() {
        return running;
    }

    private void buildWhitelist() {
        whitelist.clear();
        whitelist.add(getPackageName());
        // 拨号器放行，紧急情况可以打电话
        try {
            ResolveInfo ri = getPackageManager().resolveActivity(new Intent(Intent.ACTION_DIAL), 0);
            if (ri != null && ri.activityInfo != null) whitelist.add(ri.activityInfo.packageName);
        } catch (Exception ignored) {
        }
        // 系统设置放行（便于用户去关掉/调整）
        whitelist.add("com.android.settings");
        // 闹钟：闹钟响时必须能进到响铃界面，否则用户既看不到也关不掉
        whitelist.add("com.android.deskclock");
        whitelist.add("com.google.android.deskclock");
        whitelist.add("com.android.Bedrock");
        whitelist.add("com.samsung.android.app.clockpack");
        // 来电与紧急呼叫：不同机型分别落在 telecom / incallui / 拨号器包里
        whitelist.add("com.android.server.telecom");
        whitelist.add("com.android.incallui");
        whitelist.add("com.samsung.android.incallui");
        whitelist.add("com.android.emergency");
        whitelist.add("com.google.android.dialer");
        // 授权弹窗、安装器等系统面板放行，避免授权过程中被自己的遮罩挡住
        whitelist.add("com.android.permissioncontroller");
        whitelist.add("com.google.android.permissioncontroller");
        whitelist.add("com.android.packageinstaller");
        whitelist.add("com.google.android.packageinstaller");
        whitelist.add("android");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        long end = System.currentTimeMillis() + 25 * 60 * 1000L;
        if (intent != null && intent.hasExtra("endAt")) end = intent.getLongExtra("endAt", end);
        if (intent != null) {
            sessionTitle = intent.getStringExtra("title");
            sessionMinutes = intent.getIntExtra("minutes", 25);
        }
        boolean newSession = end != endAt;
        endAt = end;
        if (endAt <= System.currentTimeMillis()) {
            // 结束时间已经过了：先满足前台服务的启动要求，再立刻收尾
            startForeground(NOTIF_ID, buildNotification());
            finishSession();
            return START_NOT_STICKY;
        }

        // 同一轮专注可能被重复启动（暂停恢复、切换后重新同步），
        // 若结束时间没变就沿用首轮记录的总时长，避免倒计时环每次被重置成满圈。
        android.content.SharedPreferences sp = getSharedPreferences("chronos", MODE_PRIVATE);
        long savedEnd = sp.getLong("guard_end_at", 0L);
        long savedDur = sp.getLong("guard_dur", 0L);
        if (savedEnd == endAt && savedDur > 0) {
            durMs = savedDur;
        } else {
            durMs = Math.max(1L, endAt - System.currentTimeMillis());
            sp.edit().putLong("guard_end_at", endAt).putLong("guard_dur", durMs).apply();
        }
        if (savedEnd != endAt) {
            // 新一轮专注：清掉上一轮记住的前台应用
            lastFgPkg = null;
            lastFgTs = 0L;
        }
        // 结束时间变了但遮罩还在（暂停后继续）：让面板上的倒计时跟着更新
        if (newSession && panel != null) panel.setEndAt(endAt, durMs);

        startForeground(NOTIF_ID, buildNotification());
        handler.removeCallbacks(poll);
        handler.post(poll);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (handler != null) handler.removeCallbacks(poll);
        if (mainHandler != null) mainHandler.removeCallbacks(applyBlock);
        hideOverlay();
        if (pollThread != null) pollThread.quitSafely();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            try {
                long now = System.currentTimeMillis();
                if (endAt > 0 && now >= endAt) {
                    finishSession();
                    return;
                }
                String fg = foregroundPackage();
                if (fg == null) {
                    postBlock(null);
                } else if (PKG_SYSTEMUI.equals(fg)) {
                    // 下拉通知栏 / 锁屏等系统浮层是临时状态：
                    // 既不能把它当成「放行」，也不能把遮罩撤掉，
                    // 否则一拉通知栏再收起来就绕过去了。保持原状态即可。
                } else if (whitelist.contains(fg)) {
                    skipShowUntil = 0L;
                    postBlock(null);
                } else if (now < skipShowUntil) {
                    // 刚点过「回到 Chronos」，给应用启动留一点时间
                    postBlock(null);
                } else {
                    postBlock(fg);
                }
            } catch (Exception e) {
                android.util.Log.w("Chronos", "guard poll failed", e);
            }
            handler.postDelayed(this, POLL_MS);
        }
    };

    /** 把"该不该遮、遮谁"投递到主线程执行（WindowManager 操作必须在主线程） */
    private void postBlock(String pkg) {
        desiredBlock = pkg;
        if (mainHandler == null) return;
        mainHandler.removeCallbacks(applyBlock);
        mainHandler.post(applyBlock);
    }

    private final Runnable applyBlock = new Runnable() {
        @Override
        public void run() {
            String pkg = desiredBlock;
            if (pkg == null) hideOverlay();
            else showOverlay(pkg);
        }
    };

    /**
     * 查询当前前台应用包名。
     * 注意：不能只看「最近 5 秒内的事件」——用户停在同一个应用里超过 5 秒就不会再产生
     * MOVE_TO_FOREGROUND 事件，那样会被误判成「没有前台应用」而收起遮罩。
     * 这里用粘性状态：窗口延长到 30 秒，并把上一次的结果保留下来，
     * 只有在出现更晚的事件时才更新。
     */
    private String foregroundPackage() {
        if (usm == null) return lastFgPkg;
        long now = System.currentTimeMillis();
        // 窗口只需覆盖"上次事件之后"：lastFgTs 已是粘性状态，不必每次回扫 30 秒
        long from = lastFgTs > 0 ? lastFgTs : now - 30000L;
        if (from >= now) from = now - 1000L;
        UsageEvents events = usm.queryEvents(from, now);
        if (events != null) {
            UsageEvents.Event ev = new UsageEvents.Event();
            while (events.hasNextEvent()) {
                events.getNextEvent(ev);
                int type = ev.getEventType();
                if (type != UsageEvents.Event.MOVE_TO_FOREGROUND
                        && type != UsageEvents.Event.ACTIVITY_RESUMED) continue;
                if (ev.getTimeStamp() > lastFgTs) {
                    lastFgTs = ev.getTimeStamp();
                    lastFgPkg = ev.getPackageName();
                }
            }
        }
        return lastFgPkg;
    }

    /** 一轮结束：先给一条通知，再收掉守护（息屏时 JS 定时器被冻结，这里是唯一可靠的兜底） */
    private void finishSession() {
        try {
            NotificationHelper.notifySessionEnd(this, sessionTitle, sessionMinutes);
        } catch (Exception e) {
            android.util.Log.w("Chronos", "session end notify failed", e);
        }
        stopSelf();
    }

    /* ---------------- 悬浮窗遮罩 ---------------- */

    private void showOverlay(String pkg) {
        if (panel != null) {
            if (!pkg.equals(blockedPkg)) {
                blockedPkg = pkg;
                panel.setBlocked(pkg);
            }
            return;
        }
        if (wm == null) return;
        if (!Settings.canDrawOverlays(this)) {
            // 权限被撤销：不再空转，直接收掉本轮守护并留个记录
            android.util.Log.w("Chronos", "悬浮窗权限已失效，停止守护");
            stopSelf();
            return;
        }
        blockedPkg = pkg;

        panel = new LockPanel(this, endAt, durMs, pkg, this);

        int type = Build.VERSION.SDK_INT >= 26
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                type,
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.OPAQUE);
        lp.gravity = Gravity.TOP | Gravity.START;
        if (Build.VERSION.SDK_INT >= 28) {
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }

        // 吞掉返回键等按键，避免透传到下面的应用
        panel.setFocusableInTouchMode(true);
        panel.setOnKeyListener((v, keyCode, event) -> true);

        try {
            wm.addView(panel, lp);
            // 手势返回（Android 13+ 预测式返回）也一并吞掉，防止直接退出遮罩
            if (Build.VERSION.SDK_INT >= 33) {
                android.window.OnBackInvokedDispatcher d = panel.findOnBackInvokedDispatcher();
                if (d != null) {
                    d.registerOnBackInvokedCallback(
                            android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, () -> { });
                }
            }
            panel.start();
        } catch (Exception e) {
            panel = null;
            android.util.Log.d("Chronos", "overlay failed: " + e);
        }
    }

    private void hideOverlay() {
        if (panel == null) return;
        try {
            panel.release();
            if (wm != null) wm.removeViewImmediate(panel);
        } catch (Exception ignored) {
        }
        panel = null;
        blockedPkg = null;
    }

    /* ---------------- LockPanel 回调 ---------------- */

    @Override
    public void onGiveUp() {
        // 长按放弃：严格由用户确认才结束本轮，不静默打断
        getSharedPreferences("chronos", MODE_PRIVATE)
                .edit().putBoolean("guard_gave_up", true).apply();
        stopSelf();
    }

    @Override
    public void onFinished() {
        stopSelf();
    }

    @Override
    public void onReturn() {
        // 把用户送回 Chronos 继续这一轮：不结束服务，也不打断正在进行的专注。
        // 服务此时持有可见悬浮窗 + 前台通知，属于后台启动 Activity 的豁免场景。
        hideOverlay();
        skipShowUntil = System.currentTimeMillis() + 3000L;
        try {
            Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (i != null) {
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP
                        | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                startActivity(i);
            }
        } catch (Exception ignored) {
        }
    }

    /* ---------------- 通知 ---------------- */

    private Notification buildNotification() {
        ensureChannel(this);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CH_GUARD)
                : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat_chronos)
                .setColor(0xFFFF5A1F)
                .setContentTitle("极度沉浸进行中")
                .setContentText("无关应用已被屏蔽，回到 Chronos 继续专注")
                .setOngoing(true)
                .setShowWhen(false)
                .setVisibility(Notification.VISIBILITY_SECRET)
                .setCategory(Notification.CATEGORY_SERVICE);
        if (Build.VERSION.SDK_INT >= 31) {
            b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return b.build();
    }

    private static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
                CH_GUARD, "极度沉浸", NotificationManager.IMPORTANCE_MIN);
        ch.setDescription("强制专注运行期间保持服务存活");
        ch.setShowBadge(false);
        ch.setSound(null, null);
        nm.createNotificationChannel(ch);
    }

    /* ---------------- 静态入口 ---------------- */

    public static void start(Context c, long endAt, String title, int minutes) {
        Intent i = new Intent(c, FocusGuardService.class);
        i.putExtra("endAt", endAt);
        i.putExtra("title", title == null ? "" : title);
        i.putExtra("minutes", minutes);
        try {
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
        } catch (Exception e) {
            try { c.startService(i); } catch (Exception ignored) { }
        }
    }

    public static void stop(Context c) {
        try { c.stopService(new Intent(c, FocusGuardService.class)); } catch (Exception ignored) { }
    }

    /** 使用情况访问权限是否已授予 */
    public static boolean usageAccessGranted(Context c) {
        try {
            android.app.AppOpsManager appOps =
                    (android.app.AppOpsManager) c.getSystemService(Context.APP_OPS_SERVICE);
            if (appOps == null) return false;
            // checkOpNoThrow 自 API 19 起可用；unsafe 版本在低版本上会抛 NoSuchMethodError
            int mode = appOps.checkOpNoThrow(
                    android.app.AppOpsManager.OPSTR_GET_USAGE_STATS,
                    android.os.Process.myUid(), c.getPackageName());
            return mode == android.app.AppOpsManager.MODE_ALLOWED;
        } catch (Throwable e) {
            return false;
        }
    }

    /** 是否已授予「显示在其他应用上层」 */
    public static boolean overlayGranted(Context c) {
        try {
            return Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(c);
        } catch (Exception e) {
            return false;
        }
    }

    public static void openUsageAccessSettings(Context c) {
        try {
            Intent i = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
        } catch (Exception ignored) {
        }
    }

    public static void openOverlaySettings(Context c) {
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + c.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
        } catch (Exception ignored) {
        }
    }
}
