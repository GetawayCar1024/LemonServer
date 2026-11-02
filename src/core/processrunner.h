/*
 * SPDX-FileCopyrightText: 2019-2022 Project LemonLime
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#pragma once

#include "base/LemonType.hpp"
#include "base/sandboxsettings.h"
#include <QFuture>
#include <QProcessEnvironment>
#include <QString>
#include <QtGlobal>
#include <memory>

class WindowsSandboxSession;

struct ProcessRunnerConfig {
	QString executableFile;
	QString arguments;
	QString workingDirectory;
	QString inputFile;
	QProcessEnvironment environment;
	int timeLimit{};
	int rawTimeLimit{};
	int memoryLimit{};
	int rawMemoryLimit{};
	double extraTimeRatio{};
	bool standardInputCheck{};
	bool standardOutputCheck{};
	QString inputFileName;
	QString outputFileName;
	bool interpreterAsWatcher{};
	SandboxSettings sandboxSettings;
	// The trusted compiler/interpreter selected by the user, never a submission.
	QString runtimeExecutable;
	QProcessEnvironment runtimeEnvironment;
	std::shared_ptr<WindowsSandboxSession> sandboxSession;
};

struct ProcessRunnerResult {
	ResultState result = CorrectAnswer;
	int score = 0;
	int timeUsed = -1;
	qint64 memoryUsed = -1;
	QString message;
	qint64 preparationTime = 0;
	int runtimeAclUpdates = 0;
	bool runtimeCacheHit = false;
};

class ProcessRunner {
  public:
	ProcessRunner(ProcessRunnerConfig config, QFuture<void> cancellation);
	virtual ~ProcessRunner() = default;

	virtual ProcessRunnerResult run() = 0;

	static std::unique_ptr<ProcessRunner> create(ProcessRunnerConfig config, QFuture<void> cancellation);

	// A run is judged by its user CPU time, the time shown in the results. A run that is over the limit by
	// at most this much (ms, it may have been slowed down) is judged again, see CaseJudger.
	static auto rejudgeTimeLimit(int timeLimit, double extraTimeRatio) -> int;
	// A running program is stopped once its user CPU time exceeds rejudgeTimeLimit() (it cannot pass any
	// more), or after this much real time (ms; a program that waits). Starting the program, reading and
	// writing files or other judging threads must not turn into a time limit exceeded.
	static auto wallTimeLimit(const ProcessRunnerConfig &config) -> int;

  protected:
	ProcessRunnerConfig config;
	QFuture<void> cancellation;
};
