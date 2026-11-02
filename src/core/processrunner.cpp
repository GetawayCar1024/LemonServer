/*
 * SPDX-FileCopyrightText: 2019-2022 Project LemonLime
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#include "processrunner.h"

#include <QtMath>

#ifdef Q_OS_WIN32
#include "processrunner_win.h"
#else
#include "processrunner_unix.h"
#endif

ProcessRunner::ProcessRunner(ProcessRunnerConfig cfg, QFuture<void> cancelFuture)
    : config(std::move(cfg)), cancellation(std::move(cancelFuture)) {}

auto ProcessRunner::create(ProcessRunnerConfig config, QFuture<void> cancellation)
    -> std::unique_ptr<ProcessRunner> {
#ifdef Q_OS_WIN32
	return std::make_unique<WinProcessRunner>(std::move(config), std::move(cancellation));
#else
	return std::make_unique<UnixProcessRunner>(std::move(config), std::move(cancellation));
#endif
}

auto ProcessRunner::rejudgeTimeLimit(int timeLimit, double extraTimeRatio) -> int {
	return qFloor(qMax(timeLimit * (1 + extraTimeRatio), timeLimit + 1000 * extraTimeRatio) + 1e-6);
}

auto ProcessRunner::wallTimeLimit(const ProcessRunnerConfig &config) -> int {
	return rejudgeTimeLimit(config.timeLimit, config.extraTimeRatio) * 2 + 1000;
}
