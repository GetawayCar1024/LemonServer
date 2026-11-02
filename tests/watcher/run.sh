#!/usr/bin/env bash
# Runs the Linux watcher directly (no bwrap) on programs near a 1000 ms time limit.
# Usage: bash tests/watcher/run.sh   (from the repository root; needs g++)
set -euo pipefail
cd "$(dirname "$0")/../.."
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
g++ -O2 -std=c++17 -o "$work/watcher" unix/watcher_unix.cpp unix/watcher_linux.cpp

cat >"$work/common.h" <<'EOF'
#include <cstdio>
#include <fcntl.h>
#include <sys/resource.h>
#include <unistd.h>
static long long ms(const timeval &t) { return t.tv_sec * 1000LL + t.tv_usec / 1000; }
static void times(long long &user, long long &sys) { rusage u{}; getrusage(RUSAGE_SELF, &u); user = ms(u.ru_utime); sys = ms(u.ru_stime); }
static volatile unsigned long long sink;
static void spinUntil(long long target) { long long user = 0, sys = 0; for (;;) { for (int i = 0; i < 1000000; i++) sink += i; times(user, sys); if (user >= target) return; } }
// reading /dev/zero into a large buffer is spent almost entirely in the kernel
static char buffer[1 << 20];
static void kernelUntil(long long target) { int fd = open("/dev/zero", O_RDONLY); long long user = 0, sys = 0; for (;;) { for (int i = 0; i < 16; i++) sink += read(fd, buffer, sizeof buffer); times(user, sys); if (sys >= target) break; } close(fd); }
EOF
declare -A src=(
	[ok]='int main() { puts("3"); }'
	[kernel]='int main() { spinUntil(700); kernelUntil(600); puts("3"); }'
	[over]='int main() { spinUntil(1050); puts("3"); }'
	[spin]='int main() { for (;;) sink++; }'
	[sleep]='int main() { sleep(60); }'
)
for name in "${!src[@]}"; do
	printf '#include "common.h"\n%s\n' "${src[$name]}" >"$work/$name.cpp"
	g++ -O2 -o "$work/$name" "$work/$name.cpp"
done

failed=0
# run <program> <expected exit code> <min time> <max time>
run() {
	local name=$1 code=$2 min=$3 max=$4 start out status=0 time
	start=$(date +%s%N)
	out=$(cd "$work" && ./watcher "./$name" "" "" "$name.out" "$name.err" 1000 256 1000 256 "" "" 1100 3200) || status=$?
	time=$(head -n1 <<<"$out")
	printf '%-7s exit %d, time %5s ms, real %4d ms\n' "$name" "$status" "$time" $((($(date +%s%N) - start) / 1000000))
	if [[ $status != "$code" ]] || ((time < min || time > max)); then
		echo "  expected exit $code and a time in [$min, $max]"
		failed=1
	fi
}
# exit codes: 0 AC, 3 TLE
run ok 0 0 100
run kernel 0 690 1000 # 700 ms user + 600 ms system time: within the limit
run over 3 1040 1100  # a little over: TLE with its time (it is judged again)
run spin 3 1100 1150  # stopped once its user time exceeds 1100 ms
run sleep 3 -1 -1     # stopped after 3200 ms of real time, no meaningful time
exit $failed
