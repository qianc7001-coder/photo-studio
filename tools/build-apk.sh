#!/usr/bin/env bash
# =============================================================================
# 修图台 · APK 构建脚本（全部使用本机可执行的 arm64 工具）
#   aapt(1) 打包资源 + javac 编译 + d8 转 dex + zipalign 对齐 + apksigner 签名
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_SDK:-/root/android-sdk}"
BT="$SDK/bt/android-14"
PLATFORM="$SDK/pf/android-34/android.jar"
AND="$ROOT/android"
OUT="$ROOT/dist/android-build"

command -v aapt     >/dev/null || { echo "缺少 aapt（apt install aapt）"; exit 1; }
command -v zipalign >/dev/null || { echo "缺少 zipalign（apt install zipalign）"; exit 1; }
command -v javac    >/dev/null || { echo "缺少 javac"; exit 1; }
[ -e "$BT/lib/d8.jar" ]        || { echo "缺少 d8.jar: $BT/lib/d8.jar"; exit 1; }
[ -e "$BT/lib/apksigner.jar" ] || { echo "缺少 apksigner.jar"; exit 1; }
[ -e "$PLATFORM" ]             || { echo "缺少 android.jar: $PLATFORM"; exit 1; }

D8() { java -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 "$@"; }
APKSIGNER() { java -jar "$BT/lib/apksigner.jar" "$@"; }

echo "> 版本号检查（内容有改动会自动递增，避免忘记改版本）"
BUMP_OUT="$(node "$ROOT/tools/bump-version.js")"
VERSION_CODE="$(echo "$BUMP_OUT" | tail -2 | head -1)"
VERSION_NAME="$(echo "$BUMP_OUT" | tail -1)"
[ -n "$VERSION_CODE" ] && [ -n "$VERSION_NAME" ] || { echo "版本号解析失败"; exit 1; }

echo "> 清理输出目录"
rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$AND/assets"

# 生成带版本号的 Manifest（源文件保持占位符，避免手改遗漏）
MANIFEST="$OUT/AndroidManifest.xml"
sed -e "s/android:versionCode=\"[0-9]*\"/android:versionCode=\"$VERSION_CODE\"/" \
    -e "s/android:versionName=\"[^\"]*\"/android:versionName=\"$VERSION_NAME\"/" \
    "$AND/AndroidManifest.xml" > "$MANIFEST"
grep -E 'versionCode|versionName' "$MANIFEST" | head -2 | sed 's/^/    /'

echo "> 同步网页资源到 assets"
node "$ROOT/tools/build-single.js" > /dev/null
cp "$ROOT/app/index.html" "$ROOT/app/style.css" "$ROOT/app/core.js" "$ROOT/app/app.js" \
   "$ROOT/app/version.js" "$ROOT/app/manifest.json" "$ROOT/app/icon.svg" "$AND/assets/"
node "$ROOT/tools/make-icons.js" "$AND/assets" > /dev/null 2>&1 || true
ls "$AND/assets" | sed 's/^/    /'

echo "> aapt package（生成 R.java）"
aapt package -f -m \
  -J "$OUT/gen" \
  -M "$MANIFEST" \
  -S "$AND/res" \
  -A "$AND/assets" \
  -I "$PLATFORM" \
  --min-sdk-version 21 \
  --target-sdk-version 34 \
  -F "$OUT/resources.ap_"

echo "> javac"
find "$AND/src" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
echo "    源文件 $(wc -l < "$OUT/sources.txt") 个"
javac -encoding UTF-8 -source 8 -target 8 -nowarn \
  -bootclasspath "$PLATFORM" -classpath "$PLATFORM" \
  -d "$OUT/classes" @"$OUT/sources.txt"

echo "> d8 → classes.dex"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
D8 --release --min-api 21 --lib "$PLATFORM" --output "$OUT/dex" @"$OUT/classes.txt"

echo "> 打包 APK"
aapt package -f \
  -M "$MANIFEST" \
  -S "$AND/res" \
  -A "$AND/assets" \
  -I "$PLATFORM" \
  --min-sdk-version 21 \
  --target-sdk-version 34 \
  -F "$OUT/unsigned.apk"

( cd "$OUT/dex" && zip -q -X "$OUT/unsigned.apk" classes.dex )
zipalign -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "> 签名"
KS="$AND/keystore.jks"
if [ ! -f "$KS" ]; then
  echo "    生成签名密钥（有效期 30 年）"
  keytool -genkeypair -v -keystore "$KS" -alias photostudio \
    -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass photostudio -keypass photostudio \
    -dname "CN=Photo Studio, OU=App, O=PhotoStudio, L=CN, S=CN, C=CN" > /dev/null 2>&1
fi

mkdir -p "$ROOT/dist"
# 注意：apksigner 是 Java 程序，非 ASCII 输出名会按平台默认字符集写坏，
# 因此先签成 ASCII 名，再用 node（保证 UTF-8）改名成中文。
APK_TMP="$OUT/photostudio-signed.apk"
APK="$ROOT/dist/修图台-v$VERSION_NAME.apk"
APK_LATEST="$ROOT/dist/修图台.apk"
APKSIGNER sign \
  --ks "$KS" --ks-key-alias photostudio \
  --ks-pass pass:photostudio --key-pass pass:photostudio \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out "$APK_TMP" "$OUT/aligned.apk"
node -e "require('fs').copyFileSync(process.argv[1],process.argv[2])" "$APK_TMP" "$APK"
node -e "require('fs').copyFileSync(process.argv[1],process.argv[2])" "$APK_TMP" "$APK_LATEST"
rm -f "$ROOT/dist/"*.idsig "$OUT/photostudio-signed.apk.idsig" 2>/dev/null || true

echo ""
echo "> 校验（Java 工具对非 ASCII 路径不友好，用 ASCII 副本校验）"
VERIFY="$OUT/verify.apk"
cp "$APK" "$VERIFY"
APKSIGNER verify --verbose --print-certs "$VERIFY" 2>&1 | head -8
aapt dump badging "$VERIFY" 2>&1 | grep -E "package:|application-label|launchable-activity|sdkVersion|uses-permission" | head -8
rm -f "$VERIFY"
echo ""
echo "构建完成：$APK"
echo "体积：$(du -h "$APK" | cut -f1)"
