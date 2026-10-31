#!/usr/bin/env bash
# Build the Ubuntu .deb of LemonServer from a compiled binary.
#
#   packaging/ubuntu/build-deb.sh <path/to/LemonServer> <version> <output.deb>
#
# Everything is installed under /opt/lemonserver. All shared libraries except glibc are bundled
# (Qt, ICU, a newer libstdc++, ...), so the package works on Ubuntu 22.04 and later without
# installing Qt. /usr/bin/lemonserver points to the binary.
set -euo pipefail

BIN=$1
VERSION=$2
OUT=$3
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$HERE/../.." && pwd)
ROOT=$(mktemp -d)
APP=$ROOT/opt/lemonserver
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$APP/bin" "$APP/lib" "$ROOT/usr/bin" "$ROOT/lib/systemd/system" \
         "$ROOT/usr/share/doc/lemonserver" "$ROOT/DEBIAN"

install -m755 "$BIN" "$APP/bin/LemonServer"
strip --strip-unneeded "$APP/bin/LemonServer"

ldd "$BIN" | awk '/=> \// {print $3}' | while read -r lib; do
	case "$(basename "$lib")" in
		libc.so* | libm.so* | libpthread.so* | libdl.so* | librt.so* | libresolv.so* | libutil.so* | ld-linux*) continue ;;
	esac
	cp -L "$lib" "$APP/lib/"
done
chmod 644 "$APP"/lib/*
patchelf --set-rpath '$ORIGIN/../lib' "$APP/bin/LemonServer"
for f in "$APP"/lib/*.so*; do patchelf --set-rpath '$ORIGIN' "$f" 2>/dev/null || true; done

ln -s /opt/lemonserver/bin/LemonServer "$ROOT/usr/bin/lemonserver"
install -m644 "$HERE/lemonserver.service" "$ROOT/lib/systemd/system/lemonserver.service"
install -m644 "$SRC/LICENSE" "$ROOT/usr/share/doc/lemonserver/copyright"
install -m644 "$SRC/README.md" "$ROOT/usr/share/doc/lemonserver/README.md"
install -m755 "$HERE/postinst" "$HERE/postrm" "$ROOT/DEBIAN/"

cat > "$ROOT/DEBIAN/control" <<EOF
Package: lemonserver
Version: $VERSION
Architecture: amd64
Maintainer: heyicong <heyicong.jeremy@gmail.com>
Installed-Size: $(du -sk "$ROOT/opt" | cut -f1)
Depends: bubblewrap
Recommends: g++
Suggests: gcc, fpc, python3, default-jdk
Section: devel
Priority: optional
Homepage: https://github.com/GetawayCar1024/LemonServer
Description: web judging server for OI contests, forked from LemonLime
 LemonServer keeps the judging core and the .cdf contest format of LemonLime
 and replaces its desktop user interface with a web UI and a REST API:
 contests, tasks, test cases, data upload and online editing, judging with
 live progress, result.html export, statistics, Testlib for Lemons checkers.
EOF

dpkg-deb --root-owner-group -Zxz --build "$ROOT" "$OUT"
dpkg-deb --info "$OUT"
echo "Bundled libraries:"
ls "$APP/lib"
