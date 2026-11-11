/*
 * SPDX-FileCopyrightText: 2011-2018 Project Lemon, Zhipeng Jia
 * SPDX-FileCopyrightText: 2018-2019 Project LemonPlus, Dust1404
 * SPDX-FileCopyrightText: 2019-2022 Project LemonLime
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#include "contest.h"

#include "base/LemonLog.hpp"
#include "base/LemonUtils.hpp"
#include "base/compiler.h"
#include "base/settings.h"
#include "core/contestant.h"
#include "core/judgingcontroller.h"
#include "core/task.h"
#include "core/taskjudger.h"
#include "core/testcase.h"

#include <QDataStream>
#include <QEventLoop>
#include <QJsonObject>
#include <algorithm>
#include <cmath>
#include <utility>

#define LEMON_MODULE_NAME "Contest"

Contest::Contest(QObject *parent) : QObject(parent) {}

void Contest::setSettings(Settings *_settings) { settings = _settings; }

void Contest::copySettings(Settings &_settings) { _settings.copyFrom(settings); }

void Contest::setContestTitle(const QString &title) { contestTitle = title; }

auto Contest::getContestTitle() const -> const QString & { return contestTitle; }

auto Contest::getTask(int index) const -> Task * {
	if (0 <= index && index < taskList.size()) {
		return taskList[index];
	}

	return nullptr;
}

auto Contest::getTaskList() const -> const QList<Task *> & { return taskList; }

void Contest::swapTask(int a, int b) {
	if (0 <= a && a < taskList.size()) {
		if (0 <= b && b < taskList.size()) {
			taskList.swapItemsAt(a, b);
		}
	}

	for (auto &i : contestantList)
		i->swapTask(a, b);
}

auto Contest::getContestant(const QString &name) const -> Contestant * {
	if (contestantList.contains(name)) {
		return contestantList.value(name);
	}

	return nullptr;
}

auto Contest::getContestantList() const -> QList<Contestant *> { return contestantList.values(); }

auto Contest::getTotalTimeLimit() const -> int {
	int total = 0;

	for (auto *i : taskList) {
		QList<TestCase *> testCaseList = i->getTestCaseList();

		for (auto &j : testCaseList) {
			total += j->getTimeLimit() * j->getInputFiles().size();
		}
	}

	return total;
}

auto Contest::getTotalScore() const -> Score {
	Score total = 0;

	for (auto *i : taskList) {
		total += i->getTotalScore();
	}

	return total;
}

void Contest::addTask(Task *task) {
	taskList.append(task);
	connect(task, &Task::problemTitleChanged, this, &Contest::problemTitleChanged);
	emit taskAddedForContestant();
	emit taskAddedForViewer();
}

void Contest::deleteTask(int index) {
	if (0 <= index && index < taskList.size()) {
		delete taskList[index];
		taskList.removeAt(index);
	}

	emit taskDeletedForContestant(index);
	emit taskDeletedForViewer(index);
}

void Contest::setContestDirectory(const QString &dir) {
	contestDirectory = dir.isEmpty() ? QString() : QDir::toNativeSeparators(QDir(dir).absolutePath()) + QDir::separator();
}

QString Contest::dataPath() const { return contestDirectory + Settings::dataPath(); }

QString Contest::sourcePath() const { return contestDirectory + Settings::sourcePath(); }

void Contest::refreshContestantList() {
	QStringList nameList =
	    QDir(sourcePath()).entryList(QStringList(), QDir::Dirs | QDir::NoDotAndDotDot);
	QStringList curNameList = contestantList.keys();

	for (int i = 0; i < curNameList.size(); i++) {
		if (! nameList.contains(curNameList[i])) {
			delete contestantList[curNameList[i]];
			contestantList.remove(curNameList[i]);
		}
	}

	for (int i = 0; i < nameList.size(); i++) {
		if (! contestantList.contains(nameList[i])) {
			auto *newContestant = new Contestant(this);
			newContestant->setContestantName(nameList[i]);

			for (int j = 0; j < taskList.size(); j++) {
				newContestant->addTask();
			}

			contestantList.insert(nameList[i], newContestant);
			connect(this, &Contest::taskAddedForContestant, newContestant, &Contestant::addTask);
			connect(this, &Contest::taskDeletedForContestant, newContestant, &Contestant::deleteTask);
		}
	}
}

void Contest::deleteContestant(const QString &name) {
	if (! contestantList.contains(name))
		return;

	delete contestantList[name];
	contestantList.remove(name);
}

void Contest::clearPath(const QString &curDir) {
	QDir dir(curDir);
	QStringList fileList = dir.entryList(QDir::Files);

	for (int i = 0; i < fileList.size(); i++) {
		if (! dir.remove(fileList[i])) {
#ifdef Q_OS_WIN32
			QProcess::execute(QString("attrib"), QStringList("-R") + QStringList(curDir + fileList[i]));
#else
			QProcess::execute(QString("chmod"), QStringList("+w") + QStringList(curDir + fileList[i]));
#endif
			dir.remove(fileList[i]);
		}
	}

	QStringList dirList = dir.entryList(QDir::AllDirs | QDir::NoDotAndDotDot);

	for (int i = 0; i < dirList.size(); i++) {
		clearPath(curDir + dirList[i] + QDir::separator());
		dir.rmdir(dirList[i]);
	}
}

void Contest::judge(const QVector<std::pair<Contestant *, int>> &judgingTasks) {
	LOG("Start Judging");
	controller = new JudgingController(settings);
	judgingCanceled = false;
	connect(controller, &JudgingController::taskJudged, this, &Contest::taskJudgingFinished);
	QMap<Contestant *, QDateTime> previousJudgingTime;
	for (auto [contestant, i] : judgingTasks)
		if (! previousJudgingTime.contains(contestant))
			previousJudgingTime.insert(contestant, contestant->getJudingTime());

	for (auto [contestant, i] : judgingTasks) {
		TaskJudger *taskJudger = new TaskJudger();
		connect(taskJudger, &TaskJudger::singleCaseFinished, this, &Contest::singleCaseFinished);
		connect(taskJudger, &TaskJudger::compileError, this, &Contest::compileError);
		connect(taskJudger, &TaskJudger::judgingStarted, this, &Contest::taskJudgingStarted);
		const QString contestantName = contestant->getContestantName();
		const QString taskTitle = taskList[i]->getProblemTitle();
		connect(taskJudger, &TaskJudger::judgingStarted, this,
		        [this, contestantName, taskTitle] { emit taskJudgingStartedFor(contestantName, taskTitle); });
		connect(taskJudger, &TaskJudger::compileError, this, [this, contestantName, taskTitle](int, int state) {
			emit compileFinishedFor(contestantName, taskTitle, state);
		});
		taskJudger->setTask(taskList[i]);
		taskJudger->setSettings(settings);
		taskJudger->setContestantName(contestant->getContestantName());
		taskJudger->setPaths(dataPath(), sourcePath());
		controller->addTask(taskJudger, contestant, i);
		contestant->setJudgingTime(QDateTime::currentDateTime());
	}

	auto eventLoop = new QEventLoop();
	connect(controller, &JudgingController::judgeFinished, eventLoop, &QEventLoop::quit,
	        Qt::QueuedConnection);

	controller->start();

	eventLoop->exec();

	if (judgingCanceled) {
		// nothing of these contestants was judged again: their results (and judging time) are unchanged
		for (auto it = previousJudgingTime.cbegin(); it != previousJudgingTime.cend(); ++it)
			if (! controller->updatedContestants().contains(it.key()))
				it.key()->setJudgingTime(it.value());
	}
	delete eventLoop;
	delete controller;
	controller = nullptr;
	LOG("Judging Finished");
}

void Contest::judge(const QList<std::pair<QString, QVector<int>>> &list) {
	QVector<std::pair<Contestant *, int>> judgingTasks;
	for (int i = 0; i < list.size(); i++) {
		auto contestant = contestantList.value(list[i].first);
		for (int j = 0; j < list[i].second.size(); j++)
			judgingTasks.push_back({contestant, list[i].second[j]});
	}
	judge(judgingTasks);
}

void Contest::judgeAll() {
	QVector<std::pair<Contestant *, int>> judgingTasks;
	for (auto contestant : contestantList) {
		for (int i = 0; i < taskList.size(); i++) {
			judgingTasks.append({contestant, i});
		}
	}
	judge(judgingTasks);
}

void Contest::stopJudgingSlot() {
	if (controller)
		controller->stop();
}

void Contest::cancelJudgingSlot() {
	if (controller) {
		judgingCanceled = true;
		controller->cancel();
	}
}

void Contest::writeToJson(QJsonObject &out) {
	QString version = "1.0";

	WRITE_JSON(out, contestTitle);

	QJsonArray tasks;

	for (const auto &i : taskList) {
		QJsonObject obj;
		i->writeToJson(obj);
		tasks.append(obj);
		for (const auto *testCase : i->getTestCaseList())
			if (std::trunc(testCase->getFullScore()) != testCase->getFullScore()) version = "1.1";
	}

	WRITE_JSON(out, tasks);

	QJsonArray contestants;

	for (const auto &i : contestantList) {
		QJsonObject obj;
		i->writeToJson(obj);
		contestants.append(obj);
		for (const auto &task : obj["score"].toArray())
			for (const auto &group : task.toArray())
				for (const auto &point : group.toArray())
					if (std::trunc(point.toDouble()) != point.toDouble()) version = "1.1";
	}

	WRITE_JSON(out, contestants);
	// Old integer-only readers reject fractional files instead of silently rounding them.
	WRITE_JSON(out, version);
}
int Contest::readFromJson(const QJsonObject &in) {
	QString version;

	// If there's no version number, consider as version 1.0

	if (READ_JSON(in, version) != -1) {
		if (version != "1.0" && version != "1.1")
			return -1;
	}

	READ_JSON(in, contestTitle);

	QJsonArray tasks;
	READ_JSON(in, tasks);

	// NOTE: taskList and contestantList are empty here because readFromJson is
	// only ever called once on a freshly constructed Contest (immediately after
	// construction, before any tasks or contestants are added). If this invariant
	// ever changes, qDeleteAll() must be called before clear() to avoid leaks.
	taskList.clear();
	for (const auto &task : tasks) {
		Task *newTask = new Task();
		if (newTask->readFromJson(task.toObject()) == -1) {
			delete newTask;
			return -1;
		}
		newTask->refreshCompilerConfiguration(settings);
		taskList.append(newTask);
	}

	QJsonArray contestants;
	READ_JSON(in, contestants);

	// See note above: contestantList is also empty at this point.
	contestantList.clear();
	for (const auto &contestant : contestants) {
		auto *newContestant = new Contestant();
		if (newContestant->readFromJson(contestant.toObject()) == -1) {
			delete newContestant;
			return -1;
		}
		connect(this, &Contest::taskAddedForContestant, newContestant, &Contestant::addTask);
		connect(this, &Contest::taskDeletedForContestant, newContestant, &Contestant::deleteTask);
		contestantList.insert(newContestant->getContestantName(), newContestant);
	}
	return 0;
}
void Contest::readFromStream(QDataStream &in) {
	int count = 0;
	in >> contestTitle;
	in >> count;

	for (int i = 0; i < count; i++) {
		Task *newTask = new Task();
		newTask->readFromStream(in);
		newTask->refreshCompilerConfiguration(settings);
		taskList.append(newTask);
	}

	in >> count;

	for (int i = 0; i < count; i++) {
		auto *newContestant = new Contestant();
		newContestant->readFromStream(in);
		connect(this, &Contest::taskAddedForContestant, newContestant, &Contestant::addTask);
		connect(this, &Contest::taskDeletedForContestant, newContestant, &Contestant::deleteTask);
		contestantList.insert(newContestant->getContestantName(), newContestant);
	}
}
