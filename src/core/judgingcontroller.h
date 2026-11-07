/*
 * SPDX-FileCopyrightText: 2021-2022 Project LemonLime
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */
#pragma once

#include "taskresult.h"

#include <QFutureWatcher>
#include <QMap>
#include <QObject>
#include <QQueue>
#include <QSet>
#include <QThreadPool>
#include <memory>

class Contestant;
class Settings;
class SleepInhibitor;
class TaskJudger;

class JudgingController : public QObject {
	Q_OBJECT

  public:
	explicit JudgingController(const Settings *settings, QObject *parent = nullptr);
	~JudgingController() override;
	void addTask(TaskJudger *judger, Contestant *contestant, int taskId);
	// Contestants that received at least one new result in this run.
	const QSet<Contestant *> &updatedContestants() const { return updated; }

  public slots:
	void start();
	// Stop: the tasks being judged become "not judged"; the waiting ones keep their previous results.
	void stop();
	// Cancel: like stop(), but the tasks being judged keep their previous results too.
	void cancel();

  signals:
	void taskJudged();
	void judgeFinished();

  private:
	struct PendingTask {
		TaskJudger *judger;
		Contestant *contestant;
		int taskId;
	};

	void assign();
	void finishTask(QFutureWatcher<TaskResult> *watcher);

	QThreadPool threadPool;
	QQueue<PendingTask> queuingTasks;
	QMap<QFutureWatcher<TaskResult> *, PendingTask> runningTasks;
	bool isJudging = false;
	bool keepPrevious = false;
	QSet<Contestant *> updated;
	bool preventSleepWhileJudging;
	std::unique_ptr<SleepInhibitor> sleepInhibitor;
};
