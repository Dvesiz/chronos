#!/usr/bin/env bash
set -euo pipefail

SDK="${ANDROID_SDK:-/opt/android-sdk}"
BT="${ANDROID_BUILD_TOOLS:-$SDK/build-tools/35.0.0}"
AJ="${ANDROID_JAR:-$SDK/platforms/android-35/android.jar}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC=$ROOT/app/src/main
OUT=$ROOT/build
# 版本号只从 manifest 取，避免脚本、界面、README 三处各写一遍
VERSION=$(awk -F'"' '/android:versionName=/{print $2; exit}' "$SRC/AndroidManifest.xml")
[ -n "$VERSION" ] || VERSION="dev"

# Android SDK tools use platform-specific suffixes on Windows.
find_tool() {
  for candidate in "$BT/$1" "$BT/$1.bat" "$BT/$1.exe"; do
    [ -f "$candidate" ] && { printf '%s' "$candidate"; return; }
  done
  echo "Missing Android build tool: $1" >&2
  exit 1
}
AAPT2=$(find_tool aapt2)
D8=$(find_tool d8)
ZIPALIGN=$(find_tool zipalign)
APKSIGNER=$(find_tool apksigner)

rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "==> compile resources"
"$AAPT2" compile --dir "$SRC/res" -o "$OUT/res/resources.zip"

echo "==> link resources"
"$AAPT2" link \
  -o "$OUT/base.apk" \
  -I "$AJ" \
  --manifest "$SRC/AndroidManifest.xml" \
  -R "$OUT/res/resources.zip" \
  --java "$OUT/gen" \
  --auto-add-overlay

# assets 不用 aapt2 -A：Windows 版 aapt2 会把条目写成 assets/www\xxx，
# Android 按 assets/www/xxx 找不到文件（表现为 ERR_FILE_NOT_FOUND）。
# jar 走的始终是 '/'，且会原样保留 resources.arsc 的 STORED 方式。
echo "==> package assets"
( cd "$SRC" && jar --update --file "$OUT/base.apk" --no-manifest assets )

echo "==> compile java"
find "$SRC/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
# MSYS/Cygwin find emits /d/... paths, while Windows javac expects D:\\....
if command -v cygpath >/dev/null 2>&1; then
  while IFS= read -r source; do cygpath -w "$source"; done < "$OUT/sources.txt" > "$OUT/sources-win.txt"
  SOURCE_LIST="$OUT/sources-win.txt"
else
  SOURCE_LIST="$OUT/sources.txt"
fi
if ! javac --release 11 -encoding UTF-8 \
  -classpath "$AJ" \
  -d "$OUT/classes" \
  @"$SOURCE_LIST" > "$OUT/javac.log" 2>&1; then
  cat "$OUT/javac.log"
  exit 1
fi

echo "==> dex"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
if command -v cygpath >/dev/null 2>&1; then
  while IFS= read -r class_file; do cygpath -w "$class_file"; done < "$OUT/classes.txt" > "$OUT/classes-win.txt"
  CLASS_LIST="$OUT/classes-win.txt"
else
  CLASS_LIST="$OUT/classes.txt"
fi
"$D8" --release --min-api 26 --lib "$AJ" --output "$OUT/dex" @"$CLASS_LIST"

echo "==> package dex"
( cd "$OUT/dex" && jar --update --file "$OUT/base.apk" --no-manifest classes.dex )

echo "==> zipalign"
"$ZIPALIGN" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"

echo "==> sign"
KS=$ROOT/keystore.jks
KS_PROPS=$ROOT/keystore.properties

# 签名口令不入库：优先读环境变量 CHRONOS_KS_PASS，其次读本地 keystore.properties，
# 两者都没有就随机生成一份（首次构建时和 keystore.jks 一起只留在本机）。
if [ -n "${CHRONOS_KS_PASS:-}" ]; then
  KS_PASS=$CHRONOS_KS_PASS
elif [ -f "$KS_PROPS" ]; then
  KS_PASS=$(awk '/^storePassword=/{sub(/^storePassword=/, ""); print; exit}' "$KS_PROPS")
else
  # 已经有 keystore.jks 却没有口令文件：不能瞎猜，也不能静默换一把新钥
  if [ -f "$KS" ]; then
    echo "缺少 keystore.properties：现有 keystore.jks 的签名口令未知，无法继续。" >&2
    echo "请写入 keystore.properties（storePassword=...），或用 CHRONOS_KS_PASS 指定口令。" >&2
    exit 1
  fi
  # 首次构建：生成随机口令，临时关掉 pipefail，避免 head 提前关闭管道被误判成失败
  set +o pipefail
  KS_PASS=$(head -c 18 /dev/urandom 2>/dev/null | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  set -o pipefail
  if [ -z "$KS_PASS" ]; then
    KS_PASS="chronos$(date +%s)"
  fi
  printf 'storePassword=%s\nkeyPassword=%s\n' "$KS_PASS" "$KS_PASS" > "$KS_PROPS"
  chmod 600 "$KS_PROPS" 2>/dev/null || true
fi
if [ -z "$KS_PASS" ]; then
  echo "keystore.properties 里缺少 storePassword，无法签名" >&2
  exit 1
fi
KPASS=$(awk '/^keyPassword=/{sub(/^keyPassword=/, ""); print; exit}' "$KS_PROPS" 2>/dev/null)
[ -n "$KPASS" ] || KPASS=$KS_PASS

if [ ! -f "$KS" ]; then
  keytool -genkeypair -v -keystore "$KS" -alias chronos -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$KS_PASS" -keypass "$KPASS" \
    -dname "CN=Chronos, OU=Personal, O=Chronos, L=Shanghai, S=Shanghai, C=CN" >/dev/null 2>&1
fi
"$APKSIGNER" sign --ks "$KS" --ks-key-alias chronos \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KPASS" \
  --out "$OUT/Chronos-$VERSION.apk" "$OUT/aligned.apk"

"$APKSIGNER" verify --print-certs "$OUT/Chronos-$VERSION.apk" | head -4
ls -lh "$OUT/Chronos-$VERSION.apk"
