/*
 * SPDX-FileCopyrightText: 2026 LemonServer contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#pragma once

#include <QDateTime>
#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QObject>
#include <QPair>
#include <QString>
#include <QVector>

class Contest;
class Settings;
class ServerConfig;

// Plays the role of the LemonLime main window for the server: it owns the currently opened
// contest (the judging core works relative to the current directory, exactly like the desktop
// application), loads/saves .cdf files and drives Contest::judge().
class ContestManager : public QObject {
	Q_OBJECT
  public:
	ContestManager(Settings *settings, ServerConfig *config, QObject *parent = nullptr);
	~ContestManager() override;

	static bool isValidContestName(const QString &name);

	QJsonArray listContests() const;
	bool createContest(const QString &name, const QString &title, QString *error);
	bool deleteContest(const QString &name, QString *error);
	// Folder where an uploaded contest is assembled before it is imported.
	QString importStagingDir(const QString &name) const;
	// Turn the staging folder (containing a .cdf, possibly inside one top-level folder) into a contest.
	// An empty name means "use the folder / .cdf name". Returns the final contest name.
	bool importContest(const QString &stagingDir, QString name, bool overwrite, QString *finalName, QString *error);

	// Make `name` the current contest (loads it if necessary).
	Contest *open(const QString &name, QString *error);
	void close();
	bool save(QString *error = nullptr);

	Contest *current() const { return contest; }
	const QString &currentName() const { return contestName; }
	QString currentDir() const;
	QString currentCdfPath() const;
	bool isJudging() const { return judging; }

	// LemonLime main-window features
	QJsonArray scanNewTasks() const;
	int addTasks(const QJsonArray &tasks);
	QJsonObject cleanupSourceFiles(bool backup);

	// judging
	bool startJudge(const QList<std::pair<QString, QVector<int>>> &list, QString *error);
	void stopJudge();
	QJsonObject judgeStatus(qint64 since) const;

  private slots:
	void onSingleCaseFinished(const QString &contestant, int progress, int x, int y, int result, int score,
	                          int timeUsed, qint64 memoryUsed);
	void onSubtaskDependenceFinished(int x, int y, int status);
	void onTaskJudgingStarted(const QString &contestant, const QString &taskName);
	void onCompileFinished(const QString &contestant, const QString &taskName, int state);
	void onTaskJudgingFinished();
	void onCompileError(int progress, int state);

  private:
	QString contestDir(const QString &name) const;
	QString findCdf(const QString &dir) const;
	bool loadContest(const QString &cdfPath, QString *error);
	void connectContest();
	void pushEvent(QJsonObject event);
	void runJudge(const QList<std::pair<QString, QVector<int>>> &list);

	Settings *settings;
	ServerConfig *config;
	Contest *contest = nullptr;
	QString contestName;
	QString cdfFile;

	// judging state
	bool judging = false;
	bool stopRequested = false;
	qint64 progressValue = 0;
	qint64 progressMaximum = 0;
	int tasksDone = 0;
	int tasksTotal = 0;
	QDateTime judgeStarted;
	QDateTime judgeFinished;
	QDateTime lastSave;
	qint64 nextEventId = 1;
	QList<QJsonObject> events;
};
