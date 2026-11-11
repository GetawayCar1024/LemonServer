/*
 * SPDX-FileCopyrightText: 2020-2022 Project LemonLime
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#pragma once
//

enum CompileState {
	CompileSuccessfully,
	NoValidSourceFile,
	CompileError,
	CompileTimeLimitExceeded,
	InvalidCompiler,
	NoValidGraderFile
};

enum ResultState {
	CorrectAnswer,
	WrongAnswer,
	PartlyCorrect,
	TimeLimitExceeded,
	MemoryLimitExceeded,
	CannotStartProgram,
	FileError,
	RunTimeError,
	InvalidSpecialJudge,
	SpecialJudgeTimeLimitExceeded,
	SpecialJudgeRunTimeError,
	Skipped,
	InteractorError,
	PresentationError,
	OutputLimitExceeded,
	LastResultState
};

#include <QList>
#include <QString>
#include <QStringList>

// Scores are real-valued; timing, verdicts and dependency-status codes remain integral.
using Score = double;
inline QString scoreText(Score value) { return QString::number(value, 'g', 12); }

/* struct TaskResult {
    CompileState compileState;
    QString compileMessage;
    QString sourceFile;
    QList<QList<ResultState>> resultState;
    QList<QStringList> resultMessage;
    QList<QList<int>> scores;
    QList<QList<int>> timeUsed;
    QList<QList<int>> memoryUsed;
    QList<QStringList> inputFiles;
}; */
