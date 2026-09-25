package com.photostudio.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

/**
 * 后台保活服务（前台服务 + 常驻通知）。
 *
 * 为什么需要它：
 *   生图请求通常 30~60 秒，多块串行时更久。这期间用户很容易切走
 *   （回微信、锁屏、去拍下一张）。Android 会很快回收后台进程，
 *   进程一死，WebView 里那个 fetch 就断了 —— 上游其实已经出图
 *   （钱已经花了），结果却收不到，等于白花一次钱。
 *
 * 用前台服务把进程钉住，请求就能跑完。代价是状态栏多一条常驻通知，
 * 所以只在「生成中」或用户主动开启常驻时才启动，空闲即停。
 *
 * 注意：保活挡得住系统回收，挡不住用户从最近任务里划掉应用 ——
 * 那种情况 Activity 和 WebView 一起没了，保活也没有意义（见 onTaskRemoved）。
 */
public class KeepAliveService extends Service {

    private static final String TAG = "PhotoStudio";
    private static final String CHANNEL_ID = "ps-keepalive";
    private static final String CHANNEL_DONE = "ps-done";
    private static final int NOTIF_ID = 0x51A1;
    private static final int NOTIF_DONE_ID = 0x51A2;

    /** 兜底超时：正常不会走到，防止异常路径下唤醒锁被永久持有 */
    private static final long WAKELOCK_TIMEOUT_MS = 30 * 60 * 1000L;

    public static final String EXTRA_TEXT = "text";

    private PowerManager.WakeLock wakeLock;

    /** 启动保活。必须在应用处于前台时调用（Android 12+ 禁止后台启动前台服务） */
    public static void start(Context ctx, String text) {
        try {
            Intent i = new Intent(ctx, KeepAliveService.class);
            i.putExtra(EXTRA_TEXT, text);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i);
            } else {
                ctx.startService(i);
            }
        } catch (Exception e) {
            // 拿不到前台服务权限等情况不该让应用崩掉，退化成「不保活」即可
            Log.w(TAG, "启动保活失败: " + e.getMessage());
        }
    }

    public static void stop(Context ctx) {
        try {
            ctx.stopService(new Intent(ctx, KeepAliveService.class));
        } catch (Exception e) {
            Log.w(TAG, "停止保活失败: " + e.getMessage());
        }
    }

    /**
     * 生成完成时提示用户。
     *
     * 用户切走后最需要知道的就是「好了没有」—— 没有这条通知，
     * 他只能反复切回来查看。发完通知顺便收掉保活服务。
     */
    public static void notifyDone(Context ctx, String text) {
        try {
            createChannel(ctx, CHANNEL_DONE, "生成完成", NotificationManager.IMPORTANCE_DEFAULT);
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            String body = (text == null || text.isEmpty()) ? "生成完成，点开查看效果" : text;
            Notification n = builder(ctx, CHANNEL_DONE)
                    .setSmallIcon(R.drawable.ic_stat_photostudio)
                    .setContentTitle("修图台")
                    .setContentText(body)
                    .setAutoCancel(true)
                    .setContentIntent(contentIntent(ctx))
                    .build();
            nm.notify(NOTIF_DONE_ID, n);
        } catch (Exception e) {
            Log.w(TAG, "发送完成通知失败: " + e.getMessage());
        }
        stop(ctx);
    }

    /**
     * 构造 Notification.Builder，兼容 API 21~34。
     *
     * 关键：带 channelId 的构造函数是 **API 26 才有的**。老设备上直接调用会抛
     * NoSuchMethodError（不是 Exception，catch 不住）—— 这是最容易漏的兼容坑。
     * 所以这里按版本分流：26+ 带渠道，26 以下用老构造函数。
     */
    private static Notification.Builder builder(Context ctx, String channelId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return new Notification.Builder(ctx, channelId);
        }
        return new Notification.Builder(ctx);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;   // 只启动、不绑定
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel(this, CHANNEL_ID, "后台保活", NotificationManager.IMPORTANCE_LOW);
        acquireWakeLock();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String text = intent == null ? null : intent.getStringExtra(EXTRA_TEXT);
        if (text == null || text.isEmpty()) text = "正在生成，切走或锁屏不会中断";
        try {
            Notification n = build(text);
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIF_ID, n);
            }
        } catch (Exception e) {
            Log.e(TAG, "startForeground 失败", e);
        }
        // 不用 START_STICKY：服务若真被系统回收，WebView 多半也没了，
        // 拉起来只会留下一条点不开的常驻通知，反而误导用户。
        return START_NOT_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // 用户从最近任务里划掉应用：Activity 与 WebView 一起没了，保活已无意义。
        // 主动收摊，避免留下一条点了没反应的常驻通知。
        Log.i(TAG, "任务被移除，停止保活");
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        releaseWakeLock();
        try {
            stopForeground(true);
        } catch (Exception e) {
            Log.w(TAG, "stopForeground 失败: " + e.getMessage());
        }
        super.onDestroy();
    }

    /* ==================== 内部实现 ==================== */

    private static PendingIntent contentIntent(Context ctx) {
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flag = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        return PendingIntent.getActivity(ctx, 0, open, flag);
    }

    private Notification build(String text) {
        Notification.Builder b = builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_photostudio)
                .setContentTitle("修图台")
                .setContentText(text)
                .setOngoing(true)          // 不可滑动清除：它代表「正在跑」
                .setShowWhen(false)
                .setContentIntent(contentIntent(this));
        return b.build();
    }

    private static void createChannel(Context ctx, String id, String name, int importance) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;   // 渠道是 API 26 才有的概念
        try {
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (nm.getNotificationChannel(id) != null) return;
            NotificationChannel ch = new NotificationChannel(id, name, importance);
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        } catch (Exception e) {
            Log.w(TAG, "创建通知渠道失败: " + e.getMessage());
        }
    }

    /**
     * 持一个部分唤醒锁。
     *
     * 前台服务本身就能防止进程被回收，但屏幕熄灭后 CPU 仍可能进入深度睡眠。
     * 请求正在传输时补一个唤醒锁，能显著降低「锁屏后请求卡住」的概率。
     */
    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PhotoStudio:keepalive");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(WAKELOCK_TIMEOUT_MS);
        } catch (Exception e) {
            Log.w(TAG, "获取唤醒锁失败: " + e.getMessage());
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception e) {
            Log.w(TAG, "释放唤醒锁失败: " + e.getMessage());
        } finally {
            wakeLock = null;
        }
    }
}
