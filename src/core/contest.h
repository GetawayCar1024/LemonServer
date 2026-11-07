/*
 * SPDX-FileCopyrightText: 2011-2018 Project Lemon, Zhipeng Jia
 *                         2018-2019 Project LemonPlus, Dust1404
 *                         2019-2022 Project LemonLime
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#pragma once
//

#include "base/LemonType.hpp"

#include <QJsonObject>
#include <QObject>
#include <QString>
#include <QStringList>

#define MagicNumber 0x20111127

class Task;
class Settings;
class Contestant;
class JudgingController;

class Contest : public QObject {
	Q_OBJECT
  public:
	explicit Contest(QObject *parent = nullptr);
	void setSettings(Settings *);
	void copySettings(Settings &);
	void setContestTitle(const QString &);
	const QString &getContestTitle() const;
	Task *getTask(int) const;
	void swapTask(int, int);
	const QList<Task *> &getTaskList() const;
	Contestant *getContestant(const QString &) const;
	QList<Contestant *> getContestantList() const;
	int getTotalTimeLimit() const;
	int getTotalScore() const;
	void addTask(Task *);
	void deleteTask(int);
	void refreshContestantList();
	void deleteContestant(const QString &);
	void writeToJson(QJsonObject &);
	void readFromStream(QDataStream &);
	int readFromJson(const QJsonObject &);
	// Folder of the contest. When it is set, judging reads data/ and source/ from it, so that it does not
	// depend on the current directory; when empty (the default) they are relative to the current directory.
	void setContestDirectory(const QString &);
	QString dataPath() const;
	QString sourcePath() const;

  private:
	QString contestTitle;
	QString contestDirectory;
	Settings *settings{};
	QList<Task *> taskList;
	QMap<QString, Contestant *> contestantList;
	void judge(Contestant *);
	void judge(const QVector<std::pair<Contestant *, int>> &);
	void clearPath(const QString &);
	JudgingController *controller{};
	bool judgingCanceled = false;

  public slots:
	void judge(const QList<std::pair<QString, QVector<int>>> &);
	void judgeAll();
	// void judgeFinished();
	void stopJudgingSlot();
	// Stop judging, keeping the previous results of everything not judged to the end.
	void cancelJudgingSlot();

  signals:
	void taskAddedForContestant();
	void taskDeletedForContestant(int);
	void taskAddedForViewer();
	void taskDeletedForViewer(int);
	void problemTitleChanged();
	void dialogAlert(QString);
	void singleCaseFinished(QString, int, int, int, int, int, int, qint64);
	void singleSubtaskDependenceFinished(int, int, int);
	void taskJudgingStarted(QString);
	void taskJudgingFinished();
	void taskJudgedDisplay(const QString &, const QList<QList<int>> &, const int);
	void contestantJudgingStart(QString);
	void contestantJudgingFinished();
	void contestantJudgedDisplay(const QString &, const int, const int);
	void compileError(int, int);
	void stopJudgingSignal();
	// Same events as taskJudgingStarted / compileError, but telling which contestant and task they belong to.
	void taskJudgingStartedFor(const QString &contestant, const QString &task);
	void compileFinishedFor(const QString &contestant, const QString &task, int compileState);
};
