package com.dvesiz.chronos;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.util.Locale;

/**
 * 极度沉浸锁定面板。
 * Activity 与悬浮窗共用同一套 UI 与交互：倒计时环 + 长按 3 秒放弃。
 */
public class LockPanel extends LinearLayout {

    public interface Listener {
        /** 长按 3 秒确认放弃本轮专注 */
        void onGiveUp();

        /** 倒计时走完，本轮自然结束 */
        void onFinished();

        /** 返回 Chronos，继续这一轮（不打断当前专注） */
        void onReturn();
    }

    private static final int BG = 0xFF17140E;
    private static final int ACCENT = 0xFFFF5A1F;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Listener listener;
    private long endAt;
    private long durMs;

    private final TextView subView;
    private final TextView timeView;
    private final View ringView;
    private final ProgressBar holdBar;

    private boolean exiting = false;
    private boolean holding = false;
    private int heldMs = 0;

    private final Runnable tickUi = new Runnable() {
        @Override
        public void run() {
            if (exiting) return;
            long remain = Math.max(0, (endAt - System.currentTimeMillis()) / 1000);
            timeView.setText(String.format(Locale.US, "%02d:%02d", remain / 60, remain % 60));
            ringView.invalidate();
            if (remain <= 0) {
                finish(false);
                return;
            }
            handler.postDelayed(this, 1000);
        }
    };

    private final Runnable holdTick = new Runnable() {
        @Override
        public void run() {
            if (!holding) return;
            heldMs += 100;
            holdBar.setProgress(Math.min(30, heldMs / 100));
            if (heldMs >= 3000) {
                holding = false;
                finish(true);
                return;
            }
            handler.postDelayed(this, 100);
        }
    };

    public LockPanel(Context c, long endAt, long durMs, String blocked, Listener l) {
        super(c);
        this.endAt = endAt;
        this.durMs = durMs > 0 ? durMs : 25 * 60 * 1000L;
        this.listener = l;

        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER);
        setPadding(dp(32), dp(48), dp(32), dp(40));
        setBackgroundColor(BG);
        // 自身吃掉所有触摸，避免点击穿透到下面被屏蔽的应用
        setClickable(true);
        setFocusable(true);

        TextView tag = new TextView(c);
        tag.setText("IMMERSION LOCK");
        tag.setTextColor(0x66FFFFFF);
        tag.setTextSize(11);
        tag.setLetterSpacing(.32f);
        tag.setGravity(Gravity.CENTER);
        tag.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));

        ringView = new View(c) {
            @Override
            protected void onDraw(Canvas canvas) {
                super.onDraw(canvas);
                float cx = getWidth() / 2f;
                float cy = getHeight() / 2f;
                Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
                p.setStyle(Paint.Style.STROKE);
                p.setColor(0x22FFFFFF);
                p.setStrokeWidth(dp(2));
                canvas.drawCircle(cx, cy, cx - dp(2), p);

                p.setColor(ACCENT);
                p.setStrokeCap(Paint.Cap.ROUND);
                p.setStrokeWidth(dp(3));
                long remain = Math.max(0, endAt - System.currentTimeMillis());
                float sweep = 360f * clamp01(remain / (float) LockPanel.this.durMs);
                RectF r = new RectF(dp(2), dp(2), getWidth() - dp(2), getHeight() - dp(2));
                canvas.drawArc(r, -90, sweep, false, p);

                p.setStyle(Paint.Style.FILL);
                canvas.drawCircle(cx, cy, dp(5), p);
            }
        };
        LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(dp(120), dp(120));
        rp.gravity = Gravity.CENTER;
        rp.topMargin = dp(26);
        ringView.setLayoutParams(rp);

        TextView title = new TextView(c);
        title.setText("极度沉浸 · 进行中");
        title.setTextColor(Color.WHITE);
        title.setTextSize(19);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.BOLD));
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(-2, -2);
        tp.gravity = Gravity.CENTER;
        tp.topMargin = dp(30);
        title.setLayoutParams(tp);

        timeView = new TextView(c);
        timeView.setText("--:--");
        timeView.setTextColor(Color.WHITE);
        timeView.setTextSize(52);
        timeView.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        timeView.setLetterSpacing(-.02f);
        timeView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams mp = new LinearLayout.LayoutParams(-2, -2);
        mp.gravity = Gravity.CENTER;
        mp.topMargin = dp(6);
        timeView.setLayoutParams(mp);

        subView = new TextView(c);
        subView.setTextColor(0x99FFFFFF);
        subView.setTextSize(13);
        subView.setLineSpacing(dp(5), 1f);
        subView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(-2, -2);
        sp.gravity = Gravity.CENTER;
        sp.topMargin = dp(10);
        subView.setLayoutParams(sp);

        View spacer = new View(c);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(1, 0, 1f));

        Button backView = new Button(c);
        backView.setText("回到 Chronos · 继续这一轮");
        backView.setTextColor(0xFFFFFFFF);
        backView.setTextSize(15f);
        backView.setAllCaps(false);
        backView.setPadding(dp(30), dp(15), dp(30), dp(15));
        GradientDrawable backBg = new GradientDrawable();
        backBg.setColor(ACCENT);
        backBg.setCornerRadius(dp(14));
        backView.setBackground(backBg);
        LinearLayout.LayoutParams rbp = new LinearLayout.LayoutParams(-2, -2);
        rbp.gravity = Gravity.CENTER;
        rbp.bottomMargin = dp(20);
        backView.setLayoutParams(rbp);
        backView.setOnClickListener(v -> {
            if (exiting) return;
            // 只是把用户送回 Chronos，节奏不中断
            if (listener != null) listener.onReturn();
        });

        Button holdView = new Button(c);
        holdView.setText("长按 3 秒 · 放弃本轮专注");
        holdView.setTextColor(0x99FFFFFF);
        holdView.setTextSize(12.5f);
        holdView.setAllCaps(false);
        holdView.setPadding(dp(24), dp(12), dp(24), dp(12));
        GradientDrawable holdBg = new GradientDrawable();
        holdBg.setColor(0x1AFFFFFF);
        holdBg.setStroke(dp(1), 0x33FFFFFF);
        holdBg.setCornerRadius(dp(12));
        holdView.setBackground(holdBg);
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(-2, -2);
        hp.gravity = Gravity.CENTER;
        hp.bottomMargin = dp(12);
        holdView.setLayoutParams(hp);

        holdBar = new ProgressBar(c, null, android.R.attr.progressBarStyleHorizontal);
        holdBar.getProgressDrawable().setColorFilter(ACCENT, android.graphics.PorterDuff.Mode.SRC_IN);
        holdBar.setBackground(null);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(dp(216), dp(4));
        bp.gravity = Gravity.CENTER;
        bp.bottomMargin = dp(22);
        holdBar.setLayoutParams(bp);

        addView(tag);
        addView(ringView);
        addView(title);
        addView(timeView);
        addView(subView);
        addView(spacer);
        addView(backView);
        addView(holdView);
        addView(holdBar);

        setBlocked(blocked);
        bindHold(holdView);
    }

    /** 被屏蔽应用名可随前台变化刷新 */
    public void setBlocked(String pkg) {
        if (pkg == null || pkg.isEmpty()) {
            subView.setText("无关应用已被屏蔽\n想继续这一轮，点下面的按钮回到 Chronos");
        } else {
            subView.setText("「" + friendlyName(pkg) + "」已被屏蔽\n想继续这一轮，点下面的按钮回到 Chronos");
        }
    }

    public void start() {
        handler.removeCallbacks(tickUi);
        handler.post(tickUi);
    }

    /**
     * 同一轮专注暂停后再继续时，结束时间会变。
     * 面板是按构造时的 endAt 倒计时的，这里让它可以被刷新，
     * 否则屏幕上显示的还是上一轮的结束时刻。
     */
    public void setEndAt(long endAt, long durMs) {
        if (exiting) return;
        this.endAt = endAt;
        this.durMs = durMs > 0 ? durMs : this.durMs;
        ringView.invalidate();
        handler.removeCallbacks(tickUi);
        handler.post(tickUi);
    }

    public void release() {
        exiting = true;
        holding = false;
        handler.removeCallbacksAndMessages(null);
    }

    private void finish(boolean giveUp) {
        if (exiting) return;
        release();
        if (listener != null) {
            if (giveUp) listener.onGiveUp();
            else listener.onFinished();
        }
    }

    private String friendlyName(String pkg) {
        try {
            return getContext().getPackageManager().getApplicationLabel(
                    getContext().getPackageManager().getApplicationInfo(pkg, 0)).toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    private void bindHold(View v) {
        v.setOnTouchListener((view, event) -> {
            switch (event.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    holding = true;
                    heldMs = 0;
                    holdBar.setProgress(0);
                    view.postDelayed(holdTick, 100);
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    holding = false;
                    heldMs = 0;
                    holdBar.setProgress(0);
                    return true;
                default:
                    return false;
            }
        });
    }

    private float clamp01(float v) {
        return v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
