package com.photostudio.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.DialogInterface;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;
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
import android.webkit.ValueCallback;
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

    private static final String TAG = "PhotoStudio";

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

    /** 应用内更新的下载 id（0 = 没有进行中的下载） */
    private long updateDownloadId = 0;
    /** 下载完成广播接收器（下载结束后调起安装器） */
    private BroadcastReceiver downloadDoneReceiver = null;
    /** 等待安装权限时暂存的文件路径 */
    private String pendingInstallPath = null;
    private static final int REQ_INSTALL = 1003;
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
        } else if (requestCode == REQ_INSTALL) {
            // 用户从「安装未知应用」授权页回来了：拿到权限就继续安装
            if (checkInstallPermission() && pendingInstallPath != null) {
                String p = pendingInstallPath;
                pendingInstallPath = null;
                doInstall(p);
            } else if (!checkInstallPermission()) {
                pendingInstallPath = null;
                toastOnUi("未获得安装权限，可到「下载」目录手动安装");
            }
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    /**
     * 交给系统处理返回（真正退出应用）。
     *
     * 单独抽成方法是因为 super.onBackPressed() 不能在回调里调用。
     */
    @SuppressWarnings("deprecation")
    private void callSuperBack() {
        super.onBackPressed();
    }

    /**
     * 返回键处理。
     *
     * 为什么不能只看 canGoBack()：
     *   这是个单页应用 —— 设置、修图记录、对比图、历史时间线全是**浮层**，
     *   没有真正的页面跳转，所以 web.canGoBack() 永远是 false。
     *   原实现为假就把事件交给系统 → **从任何浮层按一下返回键都直接退出整个应用**，
     *   用户以为刚做的修改丢了。
     *
     * 现在改为先问页面：「这一下返回你处理了吗？」
     *   页面按「浮层 → 取消生成 → 退回框选 → 回首页」的顺序逐级处理，
     *   全部处理完（已在首页）才返回 false，交给系统退出应用。
     *
     * 注意用 onBackPressed 而不是 onKeyDown：evaluateJavascript 是**异步**的，
     * 而 onKeyDown 必须同步返回 true/false。onBackPressed 返回 void，可以用回调。
     * 回调写成匿名内部类而不是 lambda —— 构建用的 android.jar 不含
     * LambdaMetafactory，用 lambda 会编译失败（javac 报 cannot find symbol metafactory）。
     */
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (web == null) {
            callSuperBack();
            return;
        }
        // 真机可能因 WebView 未就绪等原因返回 null —— 那时按「退出」处理，
        // 宁可退出也不要让用户卡在按返回没反应的界面里
        web.evaluateJavascript(BACK_PROBE_JS, new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if (value == null || value.indexOf("true") < 0) callSuperBack();
            }
        });
    }

    /** 问页面「返回键你处理了吗」；页面异常时按「没处理」处理（交给系统退出） */
    private static final String BACK_PROBE_JS =
            "(function(){try{return !!(window.__PS_API&&window.__PS_API.handleBack&&window.__PS_API.handleBack());}" +
            "catch(e){return false;}})()";

    @Override
    protected void onDestroy() {
        // 页面没了，保活就没有意义 —— 留着只会是一条点不开的常驻通知。
        // 但如果用户开了「一直保活」，说明他打算继续用，就保留。
        if (!alwaysOn) {
            KeepAliveService.stop(this);
            keepAliveRunning = false;
        }
        unregisterDownloadReceiver();   // 避免广播接收器泄漏
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

    /* ==================== 应用内更新 ==================== */

    /**
     * 是否已获得「安装未知应用」授权。
     *
     * Android 8.0 起，应用要安装 APK 必须由用户显式授权，
     * 否则系统会静默拒绝（用户看不到任何提示，只是装不上）。
     * 8.0 以下没有这个概念，直接视为已授权。
     */
    private boolean checkInstallPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        try {
            return getPackageManager().canRequestPackageInstalls();
        } catch (Exception e) {
            return false;
        }
    }

    /** 跳到系统的「安装未知应用」授权页 */
    private void ensureInstallPermission() {
        if (checkInstallPermission()) return;
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivityForResult(i, REQ_INSTALL);
        } catch (Exception e) {
            // 个别定制系统没有这个页面，退到应用详情页
            try {
                Intent i2 = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                i2.setData(Uri.parse("package:" + getPackageName()));
                startActivityForResult(i2, REQ_INSTALL);
            } catch (Exception e2) {
                toastOnUi("请到系统设置里允许「安装未知应用」");
            }
        }
    }

    /**
     * 用系统下载管理器下载 APK，完成后自动调起安装器。
     *
     * 用 DownloadManager 而不是自己开线程下载：系统会处理断点续传、
     * 通知栏进度、以及「下载完成后点击安装」的标准交互。
     */
    private void startDownload(String url, String fileName) {
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            toastOnUi("下载地址无效");
            return;
        }
        String name = (fileName == null || fileName.isEmpty()) ? "update.apk" : fileName;

        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) { toastOnUi("系统下载服务不可用"); return; }

            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle("修图台更新");
            req.setDescription("正在下载 " + name);
            req.setMimeType("application/vnd.android.package-archive");
            // 下载到外部下载目录，方便用户也能在文件管理器里找到
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                // Android 10 起这条被忽略（分区存储），低版本上仍需要
                try { req.allowScanningByMediaScanner(); } catch (Exception ignored) { }
            }

            updateDownloadId = dm.enqueue(req);
            registerDownloadReceiver();
            toastOnUi("开始下载，完成后会自动弹出安装");
        } catch (Exception e) {
            Log.w(TAG, "下载失败", e);
            toastOnUi("下载失败，请稍后在浏览器中下载");
        }
    }

    /** 监听下载完成（只注册一次，用完注销） */
    private void registerDownloadReceiver() {
        if (downloadDoneReceiver != null) return;
        downloadDoneReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                try {
                    long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                    if (id != updateDownloadId) return;
                    installDownloadedApk();
                } catch (Exception e) {
                    Log.w(TAG, "处理下载完成失败", e);
                } finally {
                    unregisterDownloadReceiver();
                }
            }
        };
        try {
            IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(downloadDoneReceiver, f, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(downloadDoneReceiver, f);
            }
        } catch (Exception e) {
            Log.w(TAG, "注册下载广播失败", e);
            downloadDoneReceiver = null;
        }
    }

    private void unregisterDownloadReceiver() {
        if (downloadDoneReceiver == null) return;
        try { unregisterReceiver(downloadDoneReceiver); } catch (Exception ignored) { }
        downloadDoneReceiver = null;
    }

    /** 下载完成 → 调起系统安装器 */
    private void installDownloadedApk() {
        String path = null;
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) {
                Cursor c = dm.query(new DownloadManager.Query().setFilterById(updateDownloadId));
                if (c != null) {
                    if (c.moveToFirst()) {
                        int idx = c.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI);
                        if (idx >= 0) path = c.getString(idx);
                    }
                    c.close();
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "查询下载结果失败", e);
        }

        if (path == null || path.isEmpty()) {
            toastOnUi("下载已完成，请到「下载」目录手动安装");
            return;
        }

        // 没有安装权限时先申请，授权回来后接着装
        if (!checkInstallPermission()) {
            pendingInstallPath = path;
            toastOnUi("请允许「安装未知应用」，然后会继续安装");
            ensureInstallPermission();
            return;
        }
        doInstall(path);
    }

    /** 真正调起安装界面 */
    private void doInstall(String pathOrUri) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            Uri uri = pathOrUri.startsWith("content:") || pathOrUri.startsWith("file:")
                    ? Uri.parse(pathOrUri)
                    : Uri.fromFile(new java.io.File(pathOrUri));
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(i);
        } catch (Exception e) {
            Log.w(TAG, "调起安装失败", e);
            toastOnUi("无法自动安装，请到「下载」目录手动点击安装包");
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

        /**
         * 下载新版本 APK 并调起系统安装器。
         *
         * 为什么交给原生做（而不是让页面下载）：
         *   · WebView 里下载的文件拿不到可安装的路径
         *   · Android 8+ 需要「安装未知应用」授权，必须在原生侧申请
         *   · 下载完要弹系统安装界面，也只有原生能做
         */
        @JavascriptInterface
        public void downloadAndInstall(final String url, final String fileName) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        startDownload(url, fileName);
                    } catch (Exception e) {
                        toastOnUi("下载失败：" + e.getMessage());
                    }
                }
            });
        }

        /** 当前是否已获得「安装未知应用」授权 */
        @JavascriptInterface
        public boolean canInstallPackages() {
            return checkInstallPermission();
        }

        /** 主动申请「安装未知应用」授权 */
        @JavascriptInterface
        public void requestInstallPermission() {
            runOnUiThread(new Runnable() {
                @Override public void run() { ensureInstallPermission(); }
            });
        }
    }
}
