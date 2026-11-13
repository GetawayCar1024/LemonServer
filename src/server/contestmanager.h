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
#include <QMap>
#include <QObject>
#include <QPair>
#include <QSet>
#include <QString>
#include <QVector>
#include "base/LemonType.hpp"

class Contest;
class Settings;
class ServerConfig;

// Plays the role of the LemonLime main window for the server: it loads/saves .cdf files and drives
// Contest::judge(). Several contests can be loaded at the same time; the "current" one is the contest of
// the request being handled (the current directory is its folder, for the request-scoped helpers that
// use LemonLime's relative data/ and source/ paths). Judging uses absolute paths
// (Contest::setContestDirectory), so it does not depend on the current directory.
//
// All judging requests, of any contest, go through one queue and are judged one after another (each run
// still uses LemonLime's thread pool). A contest that is being judged or waiting in the queue is "busy":
// it can be viewed, but not edited, until its jobs are removed from the queue.
class ContestManager : public QObject {
	Q_OBJECT
  public:
	ContestManager(Settings *settings, ServerConfig *config, QObject *parent = nullptr);
	~ContestManager() override;

	static bool isValidContestName(const QString &name);

	QJsonArray listContests() const;
	bool createContest(const QString &name, const QString &title, QString *error);
	bool deleteContest(const QString &name, QString *error);
	// Copy a contest (tasks, data and the other files of its folder) to a new one. Without submissions,
	// source/, the results and exported result files are left out. The contest time is not copied.
	bool cloneContest(const QString &from, const QString &to, const QString &title, bool withSubmissions,
	                  QString *error);
	// Folder where an uploaded contest is assembled before it is imported.
	QString importStagingDir(const QString &name) const;
	// Turn the staging folder (containing a .cdf, possibly inside one top-level folder) into a contest.
	// An empty name means "use the folder / .cdf name". Returns the final contest name.
	bool importContest(const QString &stagingDir, QString name, bool overwrite, QString *finalName, QString *error);

	// Make `name` the current contest (loads it if necessary).
	Contest *open(const QString &name, QString *error);
	// Save and unload every contest.
	void closeAll();
	// Save the current contest.
	bool save(QString *error = nullptr);

	Contest *current() const { return contest; }
	const QString &currentName() const { return contestName; }
	QString currentDir() const;
	QString currentCdfPath() const;

	// LemonLime main-window features (current contest)
	QJsonArray scanNewTasks() const;
	int addTasks(const QJsonArray &tasks, QString *error = nullptr);
	QJsonObject cleanupSourceFiles(bool backup);
	// A file or folder under source/<who>/<rest...> of the current contest was changed through the API:
	// the results of the affected tasks are outdated, mark them as not judged (so that "unjudged" picks
	// them up again). An empty `rest` means the whole folder of the contestant. Returns the cells marked.
	int markSourceChanged(const QString &who, const QStringList &rest);

	// LemonServer's own contest properties, stored in <contest>/lemonserver.json next to the .cdf
	// (integer CDF stays compatible; fractional scores use version 1.1). The functions without a name
	// are about the current contest.
	static constexpr const char *kPropertiesFile = "lemonserver.json";
	QString currentPropertiesPath() const;
	// down.zip of the contest, relative to the contest folder (empty = not set).
	QString downZip() const;
	bool setDownZip(const QString &relativePath, QString *error);
	QJsonObject propertiesJson() const;
	bool isArchived(const QString &name) const;
	bool isPublic(const QString &name) const;
	bool setArchived(bool archived, QString *error);
	// Archived contests can be made public or private too: this does not change their data.
	bool setPublic(bool visible, QString *error);
	quint64 revision(const QString &name = QString()) const;

	// Several CodeHub servers may share one contest. The first one to create a contestant's folder under
	// source/ owns that contestant ("owners" in lemonserver.json, by the X-CodeHub-Instance header); each
	// CodeHub only sees, uploads and judges its own contestants. Other clients are not restricted.
	QString ownerOf(const QString &who) const;
	// Claim `who` of the current contest for `owner`. Returns false with *conflict set when another owner
	// has it, or false with an error when lemonserver.json cannot be written.
	bool claimContestant(const QString &who, const QString &owner, bool *conflict, QString *error);
	// Forget the owner (the contestant was deleted).
	void releaseContestant(const QString &who);
	bool ownedBy(const QString &contest, const QString &who, const QString &owner) const;

	// ---------------- judging queue ----------------
	// Queue a judging request of the current contest ({"mode", "items", "compileStates", "resultStates",
	// "refresh"}, see LemonServer). The cells to judge are chosen when the job starts. Returns the job
	// (id, position: 0 = being judged / starts now). `nothingToJudge` is set when the request is empty.
	bool enqueueJudge(const QJsonObject &request, QJsonObject *job, QString *error, bool *nothingToJudge);
	// Remove a waiting job, or stop it if it is being judged.
	bool cancelJob(qint64 id, QString *error);
	// Remove every waiting job of a contest and stop it if it is being judged. Returns the jobs affected.
	int dequeueContest(const QString &name);
	// Stop the running job if it belongs to `name`: the cells being judged become "not judged".
	bool stopJudge(const QString &name);
	// Cancel the running job if it belongs to `name`: every cell not judged to the end keeps its previous result.
	bool cancelJudge(const QString &name);
	bool isJudging() const { return judging; }
	// Being judged or waiting in the queue.
	bool isBusy(const QString &name) const;
	bool hasQueuedJobs() const { return ! queue.isEmpty(); }
	QString judgingContest() const { return judging ? running.contest : QString(); }
	int queuedJobs(const QString &name) const;
	QJsonObject queueJson() const;
	// Progress of the running job (or the last one) and its events with id > since.
	QJsonObject judgeStatus(qint64 since) const;

  private slots:
	void onSingleCaseFinished(const QString &contestant, int progress, int x, int y, int result, Score score,
	                          int timeUsed, qint64 memoryUsed);
	void onSubtaskDependenceFinished(int x, int y, int status);
	void onTaskJudgingStarted(const QString &contestant, const QString &taskName);
	void onCompileFinished(const QString &contestant, const QString &taskName, int state);
	void onTaskJudgingFinished();
	void onCompileError(int progress, int state);

  private:
	struct Loaded {
		Contest *contest = nullptr;
		QString cdfFile;
		QJsonObject properties;
		QDateTime lastUsed;
		bool dirty = false;
		quint64 revision = 0;
	};
	struct ListSnapshot { qint64 size = -1; QDateTime modified; QJsonObject value; };
	struct Job {
		qint64 id = 0;
		QString contest;
		QJsonObject request;
		QDateTime queued;
		QString mode() const;
	};

	// The name of the contest folder as it is on disk (folder names are case-insensitive on Windows).
	QString canonicalName(const QString &name) const;
	QString contestDir(const QString &name) const;
	QString findCdf(const QString &dir) const;
	Contest *loadContest(const QString &cdfPath, QString *error);
	void addLoaded(const QString &name, Contest *c, const QString &cdfFile);
	void unload(const QString &name);
	void evictIdleContests(const QString &keep);
	void connectContest(Contest *c);
	bool saveContest(const QString &name, QString *error = nullptr);
	void touch(const QString &name, bool dirty = true);
	void pushEvent(QJsonObject event);
	void scheduleNext();
	void startNext();
	void runJudge(const QList<std::pair<QString, QVector<int>>> &list);
	QJsonObject jobJson(const Job &job, int position) const;
	// A request made by a CodeHub server ("owner") only judges the contestants it owns.
	void restrictToOwner(const QString &contest, const QJsonObject &request, QMap<QString, QVector<int>> *mapping) const;
	QJsonObject propertiesOf(const QString &name) const;
	static QJsonObject readProperties(const QString &dir);
	static bool saveProperties(const QString &dir, const QJsonObject &properties, QString *error);
	bool writeProperties(QString *error);
	const QJsonObject &props() const;

	Settings *settings;
	ServerConfig *config;
	QMap<QString, Loaded> loaded;
	mutable QMap<QString, ListSnapshot> listSnapshots;
	quint64 nextRevision = 1;
	Contest *contest = nullptr; // current contest
	QString contestName;

	// judging
	QList<Job> queue;
	Job running; // the job being judged (or the last one)
	qint64 nextJobId = 1;
	bool judging = false;
	bool nextScheduled = false;
	bool stopRequested = false;
	bool cancelRequested = false;
	bool saveScheduled = false;
	qint64 progressValue = 0;
	qint64 progressMaximum = 0;
	int tasksDone = 0;
	int tasksTotal = 0;
	QDateTime judgeStarted;
	QDateTime judgeFinished;
	QMap<QString, QDateTime> lastSaved;
	// cells ("<contestant>\n<task index>") whose source changed while judging; marked again afterwards
	QSet<QString> changedWhileJudging;
	qint64 nextEventId = 1;
	QList<QJsonObject> events;
};
