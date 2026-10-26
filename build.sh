#!/usr/bin/env bash
set -euo pipefail

SDK="${ANDROID_SDK:-/opt/android-sdk}"
BT="${ANDROID_BUILD_TOOLS:-$SDK/build-tools/35.0.0}"
AJ="${ANDROID_JAR:-$SDK/platforms/android-35/android.jar}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC=$ROOT/app/src/main
OUT=$ROOT/build

rm -rf "$OUT"
mkdir -p "$OUT/res" "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "==> compile resources"
"$BT/aapt2" compile --dir "$SRC/res" -o "$OUT/res/resources.zip"

echo "==> link resources"
"$BT/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$AJ" \
  --manifest "$SRC/AndroidManifest.xml" \
  -A "$SRC/assets" \
  -R "$OUT/res/resources.zip" \
  --java "$OUT/gen" \
  --auto-add-overlay

echo "==> compile java"
find "$SRC/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
if ! javac --release 11 \
  -classpath "$AJ" \
  -d "$OUT/classes" \
  @"$OUT/sources.txt" > "$OUT/javac.log" 2>&1; then
  cat "$OUT/javac.log"
  exit 1
fi

echo "==> dex"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$BT/d8" --release --min-api 26 --lib "$AJ" --output "$OUT/dex" @"$OUT/classes.txt"

echo "==> package dex"
cd "$OUT/dex"
zip -q -X "$OUT/base.apk" classes.dex
cd "$ROOT"

echo "==> zipalign"
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"

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
"$BT/apksigner" sign --ks "$KS" --ks-key-alias chronos \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KPASS" \
  --out "$OUT/Chronos-2.6.0.apk" "$OUT/aligned.apk"

"$BT/apksigner" verify --print-certs "$OUT/Chronos-2.6.0.apk" | head -4
ls -lh "$OUT/Chronos-2.6.0.apk"
