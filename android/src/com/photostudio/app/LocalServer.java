package com.photostudio.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 应用内置的极简 HTTP 服务。
 *
 * 为什么要内置服务：
 *  - 用 http://127.0.0.1:PORT 打开页面，页面与接口同源，彻底没有跨域问题
 *  - 生图请求由本服务转发，API Key 只在请求头里经过本机内存，不上传第三方
 *  - 静态资源直接读 APK 的 assets，完全离线可用
 *
 * 只监听 127.0.0.1，局域网内其它设备无法访问。
 */
public class LocalServer {

    private static final String TAG = "PhotoStudio";
    private static final int MAX_BODY = 96 * 1024 * 1024;   // 96MB，够 4K 图的 base64
    private static final int UPSTREAM_CONNECT_TIMEOUT = 30000;
    private static final int UPSTREAM_READ_TIMEOUT = 300000;

    /**
     * 固定端口。
     *
     * 这一点很关键：WebView 的 localStorage / IndexedDB 是按「源」隔离的，
     * 源 = http://127.0.0.1:端口。如果端口每次启动都变，源就变了，
     * 之前保存的 API Key、模型、贴回参数全部读不到 —— 表现为「更新一次设置就丢」。
     * 所以这里固定端口；万一被占用再顺延，并保证同一次安装内稳定。
     */
    private static final int PREFERRED_PORT = 45871;

    private final Context ctx;
    private final AssetManager assets;
    private ServerSocket socket;
    private Thread acceptThread;
    private volatile boolean running;
    private int port;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    public interface Ready { void onReady(int port, String error); }

    public LocalServer(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.assets = this.ctx.getAssets();
    }

    public int getPort() { return port; }

    /** 优先绑定固定端口；被其它程序占用时向后顺延（最多试 20 个） */
    private ServerSocket bind(int preferred) throws IOException {
        IOException last = null;
        for (int i = 0; i < 20; i++) {
            int candidate = preferred + i;
            try {
                ServerSocket s = new ServerSocket(candidate, 50, InetAddress.getByName("127.0.0.1"));
                port = s.getLocalPort();
                return s;
            } catch (IOException e) {
                last = e;
                Log.w(TAG, "端口 " + candidate + " 被占用，换下一个");
            }
        }
        throw (last != null ? last : new IOException("没有可用端口"));
    }

    public void start(final Ready cb) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    socket = bind(PREFERRED_PORT);
                    running = true;
                    if (cb != null) cb.onReady(port, null);
                    acceptLoop();
                } catch (Exception e) {
                    Log.e(TAG, "服务启动失败", e);
                    if (cb != null) cb.onReady(0, e.getMessage());
                }
            }
        }, "ps-server-start").start();
    }

    private void acceptLoop() {
        while (running) {
            try {
                final Socket s = socket.accept();
                pool.execute(new Runnable() {
                    @Override public void run() { handle(s); }
                });
            } catch (IOException e) {
                if (running) Log.w(TAG, "accept 失败: " + e.getMessage());
            }
        }
    }

    public void stop() {
        running = false;
        try { if (socket != null) socket.close(); } catch (IOException ignored) { }
        pool.shutdownNow();
    }

    /* ==================== 单个连接处理 ==================== */

    private void handle(Socket s) {
        try {
            s.setSoTimeout(120000);
            BufferedInputStream in = new BufferedInputStream(s.getInputStream());
            BufferedOutputStream out = new BufferedOutputStream(s.getOutputStream());

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) { s.close(); return; }

            String[] parts = requestLine.split(" ");
            if (parts.length < 2) { s.close(); return; }
            String method = parts[0].toUpperCase(Locale.ROOT);
            String rawPath = parts[1];

            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int c = line.indexOf(':');
                if (c > 0) {
                    headers.put(line.substring(0, c).trim().toLowerCase(Locale.ROOT),
                            line.substring(c + 1).trim());
                }
            }

            byte[] body = new byte[0];
            String cl = headers.get("content-length");
            if (cl != null) {
                int len;
                try { len = Integer.parseInt(cl.trim()); } catch (Exception e) { len = 0; }
                if (len > MAX_BODY) { respond(out, 413, "application/json", bytes("{\"__proxyError\":\"请求体过大\"}")); s.close(); return; }
                if (len > 0) {
                    body = new byte[len];
                    int off = 0;
                    while (off < len) {
                        int n = in.read(body, off, len - off);
                        if (n < 0) break;
                        off += n;
                    }
                }
            }

            int q = rawPath.indexOf('?');
            String path = q >= 0 ? rawPath.substring(0, q) : rawPath;
            try { path = URLDecoder.decode(path, "UTF-8"); } catch (Exception ignored) { }

            if ("OPTIONS".equals(method)) {
                respondCors(out, 204, "text/plain", new byte[0]);
            } else if ("/api/health".equals(path)) {
                respondCors(out, 200, "application/json",
                        bytes("{\"ok\":true,\"name\":\"photo-studio\",\"engine\":\"android-native\"}"));
            } else if ("/api/generate".equals(path)) {
                handleProxy(out, headers, body);
            } else if ("GET".equals(method) || "HEAD".equals(method)) {
                serveAsset(out, path, "HEAD".equals(method));
            } else {
                respondCors(out, 405, "text/plain", bytes("Method Not Allowed"));
            }

            out.flush();
            s.close();
        } catch (Exception e) {
            Log.w(TAG, "连接处理异常: " + e.getMessage());
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    /* ==================== 静态资源（assets） ==================== */

    private void serveAsset(OutputStream out, String path, boolean headOnly) throws IOException {
        String rel = (path == null || path.isEmpty() || "/".equals(path)) ? "index.html" : path.substring(1);
        // 防目录穿越
        if (rel.contains("..") || rel.startsWith("/")) {
            respondCors(out, 403, "text/plain", bytes("Forbidden"));
            return;
        }
        InputStream is = null;
        try {
            is = assets.open(rel);
        } catch (IOException e) {
            // 未知路由回落到首页（单页应用行为）
            try { is = assets.open("index.html"); rel = "index.html"; }
            catch (IOException e2) {
                respondCors(out, 404, "text/plain", bytes("Not Found"));
                return;
            }
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[32768];
        int n;
        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        is.close();
        byte[] data = bos.toByteArray();
        respondCors(out, 200, mimeOf(rel), headOnly ? new byte[0] : data);
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".html")) return "text/html; charset=utf-8";
        if (n.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (n.endsWith(".css")) return "text/css; charset=utf-8";
        if (n.endsWith(".json")) return "application/json; charset=utf-8";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }

    /* ==================== 生图请求代理 ==================== */

    private void handleProxy(OutputStream out, Map<String, String> headers, byte[] body) throws IOException {
        String target = headers.get("x-target-url");
        String auth = headers.get("x-target-auth");
        // 透传原始 Content-Type：multipart/form-data 的 boundary 必须原样带上，
        // 否则上游解析不了表单，图片字段会被丢掉
        String reqType = headers.get("x-target-content-type");
        if (reqType == null || reqType.isEmpty()) reqType = headers.get("content-type");
        if (reqType == null || reqType.isEmpty()) reqType = "application/json";

        // 兼容旧协议：body 为 {url, headers, body}
        if (target == null && body.length > 0) {
            String s = new String(body, "UTF-8").trim();
            if (s.startsWith("{")) {
                String u = jsonString(s, "url");
                if (u != null) {
                    target = u;
                    auth = jsonString(s, "Authorization");
                    String inner = jsonRaw(s, "body");
                    if (inner != null) body = inner.getBytes("UTF-8");
                }
            }
        }

        if (target == null || !(target.startsWith("http://") || target.startsWith("https://"))) {
            respondCors(out, 400, "application/json", bytes("{\"__proxyError\":\"缺少或非法的 X-Target-Url\"}"));
            return;
        }

        long t0 = System.currentTimeMillis();
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(target).openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(UPSTREAM_CONNECT_TIMEOUT);
            conn.setReadTimeout(UPSTREAM_READ_TIMEOUT);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", reqType);
            if (auth != null && !auth.isEmpty()) conn.setRequestProperty("Authorization", auth);

            OutputStream os = conn.getOutputStream();
            os.write(body);
            os.flush();
            os.close();

            int code = conn.getResponseCode();
            InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            if (is != null) {
                byte[] buf = new byte[32768];
                int n;
                while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                is.close();
            }
            byte[] data = bos.toByteArray();
            String ctype = conn.getContentType();
            if (ctype == null || ctype.isEmpty()) ctype = "application/json";
            Log.i(TAG, "代理 POST " + target + " -> " + code + " (" + (System.currentTimeMillis() - t0) + "ms, " + data.length + "B)");
            respondCors(out, code, ctype, data);
        } catch (Exception e) {
            Log.w(TAG, "代理失败: " + e.getMessage());
            respondCors(out, 502, "application/json",
                    bytes("{\"__proxyError\":" + quote("转发失败：" + e.getMessage()) + "}"));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /* ==================== 小工具 ==================== */

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream(128);
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c == '\r') continue;
            bos.write(c);
            if (bos.size() > 16384) break;
        }
        if (c == -1 && bos.size() == 0) return null;
        return new String(bos.toByteArray(), "UTF-8");
    }

    private static byte[] bytes(String s) {
        try { return s.getBytes("UTF-8"); } catch (Exception e) { return new byte[0]; }
    }

    private static void respond(OutputStream out, int code, String ctype, byte[] data) throws IOException {
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(code).append(' ').append(reason(code)).append("\r\n");
        h.append("Content-Type: ").append(ctype).append("\r\n");
        h.append("Content-Length: ").append(data.length).append("\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes("UTF-8"));
        if (data.length > 0) out.write(data);
    }

    private static void respondCors(OutputStream out, int code, String ctype, byte[] data) throws IOException {
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(code).append(' ').append(reason(code)).append("\r\n");
        h.append("Content-Type: ").append(ctype).append("\r\n");
        h.append("Content-Length: ").append(data.length).append("\r\n");
        h.append("Access-Control-Allow-Origin: *\r\n");
        h.append("Access-Control-Allow-Headers: *\r\n");
        h.append("Access-Control-Allow-Methods: GET,POST,OPTIONS\r\n");
        h.append("Cache-Control: no-store\r\n");
        h.append("Connection: close\r\n\r\n");
        out.write(h.toString().getBytes("UTF-8"));
        if (data.length > 0) out.write(data);
    }

    private static String reason(int code) {
        switch (code) {
            case 200: return "OK";
            case 204: return "No Content";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 413: return "Payload Too Large";
            default: return code >= 500 ? "Server Error" : "OK";
        }
    }

    private static String quote(String s) {
        if (s == null) s = "";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    /** 从 JSON 文本里取一个字符串字段（够用即可，避免引入 JSON 库） */
    private static String jsonString(String json, String key) {
        String raw = jsonRaw(json, key);
        if (raw == null) return null;
        raw = raw.trim();
        if (raw.startsWith("\"")) return raw.substring(1, Math.max(1, raw.length() - 1));
        return null;
    }

    /** 从 JSON 文本里取一个字段的原始片段（对象或字符串） */
    private static String jsonRaw(String json, String key) {
        String pat = "\"" + key + "\"";
        int i = json.indexOf(pat);
        if (i < 0) return null;
        int c = json.indexOf(':', i + pat.length());
        if (c < 0) return null;
        int p = c + 1;
        while (p < json.length() && Character.isWhitespace(json.charAt(p))) p++;
        if (p >= json.length()) return null;
        char first = json.charAt(p);
        if (first == '"') {
            int e = p + 1;
            while (e < json.length()) {
                char ch = json.charAt(e);
                if (ch == '\\') { e += 2; continue; }
                if (ch == '"') break;
                e++;
            }
            return json.substring(p, Math.min(e + 1, json.length()));
        }
        if (first == '{' || first == '[') {
            char close = first == '{' ? '}' : ']';
            int depth = 0, e = p;
            boolean inStr = false;
            while (e < json.length()) {
                char ch = json.charAt(e);
                if (inStr) {
                    if (ch == '\\') { e += 2; continue; }
                    if (ch == '"') inStr = false;
                } else {
                    if (ch == '"') inStr = true;
                    else if (ch == first) depth++;
                    else if (ch == close) { depth--; if (depth == 0) return json.substring(p, e + 1); }
                }
                e++;
            }
            return null;
        }
        int e = p;
        while (e < json.length() && ",}] \n\r\t".indexOf(json.charAt(e)) < 0) e++;
        return json.substring(p, e);
    }
}
