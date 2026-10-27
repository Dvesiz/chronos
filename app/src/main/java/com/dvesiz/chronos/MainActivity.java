package com.dvesiz.chronos;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Vibrator;
import android.os.VibrationEffect;
import android.provider.Settings;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;

import org.json.JSONObject;

public class MainActivity extends Activity {

    private WebView web;
    private String pendingJson = null;
    private int lastTop = -1, lastBottom = -1, lastIme = -1;
    private android.webkit.ValueCallback<Uri[]> fileCallback;
    private String pendingExportName = null;
    private String pendingExportData = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        w.setStatusBarColor(Color.TRANSPARENT);
        w.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 28) {
            w.getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
        } else {
            w.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        if (Build.VERSION.SDK_INT >= 29) {
            w.setNavigationBarDividerColor(Color.TRANSPARENT);
        }

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#F2F2F4"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // 只需要加载 assets 里的本地页面：关掉 file:// 的跨域与跨源访问。
        // 之前全开 + 无导航白名单，等于"任何被导航到的页面都能直接调用 window.Native"。
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setAllowContentAccess(true);   // 头像选择需要读 content:// 授权 URI
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return !isLocalAsset(req.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !isLocalAsset(Uri.parse(url));
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = cb;
                try {
                    // 按 input 的 accept 决定选图片还是数据文件（头像 / 导入 JSON 共用）
                    boolean wantsJson = false;
                    String[] accepts = params.getAcceptTypes();
                    if (accepts != null) {
                        for (String a : accepts) {
                            if (a != null && a.toLowerCase(java.util.Locale.US).contains("json")) {
                                wantsJson = true;
                                break;
                            }
                        }
                    }
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    if (wantsJson) {
                        i.setType("*/*");
                        i.putExtra(Intent.EXTRA_MIME_TYPES,
                                new String[]{"application/json", "text/plain", "application/octet-stream"});
                    } else {
                        i.setType("image/*");
                    }
                    startActivityForResult(Intent.createChooser(i, wantsJson ? "选择数据文件" : "选择头像"), 33);
                    return true;
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
            }
        });
        web.addJavascriptInterface(new Bridge(), "Native");

        setContentView(web);
        NotificationHelper.ensureChannels(this);
        applyInsetsListener();
        handleIntent(getIntent());

        web.loadUrl("file:///android_asset/www/index.html");
        clearPendingIntentExtras();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
        clearPendingIntentExtras();
        if (web != null) {
            web.post(() -> web.evaluateJavascript("window.__onNativeResume && window.__onNativeResume();", null));
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        try {
            ChronosWidgetProvider.refresh(this);
        } catch (Exception ignored) {
        }
        if (web != null) {
            web.post(() -> web.evaluateJavascript("window.__onNativeResume && window.__onNativeResume();", null));
        }
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String taskId = intent.getStringExtra("taskId");
        String action = intent.getStringExtra("action");
        String date = intent.getStringExtra("date");
        if (taskId == null && action == null) return;

        // 从通知进来的：顺手把那条通知消掉（"开始/延后"点完还挂在通知栏很碍事）
        int notifId = intent.getIntExtra("notifId", -1);
        if (notifId >= 0) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(notifId);
        }

        try {
            JSONObject o = new JSONObject();
            if (taskId != null) o.put("taskId", taskId);
            if (date != null) o.put("date", date);
            o.put("action", action == null ? "open" : action);
            pendingJson = o.toString();
        } catch (Exception e) {
            Log.w("Chronos", "handleIntent failed", e);
        }
    }

    private boolean isLocalAsset(Uri uri) {
        if (uri == null) return false;
        String u = uri.toString();
        return u.startsWith("file:///android_asset/") || u.startsWith("about:blank");
    }

    /** 权限弹窗关掉后不回 onResume 的机型上，也要让页面刷新一次权限状态 */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (web != null) {
            web.post(() -> web.evaluateJavascript(
                    "window.__onNativeResume && window.__onNativeResume();", null));
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("Native");
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private void clearPendingIntentExtras() {
        Intent i = getIntent();
        if (i != null) {
            i.removeExtra("taskId");
            i.removeExtra("action");
        }
    }

    private void applyInsetsListener() {
        web.setOnApplyWindowInsetsListener((v, insets) -> {
            int top = 0, barsBottom = 0, imeBottom = 0;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                top = bars.top;
                barsBottom = bars.bottom;
                imeBottom = ime.bottom;
            } else {
                top = insets.getSystemWindowInsetTop();
                barsBottom = insets.getSystemWindowInsetBottom();
            }
            float d = getResources().getDisplayMetrics().density;
            int t = Math.round(top / d);
            int b = Math.round(barsBottom / d);
            int ime = Math.round(imeBottom / d);
            if (t != lastTop || b != lastBottom || ime != lastIme) {
                lastTop = t;
                lastBottom = b;
                lastIme = ime;
                String js = "window.__applyInsets && window.__applyInsets(" + t + "," + b + "," + ime + ");";
                web.post(() -> web.evaluateJavascript(js, null));
            }
            return insets;
        });
        web.requestApplyInsets();
    }

    /* ------------------------- JS 桥 ------------------------- */

    private class Bridge {
        @JavascriptInterface
        public void schedule(String json) {
            AlarmScheduler.saveAndSchedule(MainActivity.this, json);
        }

        /** 计划 / 状态变化后刷新桌面小组件 */
        @JavascriptInterface
        public void refreshWidget() {
            try {
                ChronosWidgetProvider.refresh(MainActivity.this);
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public String permissionState() {
            JSONObject o = new JSONObject();
            try {
                boolean notify = NotificationHelper.notificationsEnabled(MainActivity.this);
                boolean exact = AlarmScheduler.canExact(MainActivity.this);
                o.put("notify", notify);
                o.put("exact", exact);
                o.put("sdk", Build.VERSION.SDK_INT);
            } catch (Exception ignored) {
            }
            return o.toString();
        }

        @JavascriptInterface
        public void requestNotificationPermission() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33) {
                    if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                            != PackageManager.PERMISSION_GRANTED) {
                        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 21);
                    }
                } else if (!NotificationHelper.notificationsEnabled(MainActivity.this)) {
                    openNotificationSettings();
                }
            });
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                    i.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception e) {
                    try {
                        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                        i.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(i);
                    } catch (Exception ignored) {
                    }
                }
            });
        }

        @JavascriptInterface
        public void openExactAlarmSettings() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 31) {
                    try {
                        Intent i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                        i.setData(Uri.parse("package:" + getPackageName()));
                        startActivity(i);
                        return;
                    } catch (Exception ignored) {
                    }
                }
                openNotificationSettings();
            });
        }

        @JavascriptInterface
        public String consumePending() {
            String p = pendingJson;
            pendingJson = null;
            return p;
        }

        @JavascriptInterface
        public String consumeOverlay() {
            SharedPreferences sp = getSharedPreferences("chronos", MODE_PRIVATE);
            String v = sp.getString("overlay", null);
            if (v != null) {
                sp.edit().remove("overlay").apply();
            }
            return v;
        }

        @JavascriptInterface
        public void haptic(String type) {
            try {
                Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
                if (v == null || !v.hasVibrator()) return;
                if (Build.VERSION.SDK_INT >= 26) {
                    int dur = "success".equals(type) ? 26 : ("medium".equals(type) ? 18 : 10);
                    v.vibrate(VibrationEffect.createOneShot(dur, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(12);
                }
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void share(String text) {
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType("text/plain");
                    i.putExtra(Intent.EXTRA_SUBJECT, "Chronos 学习数据");
                    i.putExtra(Intent.EXTRA_TEXT, text);
                    startActivity(Intent.createChooser(i, "导出学习数据"));
                } catch (Exception ignored) {
                }
            });
        }

        /** 把 JSON 存成真正的文件：系统「保存为」面板，用户自己选位置与文件名 */
        @JavascriptInterface
        public void exportFile(String name, String content) {
            pendingExportName = (name == null || name.trim().isEmpty()) ? "chronos-data.json" : name.trim();
            pendingExportData = content == null ? "" : content;
            runOnUiThread(() -> {
                try {
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("application/json");
                    i.putExtra(Intent.EXTRA_TITLE, pendingExportName);
                    startActivityForResult(i, 34);
                } catch (Exception e) {
                    pendingExportData = null;
                    android.widget.Toast.makeText(MainActivity.this, "无法打开保存面板",
                            android.widget.Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void setTheme(String theme) {
            runOnUiThread(() -> {
                boolean dark = "dark".equals(theme);
                web.setBackgroundColor(Color.parseColor(dark ? "#0F0F12" : "#F2F2F4"));
                if (Build.VERSION.SDK_INT >= 30) {
                    // API 30+ 用 WindowInsetsController；旧的 systemUiVisibility 在 edge-to-edge 下不生效
                    android.view.WindowInsetsController c = getWindow().getInsetsController();
                    if (c != null) {
                        int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                        c.setSystemBarsAppearance(dark ? 0 : mask, mask);
                    }
                    return;
                }
                int flags = web.getSystemUiVisibility();
                if (Build.VERSION.SDK_INT >= 23) {
                    if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    else flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                }
                if (Build.VERSION.SDK_INT >= 26) {
                    if (dark) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                    else flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
                }
                web.setSystemUiVisibility(flags);
            });
        }

        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "1.0";
            }
        }

        @JavascriptInterface
        public void saveState(String json) {
            getSharedPreferences("chronos", MODE_PRIVATE)
                    .edit().putString("state_json", json).apply();
        }

        @JavascriptInterface
        public String loadState() {
            return getSharedPreferences("chronos", MODE_PRIVATE)
                    .getString("state_json", null);
        }

        @JavascriptInterface
        public void clearState() {
            getSharedPreferences("chronos", MODE_PRIVATE)
                    .edit().remove("state_json").apply();
        }

        /* ---------------- 极度沉浸 ---------------- */

        @JavascriptInterface
        public boolean usageAccessGranted() {
            return FocusGuardService.usageAccessGranted(MainActivity.this);
        }

        @JavascriptInterface
        public boolean overlayGranted() {
            return FocusGuardService.overlayGranted(MainActivity.this);
        }

        @JavascriptInterface
        public void openUsageAccessSettings() {
            runOnUiThread(() -> FocusGuardService.openUsageAccessSettings(MainActivity.this));
        }

        @JavascriptInterface
        public void openOverlaySettings() {
            runOnUiThread(() -> FocusGuardService.openOverlaySettings(MainActivity.this));
        }

        /** 用户在锁定面板长按放弃后，这里消费一次标记 */
        @JavascriptInterface
        public boolean consumeGuardGiveUp() {
            SharedPreferences sp = getSharedPreferences("chronos", MODE_PRIVATE);
            boolean v = sp.getBoolean("guard_gave_up", false);
            if (v) sp.edit().putBoolean("guard_gave_up", false).apply();
            return v;
        }

        @JavascriptInterface
        public void startFocusGuard(String json) {
            long endAt = System.currentTimeMillis() + 25 * 60 * 1000L;
            String title = "";
            int minutes = 25;
            try {
                JSONObject o = new JSONObject(json);
                endAt = o.optLong("endAt", endAt);
                title = o.optString("title", "");
                minutes = o.optInt("minutes", 25);
            } catch (Exception e) {
                Log.w("Chronos", "startFocusGuard 参数解析失败", e);
            }
            FocusGuardService.start(MainActivity.this, endAt, title, minutes);
        }

        /** 守护是否还活着：服务被系统回收后，界面不该继续显示"屏蔽中" */
        @JavascriptInterface
        public boolean guardRunning() {
            return FocusGuardService.isRunning();
        }

        @JavascriptInterface
        public void stopFocusGuard() {
            FocusGuardService.stop(MainActivity.this);
        }

        /* ---------------- 邮箱验证码（Resend 就绪） ---------------- */

        /**
         * 发送邮箱验证码。
         * RESEND_API_KEY 为空时返回 "dev"（本地开发模式，验证码由前端直接展示）；
         * 配置后走 Resend API，返回 "sent"。
         */
        @JavascriptInterface
        public String sendEmailCode(String email, String code) {
            if (RESEND_API_KEY == null || RESEND_API_KEY.isEmpty()) return "dev";
            final String mail = email == null ? "" : email;
            final String cd = code == null ? "" : code;
            new Thread(() -> sendViaResend(mail, cd)).start();
            return "sent";
        }
    }

    /** Resend 配置：拿到 key 后填这里即可，前端无需改动 */
    private static final String RESEND_API_KEY = "";
    private static final String RESEND_FROM = "Chronos <onboarding@resend.dev>";

    private void sendViaResend(String email, String code) {
        java.net.HttpURLConnection conn = null;
        try {
            org.json.JSONObject payload = new org.json.JSONObject();
            payload.put("from", RESEND_FROM);
            payload.put("to", new org.json.JSONArray().put(email));
            payload.put("subject", "时序 Chronos · 登录验证码");
            payload.put("html", "<div style=\"font-family:-apple-system,sans-serif;padding:28px\">"
                    + "<h2 style=\"margin:0 0 12px\">你的验证码</h2>"
                    + "<div style=\"font-size:34px;font-weight:700;letter-spacing:8px;color:#ff5a1f\">"
                    + android.text.TextUtils.htmlEncode(code)
                    + "</div>"
                    + "<p style=\"color:#888\">10 分钟内有效。若非本人操作，请忽略此邮件。</p></div>");
            conn = (java.net.HttpURLConnection) new java.net.URL("https://api.resend.com/emails")
                    .openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Authorization", "Bearer " + RESEND_API_KEY);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setDoOutput(true);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            java.io.OutputStream os = conn.getOutputStream();
            os.write(payload.toString().getBytes("utf-8"));
            os.flush();
            os.close();
            int status = conn.getResponseCode();
            android.util.Log.d("Chronos", "resend status=" + status);
        } catch (Exception e) {
            android.util.Log.d("Chronos", "resend failed: " + e);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == 34) {
            // 导出：把待写的 JSON 落到用户选的文件里
            if (resultCode == RESULT_OK && data != null && data.getData() != null && pendingExportData != null) {
                try (java.io.OutputStream os = getContentResolver().openOutputStream(data.getData())) {
                    if (os != null) {
                        os.write(pendingExportData.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                        os.flush();
                        android.widget.Toast.makeText(this, "已保存 " + pendingExportName,
                                android.widget.Toast.LENGTH_SHORT).show();
                    }
                } catch (Exception e) {
                    android.widget.Toast.makeText(this, "保存失败", android.widget.Toast.LENGTH_SHORT).show();
                }
            } else if (resultCode != RESULT_OK) {
                android.widget.Toast.makeText(this, "已取消导出", android.widget.Toast.LENGTH_SHORT).show();
            }
            pendingExportData = null;
            return;
        }
        if (requestCode == 33) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
            if (fileCallback != null) {
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null) {
            web.evaluateJavascript(
                    "(function(){" +
                            // 打卡动效最优先：返回键只收起它
                            "var cb=document.getElementById('celebrate');" +
                            "if(cb&&cb.classList.contains('open')){var c=document.getElementById('cbClose');if(c)c.click();return '1';}" +
                            // 专注界面优先：返回键只收起它，不退出 app
                            "var im=document.getElementById('immerse');" +
                            "if(im&&im.classList.contains('open')){var b=document.getElementById('imExit');if(b)b.click();return '1';}" +
                            "var l=document.getElementById('sheetLayer');" +
                            "if(l&&l.classList.contains('open')){document.getElementById('sheetBackdrop').click();return '1';}" +
                            // 统计 / 设置页：先回到「今日」，再按一次才退出 app
                            "if(window.__backToHome)return window.__backToHome();" +
                            "return '0';})()", value -> {
                        if (value == null || value.contains("0")) finish();
                    });
        } else {
            super.onBackPressed();
        }
    }
}
