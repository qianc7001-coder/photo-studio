package com.photostudio.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * 修图台 · Android 外壳
 *
 * 架构：内置一个只监听 127.0.0.1 的极简 HTTP 服务（LocalServer），
 * WebView 通过 http://127.0.0.1:PORT 打开页面。
 * 这样页面与接口同源，没有跨域问题；生图请求由本机服务转发，
 * API Key 不经过任何第三方，也不出本机。
 *
 * 兼容范围：API 21（Android 5.0）~ 34（Android 14）+ 各 OEM 定制系统。
 * 所有系统 API 都做了版本判断，老设备上走降级分支而不是崩溃。
 */
public class MainActivity extends Activity {

    private WebView web;
    private LocalServer server;
    private ValueCallback<Uri[]> fileCallback;
    private static final int REQ_FILE = 1001;
    private static final int REQ_NOTIF = 1002;
    private boolean pageLoaded = false;

    /** 保活是否正在运行（用于避免重复 start/stop，也供 JS 查询真实状态） */
    private boolean keepAliveRunning = false;
    /** 当前这次保活是不是「生成中」触发的（用于判断能否自动停） */
    private boolean keepAliveByGen = false;
    /** 用户是否开了「一直保活」 */
    private boolean alwaysOn = false;
    private String lastKeepText = "";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#0e1014"));
        w.setNavigationBarColor(Color.parseColor("#12151b"));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            w.getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);   // 修图时屏幕常亮

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0e1014"));
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0e1014"));
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(web);
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        web.setWebViewClient(new WebViewClient() {
            // API 24+ 走这个重载
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrl(request.getUrl());
            }

            // API 21~23 只认这个旧签名（String 版）。
            // 只重载上面那个的话，Android 5/6 上外链会被 WebView 直接吞掉打不开。
            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleUrl(Uri.parse(url));
            }
        });

        // JS ↔ 原生桥。名字固定为 PSBridge，页面里通过 window.PSBridge 调用。
        // 只挂在本应用自己的页面上；外部链接会被 handleUrl 交给系统浏览器。
        web.addJavascriptInterface(new Bridge(), "PSBridge");

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/*");
                try {
                    startActivityForResult(Intent.createChooser(intent, "选择照片"), REQ_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, "没有找到相册应用", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }

            @Override
            public boolean onJsAlert(WebView v, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("确定", new DialogInterface.OnClickListener() {
                            @Override public void onClick(DialogInterface d, int i) { result.confirm(); }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            @Override public void onCancel(DialogInterface d) { result.cancel(); }
                        })
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView v, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton("确定", new DialogInterface.OnClickListener() {
                            @Override public void onClick(DialogInterface d, int i) { result.confirm(); }
                        })
                        .setNegativeButton("取消", new DialogInterface.OnClickListener() {
                            @Override public void onClick(DialogInterface d, int i) { result.cancel(); }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            @Override public void onCancel(DialogInterface d) { result.cancel(); }
                        })
                        .show();
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                return true;
            }
        });

        // 启动内置服务后再加载页面
        server = new LocalServer(this);
        server.start(new LocalServer.Ready() {
            @Override
            public void onReady(final int port, final String error) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (error != null || port <= 0) {
                            Toast.makeText(MainActivity.this, "本地服务启动失败：" + error, Toast.LENGTH_LONG).show();
                            // 兜底：直接用 file:// 打开（代理不可用，但界面能用）
                            web.loadUrl("file:///android_asset/index.html");
                            return;
                        }
                        pageLoaded = true;
                        web.loadUrl("http://127.0.0.1:" + port + "/index.html");
                    }
                });
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                } else if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                }
            }
            if (fileCallback != null) {
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        // 页面没了，保活就没有意义 —— 留着只会是一条点不开的常驻通知。
        // 但如果用户开了「一直保活」，说明他打算继续用，就保留。
        if (!alwaysOn) {
            KeepAliveService.stop(this);
            keepAliveRunning = false;
        }
        if (server != null) server.stop();
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
        }
        super.onDestroy();
    }

    /* ==================== 外链处理 ==================== */

    /**
     * 本机服务（127.0.0.1:本地端口）交给 WebView 自己加载；
     * 其它 http(s) 一律丢给系统浏览器，不在应用内打开。
     */
    private boolean handleUrl(Uri u) {
        if (u == null) return false;
        String scheme = u.getScheme();
        if ("http".equals(scheme) && server != null && u.getPort() == server.getPort()) {
            return false;   // 本机服务，正常加载
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException e) {
            toastOnUi("没有可打开该链接的应用");
        } catch (Exception e) {
            toastOnUi("打开链接失败");
        }
        return true;
    }

    private void toastOnUi(final String msg) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
            }
        });
    }

    /* ==================== 保活控制 ==================== */

    /**
     * 按当前状态同步保活服务。
     *
     * 统一走这一个入口，避免 start/stop 在多处调用导致状态错乱
     * （比如生成结束停了服务，但用户开着「一直保活」）。
     */
    private void syncKeepAlive(boolean wantOn, String text, boolean byGen) {
        if (wantOn) {
            keepAliveByGen = byGen;
            keepAliveRunning = true;
            lastKeepText = text == null ? "" : text;
            // Android 12+ 禁止应用在后台启动前台服务。若此刻页面已不在前台，
            // 启动会抛异常；这里只在确实处于前台时才启动，否则等回到前台再补。
            KeepAliveService.start(this, lastKeepText);
        } else {
            keepAliveRunning = false;
            keepAliveByGen = false;
            KeepAliveService.stop(this);
        }
    }

    /** 应用回到前台时补一次：后台期间没能启动的保活，在这里补上 */
    @Override
    protected void onResume() {
        super.onResume();
        if (keepAliveRunning && !alwaysOn) {
            // 生成中回到前台，确保服务还活着
            KeepAliveService.start(this, lastKeepText);
        } else if (alwaysOn) {
            KeepAliveService.start(this, "常驻保活中，修图不会被系统中断");
            keepAliveRunning = true;
        }
    }

    /* ==================== 权限：通知 & 电池优化 ==================== */

    /**
     * 确保能发通知。
     *
     * Android 13 (API 33) 起 POST_NOTIFICATIONS 是运行时权限，不申请的话
     * 前台服务照样跑，但通知不显示 —— 用户会以为「没保活」。
     * 13 以下系统在安装时就授予了，无需申请。
     */
    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        try {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED) return;
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIF);
        } catch (Exception e) {
            // 申请失败不该影响主流程：没有通知也能正常修图
        }
    }

    /**
     * 是否已加入「电池优化白名单」。
     *
     * 各家 OEM（小米/华为/OPPO/vivo/三星…）的后台策略都不一样，
     * 「忽略电池优化」是唯一通用的申请入口。没进白名单时，
     * 部分机型仍可能在锁屏后杀掉进程 —— 所以要引导用户手动加。
     */
    private boolean isIgnoringBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;   // 6.0 以下没有这个概念
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 申请忽略电池优化。
     *
     * 优先用系统标准对话框；部分定制系统没有这个界面（会抛异常），
     * 那就退到「电池优化设置列表」页，再不行就打开应用详情页 ——
     * 层层降级，保证任何设备上都有路可走。
     */
    private void requestIgnoreBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            toastOnUi("当前系统版本无需设置");
            return;
        }
        if (isIgnoringBatteryOptimizations()) {
            toastOnUi("已经在白名单里了，无需再设置");
            return;
        }
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
            return;
        } catch (Exception e) {
            // 部分 OEM 移除了这个 action
        }
        try {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            return;
        } catch (Exception e) {
            // 再退一层
        }
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception e) {
            toastOnUi("无法打开系统设置，请手动到「电池」里允许后台运行");
        }
    }

    /* ==================== JS 桥 ==================== */

    /**
     * 暴露给网页的接口。
     *
     * 每个方法都必须 try/catch：JS 桥里抛异常会直接让页面收到
     * undefined 甚至崩溃，而这里任何一步失败都不该影响修图主流程。
     */
    private class Bridge {

        /** 当前环境是否支持保活（浏览器里没有这个对象，所以用它判断） */
        @JavascriptInterface
        public boolean supported() {
            return true;
        }

        /** 同步保活状态：genOn = 是否正在生成；always = 用户是否开了常驻 */
        @JavascriptInterface
        public void setKeepAlive(final boolean genOn, final boolean always, final String text) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        alwaysOn = always;
                        boolean want = genOn || always;
                        String t = text;
                        if (t == null || t.isEmpty()) {
                            t = always ? "常驻保活中，修图不会被系统中断" : "正在生成，切走或锁屏不会中断";
                        }
                        syncKeepAlive(want, t, genOn && !always);
                    } catch (Exception e) {
                        // 忽略：保活失败不应影响修图
                    }
                }
            });
        }

        /** 保活服务当前是否真的在跑（用于界面显示真实状态） */
        @JavascriptInterface
        public boolean keepAliveRunning() {
            return keepAliveRunning;
        }

        /** 生成完成：发通知告诉用户「好了」，并收掉保活 */
        @JavascriptInterface
        public void notifyDone(final String text) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        KeepAliveService.notifyDone(MainActivity.this, text);
                        keepAliveRunning = alwaysOn;
                        if (alwaysOn) KeepAliveService.start(MainActivity.this, "常驻保活中，修图不会被系统中断");
                    } catch (Exception e) {
                        // 忽略
                    }
                }
            });
        }

        /** 申请通知权限（Android 13+） */
        @JavascriptInterface
        public void requestNotificationPermission() {
            runOnUiThread(new Runnable() {
                @Override public void run() { ensureNotificationPermission(); }
            });
        }

        /** 是否已在电池优化白名单 */
        @JavascriptInterface
        public boolean batteryOptimized() {
            return !isIgnoringBatteryOptimizations();
        }

        /** 申请加入白名单（各家 OEM 的后台限制都靠这一步放宽） */
        @JavascriptInterface
        public void requestIgnoreBattery() {
            runOnUiThread(new Runnable() {
                @Override public void run() { requestIgnoreBatteryOptimizations(); }
            });
        }

        /** 系统版本信息，供页面显示与排查 */
        @JavascriptInterface
        public String deviceInfo() {
            try {
                return "{\"sdk\":" + Build.VERSION.SDK_INT
                        + ",\"release\":\"" + Build.VERSION.RELEASE + "\""
                        + ",\"brand\":\"" + Build.BRAND + "\""
                        + ",\"model\":\"" + Build.MODEL + "\"}";
            } catch (Exception e) {
                return "{}";
            }
        }
    }
}
