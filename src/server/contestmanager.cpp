/*
 * SPDX-FileCopyrightText: 2026 LemonServer contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#include "contestmanager.h"
#include "serverconfig.h"

#include "base/LemonLog.hpp"
#include "base/LemonUtils.hpp"
#include "base/settings.h"
#include "core/contest.h"
#include "core/contestant.h"
#include "core/task.h"
#include "core/testcase.h"

#include <QDataStream>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSaveFile>
#include <QSet>
#include <QTimer>
#include <algorithm>

#define LEMON_MODULE_NAME "ContestManager"

namespace {
	// Same helpers as in lemon.cpp (LemonLime main window)
	void removePath(const QString &path) {
		if (path.isEmpty())
			return;
		QDir dir(path);
		if (! dir.exists())
			return;
		dir.setFilter(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden);
		for (const auto &fi : dir.entryInfoList()) {
			if (fi.isFile() || fi.isSymLink())
				fi.dir().remove(fi.fileName());
			else
				removePath(fi.absoluteFilePath());
		}
		dir.rmpath(dir.absolutePath());
	}

	void copyPath(const QString &fromPath, const QString &toPath) {
		QDir dir(fromPath);
		if (! dir.exists())
			return;
		QString fpath = fromPath + QDir::separator();
		QString tpath = toPath + QDir::separator();
		dir.setFilter(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden);
		for (const auto &fi : dir.entryInfoList()) {
			QString fn = fpath + fi.fileName();
			QString tn = tpath + fi.fileName();
			if (fi.isFile() || fi.isSymLink())
				QFile::copy(fn, tn);
			else {
				QDir toDir(toPath);
				toDir.mkpath(fi.fileName());
				copyPath(fn, tn);
			}
		}
	}

	void getFiles(const QString &path, const QStringList &filters, QMap<QString, QString> &files) {
		QDir dir(path);
		if (! filters.isEmpty())
			dir.setNameFilters(filters);
		for (auto &i : dir.entryInfoList(QDir::Files))
			files.insert(i.completeBaseName(), i.fileName());
	}
} // namespace

ContestManager::ContestManager(Settings *settings, ServerConfig *config, QObject *parent)
    : QObject(parent), settings(settings), config(config) {}

ContestManager::~ContestManager() { close(); }

bool ContestManager::isValidContestName(const QString &name) {
	static const QRegularExpression invalid(R"([<>:"/\\|?*\x00-\x1f])");
	const QString n = name.trimmed();
	return ! n.isEmpty() && n == name && n != "." && n != ".." && ! n.contains(invalid) && ! n.endsWith('.') &&
	       n.size() <= 128;
}

QString ContestManager::contestDir(const QString &name) const {
	return QDir(config->contestRoot()).absoluteFilePath(name);
}

QString ContestManager::findCdf(const QString &dir) const {
	QDir d(dir);
	const QString preferred = d.dirName() + ".cdf";
	if (d.exists(preferred))
		return d.absoluteFilePath(preferred);
	const auto list = d.entryList({"*.cdf"}, QDir::Files, QDir::Name);
	return list.isEmpty() ? QString() : d.absoluteFilePath(list.first());
}

QString ContestManager::currentDir() const { return contest ? contestDir(contestName) : QString(); }

QString ContestManager::currentCdfPath() const {
	return contest ? QDir(currentDir()).absoluteFilePath(cdfFile) : QString();
}

QJsonArray ContestManager::listContests() const {
	QJsonArray arr;
	if (config->contestRoot().isEmpty())
		return arr;
	QDir root(config->contestRoot());
	for (const auto &name : root.entryList(QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name)) {
		const QString cdf = findCdf(root.absoluteFilePath(name));
		if (cdf.isEmpty())
			continue;
		QJsonObject item{{"name", name}, {"cdf", QFileInfo(cdf).fileName()},
		                 {"modified", QFileInfo(cdf).lastModified().toString("yyyy-MM-dd hh:mm:ss")},
		                 {"current", contest && name == contestName}};
		QFile f(cdf);
		if (f.open(QFile::ReadOnly)) {
			char first = 0;
			f.peek(&first, 1);
			if (first == '{') {
				const auto obj = QJsonDocument::fromJson(f.readAll()).object();
				item["title"] = obj["contestTitle"].toString();
				item["tasks"] = obj["tasks"].toArray().size();
				item["contestants"] = obj["contestants"].toArray().size();
			} else {
				item["title"] = name;
				item["legacyFormat"] = true;
			}
		}
		arr.append(item);
	}
	return arr;
}

bool ContestManager::createContest(const QString &name, const QString &title, QString *error) {
	if (config->contestRoot().isEmpty()) {
		*error = tr("Default contest folder is not configured");
		return false;
	}
	if (! isValidContestName(name)) {
		*error = tr("Invalid contest name");
		return false;
	}
	if (judging) {
		*error = tr("Judging is in progress");
		return false;
	}
	const QString dir = contestDir(name);
	if (QDir(dir).exists() && ! findCdf(dir).isEmpty()) {
		*error = tr("Contest already exists");
		return false;
	}
	// LemonLime::newContest()
	if (! QDir(dir).exists() && ! QDir().mkpath(dir)) {
		*error = tr("Cannot make contest path");
		return false;
	}
	close();
	contest = new Contest(this);
	contest->setSettings(settings);
	contest->setContestTitle(title.isEmpty() ? name : title);
	contestName = name;
	cdfFile = name + ".cdf";
	QDir::setCurrent(dir);
	QDir().mkdir(Settings::dataPath());
	QDir().mkdir(Settings::sourcePath());
	connectContest();

	LOG("New Contest -", name);
	return save(error);
}

bool ContestManager::deleteContest(const QString &name, QString *error) {
	if (! isValidContestName(name) || findCdf(contestDir(name)).isEmpty()) {
		*error = tr("Contest not found");
		return false;
	}
	if (judging) {
		*error = tr("Judging is in progress");
		return false;
	}
	if (contest && name == contestName) {
		close();
	}
	QDir::setCurrent(config->contestRoot());
	if (! QDir(contestDir(name)).removeRecursively()) {
		*error = tr("Cannot remove contest folder");
		return false;
	}
	return true;
}

void ContestManager::connectContest() {
	connect(contest, &Contest::singleCaseFinished, this, &ContestManager::onSingleCaseFinished);
	connect(contest, &Contest::singleSubtaskDependenceFinished, this,
	        &ContestManager::onSubtaskDependenceFinished);
	connect(contest, &Contest::taskJudgingStartedFor, this, &ContestManager::onTaskJudgingStarted);
	connect(contest, &Contest::taskJudgingFinished, this, &ContestManager::onTaskJudgingFinished);
	connect(contest, &Contest::compileError, this, &ContestManager::onCompileError);
	connect(contest, &Contest::compileFinishedFor, this, &ContestManager::onCompileFinished);
}

QString ContestManager::importStagingDir(const QString &name) const {
	return QDir(config->contestRoot()).absoluteFilePath(".lemon-import/" + name);
}

bool ContestManager::importContest(const QString &stagingDir, QString name, bool overwrite, QString *finalName,
                                   QString *error) {
	auto cleanup = qScopeGuard([&] {
		QDir(stagingDir).removeRecursively();
		QDir(config->contestRoot()).rmdir(".lemon-import"); // only succeeds when no other import is pending
	});
	if (config->contestRoot().isEmpty()) {
		*error = tr("Default contest folder is not configured");
		return false;
	}
	// The .cdf may be at the top level or inside a single folder (e.g. a zipped contest folder).
	QString source = stagingDir;
	if (findCdf(source).isEmpty()) {
		const auto dirs = QDir(source).entryList(QDir::Dirs | QDir::NoDotAndDotDot);
		const auto files = QDir(source).entryList(QDir::Files);
		if (dirs.size() == 1 && files.isEmpty() && ! findCdf(QDir(source).filePath(dirs.first())).isEmpty())
			source = QDir(source).filePath(dirs.first());
	}
	const QString cdf = findCdf(source);
	if (cdf.isEmpty()) {
		*error = tr("No .cdf file found in the uploaded contest");
		return false;
	}
	if (name.isEmpty())
		name = source == stagingDir ? QFileInfo(cdf).completeBaseName() : QFileInfo(source).fileName();
	if (! isValidContestName(name)) {
		*error = tr("Invalid contest name");
		return false;
	}
	const QString dest = contestDir(name);
	if (QFileInfo::exists(dest)) {
		if (! overwrite) {
			*error = tr("Contest %1 already exists").arg(name);
			return false;
		}
		if (judging && name == contestName) {
			*error = tr("Judging is in progress");
			return false;
		}
		if (contest && name == contestName)
			close();
		QDir::setCurrent(config->contestRoot());
		if (! QDir(dest).removeRecursively()) {
			*error = tr("Cannot remove contest folder");
			return false;
		}
	}
	if (! QDir().rename(source, dest)) {
		*error = tr("Cannot create contest folder %1").arg(dest);
		return false;
	}
	// Make sure the contest can actually be opened by LemonLime.
	if (! judging) {
		QString openError;
		if (! open(name, &openError)) {
			*error = openError;
			*finalName = name;
			return false;
		}
	}
	*finalName = name;
	LOG("Imported contest", name);
	return true;
}

bool ContestManager::loadContest(const QString &filePath, QString *error) {
	// LemonLime::loadContest()
	auto *newContest = new Contest(this);
	QFile file(filePath);

	if (! file.open(QFile::ReadOnly)) {
		*error = tr("Cannot open file %1").arg(QFileInfo(filePath).fileName());
		delete newContest;
		return false;
	}
	char firstChar = 0;
	file.peek(&firstChar, 1);
	newContest->setSettings(settings);
	if (firstChar == '[' || firstChar == '{') {
		QJsonParseError parseError;
		QJsonObject inObj(QJsonDocument::fromJson(file.readAll(), &parseError).object());
		if (parseError.error != 0 || newContest->readFromJson(inObj) == -1) {
			*error = tr("File %1 is broken").arg(QFileInfo(filePath).fileName());
			delete newContest;
			return false;
		}
	} else {
		QDataStream _in(&file);
		unsigned checkNumber = 0;
		_in >> checkNumber;
		if (checkNumber != unsigned(MagicNumber)) {
			*error = tr("File %1 is broken").arg(QFileInfo(filePath).fileName());
			delete newContest;
			return false;
		}
		quint16 checksum = 0;
		int len = 0;
		_in >> checksum >> len;
		QByteArray raw(len, Qt::Uninitialized);
		_in.readRawData(raw.data(), len);
		if (qChecksum(QByteArrayView(raw)) != checksum) {
			*error = tr("File %1 is broken").arg(QFileInfo(filePath).fileName());
			delete newContest;
			return false;
		}
		QByteArray data = qUncompress(raw);
		QDataStream in(data);
		newContest->readFromStream(in);
	}
	contest = newContest;
	cdfFile = QFileInfo(filePath).fileName();
	QDir::setCurrent(QFileInfo(filePath).path());
	QDir().mkdir(Settings::dataPath());
	QDir().mkdir(Settings::sourcePath());
	connectContest();

	LOG("Contest -", contest->getContestTitle(), "loaded successfully");
	return true;
}

Contest *ContestManager::open(const QString &name, QString *error) {
	if (contest && name == contestName)
		return contest;
	if (! isValidContestName(name)) {
		*error = tr("Invalid contest name");
		return nullptr;
	}
	if (judging) {
		*error = tr("Contest %1 is being judged, cannot switch contest now").arg(contestName);
		return nullptr;
	}
	const QString cdf = findCdf(contestDir(name));
	if (cdf.isEmpty()) {
		*error = tr("Contest not found");
		return nullptr;
	}
	close();
	if (! loadContest(cdf, error))
		return nullptr;
	contestName = name;
	events.clear();
	tasksDone = tasksTotal = 0;
	progressValue = progressMaximum = 0;
	judgeStarted = judgeFinished = QDateTime();
	return contest;
}

void ContestManager::close() {
	if (! contest)
		return;
	save();
	delete contest;
	contest = nullptr;
	contestName.clear();
	cdfFile.clear();
}

bool ContestManager::save(QString *error) {
	// LemonLime::saveContest()
	if (! contest)
		return false;
	QSaveFile file(currentCdfPath());
	if (! file.open(QFile::WriteOnly)) {
		if (error)
			*error = tr("Cannot open file %1").arg(cdfFile);
		WARN(cdfFile, "Save Failed");
		return false;
	}
	QJsonObject out;
	contest->writeToJson(out);
	file.write(QJsonDocument(out).toJson(QJsonDocument::Compact));
	if (! file.commit()) {
		if (error)
			*error = tr("Cannot write file %1").arg(cdfFile);
		return false;
	}
	lastSave = QDateTime::currentDateTime();
	return true;
}

QJsonArray ContestManager::scanNewTasks() const {
	// First half of LemonLime::addTasksAction()
	QJsonArray result;
	if (! contest)
		return result;
	QStringList list = QDir(Settings::dataPath()).entryList(QDir::Dirs | QDir::NoDotAndDotDot);
	QSet<QString> nameSet;
	for (auto *i : contest->getTaskList())
		nameSet.insert(i->getSourceFileName());

	for (const auto &dirName : list) {
		if (nameSet.contains(dirName))
			continue;
		QStringList filters = settings->getInputFileExtensions();
		if (filters.isEmpty())
			filters << "in";
		for (auto &f : filters)
			f = QString("*.") + f;
		QMap<QString, QString> inputFiles;
		getFiles(Settings::dataPath() + dirName, filters, inputFiles);
		filters = settings->getOutputFileExtensions();
		if (filters.isEmpty())
			filters << "out" << "ans";
		for (auto &f : filters)
			f = QString("*.") + f;
		QMap<QString, QString> outputFiles;
		getFiles(Settings::dataPath() + dirName, filters, outputFiles);
		QList<std::pair<QString, QString>> cases;
		for (const auto &base : inputFiles.keys()) {
			if (outputFiles.contains(base))
				cases.append(std::make_pair(inputFiles[base], outputFiles[base]));
		}
		std::ranges::sort(cases, Lemon::common::lessFileName, &std::pair<QString, QString>::first);
		if (cases.isEmpty())
			continue;
		QJsonArray arr;
		for (const auto &[in, out] : cases)
			arr.append(QJsonArray{in, out});
		result.append(QJsonObject{{"name", dirName},
		                          {"testCases", arr},
		                          {"fullScore", qMax(100, int(cases.size()))},
		                          {"timeLimit", settings->getDefaultTimeLimit()},
		                          {"memoryLimit", settings->getDefaultMemoryLimit()}});
	}
	return result;
}

int ContestManager::addTasks(const QJsonArray &requested) {
	// Second half of LemonLime::addTasksAction() / addTaskWithScoreScale()
	if (! contest)
		return 0;
	const auto candidates = scanNewTasks();
	int added = 0;
	for (const auto &r : requested) {
		const auto req = r.toObject();
		for (const auto &c : candidates) {
			const auto cand = c.toObject();
			if (cand["name"].toString() != req["name"].toString())
				continue;
			const QString title = cand["name"].toString();
			const auto testCases = cand["testCases"].toArray();
			const int sumScore = req.contains("fullScore") ? req["fullScore"].toInt() : cand["fullScore"].toInt();
			const int timeLimit =
			    req.contains("timeLimit") ? req["timeLimit"].toInt() : settings->getDefaultTimeLimit();
			const int memoryLimit =
			    req.contains("memoryLimit") ? req["memoryLimit"].toInt() : settings->getDefaultMemoryLimit();

			Task *newTask = new Task;
			newTask->setProblemTitle(title);
			newTask->setSourceFileName(title);
			newTask->setInputFileName(title + ".in");
			newTask->setOutputFileName(title + ".out");
			newTask->refreshCompilerConfiguration(settings);
			newTask->setAnswerFileExtension(settings->getDefaultOutputFileExtension());
			contest->addTask(newTask);
			const int n = int(testCases.size());
			int scorePer = sumScore / n;
			int scoreLos = sumScore - scorePer * n;
			for (int i = 0; i < n; i++) {
				auto *newTestCase = new TestCase;
				newTestCase->setFullScore(scorePer + static_cast<int>(i < scoreLos));
				newTestCase->setTimeLimit(timeLimit);
				newTestCase->setMemoryLimit(memoryLimit);
				const auto pair = testCases[i].toArray();
				newTestCase->addSingleCase(title + QDir::separator() + pair[0].toString(),
				                           title + QDir::separator() + pair[1].toString());
				newTask->addTestCase(newTestCase);
			}
			added++;
			break;
		}
	}
	return added;
}

QJsonObject ContestManager::cleanupSourceFiles(bool backup) {
	// LemonLime::cleanupButtonClicked() without the dialogs
	QJsonObject result;
	if (! contest)
		return {{"ok", false}, {"error", tr("No contest yet")}};
	QDir basDir(Settings::sourcePath());
	basDir.setFilter(QDir::Dirs | QDir::NoDotAndDotDot);

	if (backup) {
		QString backupFolder = "source_bak_%1";
		int backupNum = 0;
		QDir tempBackupLoca;
		while (tempBackupLoca.exists(backupFolder.arg(backupNum)))
			backupNum++;
		backupFolder = backupFolder.arg(backupNum);
		QDir bkLoca;
		if (! bkLoca.mkpath(backupFolder))
			return {{"ok", false}, {"error", tr("Aborted: Cannot make dir `%1'.").arg(backupFolder)}};
		bkLoca = QDir(backupFolder);
		for (const auto &conDirWho : basDir.entryInfoList()) {
			bkLoca.mkpath(conDirWho.fileName());
			copyPath(conDirWho.path() + QDir::separator() + conDirWho.fileName(),
			         bkLoca.path() + QDir::separator() + conDirWho.fileName());
		}
		result["backupFolder"] = backupFolder;
	}

	QSet<QString> tarNameSet;
	QSet<QString> nameSet;
	QMap<QString, int> typeSet;
	QMap<QString, QString> origSet;
	QList<Task *> taskList = contest->getTaskList();

	for (int i = 0; i < taskList.size(); i++) {
		QString taskName = taskList[i]->getSourceFileName();
		typeSet[taskName] = i;
		nameSet.insert(taskName);

		if (taskList[i]->getTaskType() == Task::AnswersOnly) {
			for (auto *j : taskList[i]->getTestCaseList()) {
				for (const auto &k : j->getInputFiles()) {
					QString temp = QFileInfo(k).completeBaseName();
					tarNameSet.insert(temp);
					origSet[temp] = taskName;
				}
			}
		} else if (taskList[i]->getTaskType() == Task::Communication ||
		           taskList[i]->getTaskType() == Task::CommunicationExec) {
			for (const auto &j : taskList[i]->getSourceFilesPath()) {
				QString temp = QFileInfo(j).completeBaseName();
				tarNameSet.insert(temp);
				origSet[temp] = taskName;
			}
		} else {
			tarNameSet.insert(taskName);
			origSet[taskName] = taskName;
		}
	}

	int cleaned = 0;
	for (const auto &conDirWho : basDir.entryInfoList()) {
		QDir conDir(conDirWho.filePath());
		conDir.setFilter(QDir::Files | QDir::Hidden);

		for (const auto &proFilWho : conDir.entryInfoList()) {
			if (proFilWho.suffix().length() <= 0 || proFilWho.suffix().toUpper() == "EXE")
				QFile::remove(proFilWho.absoluteFilePath());
		}

		conDir.setFilter(QDir::Dirs | QDir::NoDotAndDotDot);

		for (const auto &proDirWho : conDir.entryInfoList()) {
			if (nameSet.contains(proDirWho.fileName())) {
				QDir proDir(proDirWho.filePath());
				proDir.setFilter(QDir::Files | QDir::Hidden);
				for (const auto &sorFilWho : proDir.entryInfoList()) {
					if (sorFilWho.suffix().length() > 0 && sorFilWho.suffix().toUpper() != "EXE")
						QFile::copy(sorFilWho.filePath(),
						            conDirWho.filePath() + QDir::separator() + sorFilWho.fileName());
				}
			}
			removePath(proDirWho.absoluteFilePath());
		}

		for (const auto &proName : nameSet)
			conDir.mkpath(proName);

		conDir.setFilter(QDir::Files | QDir::Hidden);

		for (const auto &proFilWho : conDir.entryInfoList()) {
			QString proFilName = proFilWho.fileName();
			QString proName = proFilName;
			proName.truncate(proName.lastIndexOf("."));

			if (tarNameSet.contains(proName)) {
				QString taskName = origSet[proName];
				int who = typeSet[taskName];
				int types = taskList[who]->getTaskType();

				if (types == Task::Traditional || types == Task::Interaction || types == Task::Communication ||
				    types == Task::CommunicationExec) {
					if (proFilName != taskList[who]->getInputFileName() &&
					    proFilName != taskList[who]->getOutputFileName())
						QFile::copy(proFilWho.filePath(), conDirWho.filePath() + QDir::separator() + taskName +
						                                      QDir::separator() + proFilName);
				} else if (types == Task::AnswersOnly) {
					if (proFilWho.suffix() == taskList[who]->getAnswerFileExtension())
						QFile::copy(proFilWho.filePath(), conDirWho.filePath() + QDir::separator() + taskName +
						                                      QDir::separator() + proFilName);
				}
			}

			QFile::remove(proFilWho.absoluteFilePath());
		}

		conDir.setFilter(QDir::Dirs | QDir::NoDotAndDotDot);

		for (const auto &proDirWho : conDir.entryInfoList()) {
			QDir proDir(proDirWho.filePath());
			proDir.setFilter(QDir::Files | QDir::Hidden);
			for (const auto &sorFilWho : proDir.entryInfoList())
				QFile::copy(sorFilWho.filePath(), conDirWho.filePath() + QDir::separator() + sorFilWho.fileName());
		}
		cleaned++;
	}
	result["ok"] = true;
	result["contestants"] = cleaned;
	return result;
}

// ----------------------------------------------------------------------------------------------
// Judging
// ----------------------------------------------------------------------------------------------

bool ContestManager::startJudge(const QList<std::pair<QString, QVector<int>>> &list, QString *error) {
	if (! contest) {
		*error = tr("No contest yet");
		return false;
	}
	if (judging) {
		*error = tr("Judging is in progress");
		return false;
	}
	const int taskCount = int(contest->getTaskList().size());
	QList<std::pair<QString, QVector<int>>> cleanList;
	qint64 total = 0;
	int count = 0;
	for (const auto &[name, tasks] : list) {
		if (! contest->getContestant(name)) {
			*error = tr("Contestant %1 not found").arg(name);
			return false;
		}
		QVector<int> valid;
		for (int t : tasks) {
			if (t < 0 || t >= taskCount) {
				*error = tr("Task index %1 out of range").arg(t);
				return false;
			}
			if (! valid.contains(t)) {
				valid.append(t);
				total += contest->getTask(t)->getTotalTimeLimit();
			}
		}
		if (! valid.isEmpty()) {
			cleanList.append({name, valid});
			count += int(valid.size());
		}
	}
	if (cleanList.isEmpty()) {
		*error = tr("Nothing to judge");
		return false;
	}

	judging = true;
	stopRequested = false;
	progressValue = 0;
	progressMaximum = total;
	tasksDone = 0;
	tasksTotal = count;
	judgeStarted = QDateTime::currentDateTime();
	judgeFinished = QDateTime();
	events.clear(); // each run has its own log; event ids keep increasing
	pushEvent({{"type", "start"}, {"tasks", count}});

	// Contest::judge() runs its own event loop until all tasks are judged (like the GUI's modal
	// JudgingDialog). Start it from the event loop so that the HTTP request can return immediately.
	QTimer::singleShot(0, this, [this, cleanList] { runJudge(cleanList); });
	return true;
}

void ContestManager::runJudge(const QList<std::pair<QString, QVector<int>>> &list) {
	contest->judge(list);
	judging = false;
	judgeFinished = QDateTime::currentDateTime();
	save();
	pushEvent({{"type", "finished"}, {"stopped", stopRequested}});
}

void ContestManager::stopJudge() {
	if (! judging || ! contest)
		return;
	stopRequested = true;
	pushEvent({{"type", "stopping"}});
	contest->stopJudgingSlot();
}

QJsonObject ContestManager::judgeStatus(qint64 since) const {
	QJsonArray ev;
	for (const auto &e : events)
		if (e["id"].toInteger() > since)
			ev.append(e);
	return {{"contest", contestName},
	        {"judging", judging},
	        {"stopRequested", stopRequested},
	        {"progress", double(progressValue)},
	        {"progressMaximum", double(progressMaximum)},
	        {"tasksDone", tasksDone},
	        {"tasksTotal", tasksTotal},
	        {"started", judgeStarted.isValid() ? judgeStarted.toString(Qt::ISODate) : QString()},
	        {"finished", judgeFinished.isValid() ? judgeFinished.toString(Qt::ISODate) : QString()},
	        {"lastEventId", double(nextEventId - 1)},
	        {"events", ev}};
}

void ContestManager::pushEvent(QJsonObject event) {
	event["id"] = double(nextEventId++);
	event["time"] = QDateTime::currentDateTime().toString("hh:mm:ss");
	events.append(event);
	while (events.size() > 20000)
		events.removeFirst();
}

void ContestManager::onSingleCaseFinished(const QString &contestant, int progress, int x, int y, int result,
                                          int score, int timeUsed, qint64 memoryUsed) {
	progressValue += progress;
	pushEvent({{"type", "case"},
	           {"contestant", contestant},
	           {"testCase", x},
	           {"subCase", y},
	           {"result", result},
	           {"score", score},
	           {"timeUsed", timeUsed},
	           {"memoryUsed", double(memoryUsed)}});
}

void ContestManager::onSubtaskDependenceFinished(int x, int y, int status) {
	pushEvent({{"type", "dependence"}, {"testCase", x}, {"dependence", y}, {"status", status}});
}

void ContestManager::onTaskJudgingStarted(const QString &contestant, const QString &taskName) {
	pushEvent({{"type", "taskStarted"}, {"contestant", contestant}, {"task", taskName}});
}

void ContestManager::onCompileFinished(const QString &contestant, const QString &taskName, int state) {
	pushEvent({{"type", "compile"}, {"contestant", contestant}, {"task", taskName}, {"state", state}});
}

void ContestManager::onTaskJudgingFinished() {
	tasksDone++;
	pushEvent({{"type", "taskFinished"}, {"done", tasksDone}, {"total", tasksTotal}});
	// Persist intermediate results now and then, like an autosave.
	if (! lastSave.isValid() || lastSave.msecsTo(QDateTime::currentDateTime()) > 5000)
		save();
}

void ContestManager::onCompileError(int progress, int) { progressValue += progress; }
