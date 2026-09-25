package com.photostudio.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
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
 */
public class MainActivity extends Activity {

    private WebView web;
    private LocalServer server;
    private ValueCallback<Uri[]> fileCallback;
    private static final int REQ_FILE = 1001;
    private boolean pageLoaded = false;

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
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u == null) return false;
                String scheme = u.getScheme();
                if ("http".equals(scheme) && u.getPort() == (server == null ? -1 : server.getPort())) {
                    return false;   // 本机服务，正常加载
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this, "没有可打开该链接的应用", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
        });

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
        if (server != null) server.stop();
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
        }
        super.onDestroy();
    }
}
