/*
 * SPDX-FileCopyrightText: 2026 LemonServer contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#include "contestmanager.h"
#include "jsonapi.h"
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
#include <cmath>

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

	bool copyTree(const QString &from, const QString &to) {
		if (! QFileInfo(from).isDir())
			return QFile::copy(from, to); // keeps the permissions (executable checkers)
		if (! QDir().mkpath(to))
			return false;
		for (const auto &fi : QDir(from).entryInfoList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden))
			if (! copyTree(fi.absoluteFilePath(), QDir(to).filePath(fi.fileName())))
				return false;
		return true;
	}
} // namespace

ContestManager::ContestManager(Settings *settings, ServerConfig *config, QObject *parent)
    : QObject(parent), settings(settings), config(config) {}

ContestManager::~ContestManager() { closeAll(); }

bool ContestManager::isValidContestName(const QString &name) {
	static const QRegularExpression invalid(R"([<>:"/\\|?*\x00-\x1f])");
	const QString n = name.trimmed();
	return ! n.isEmpty() && n == name && n != "." && n != ".." && ! n.contains(invalid) && ! n.endsWith('.') &&
	       n.size() <= 128;
}

QString ContestManager::canonicalName(const QString &name) const {
#ifdef Q_OS_WIN
	// "NOIP" and "noip" are the same folder: never load it twice (the copies would overwrite each other's results)
	if (loaded.contains(name) || config->contestRoot().isEmpty())
		return name;
	for (auto it = loaded.cbegin(); it != loaded.cend(); ++it)
		if (it.key().compare(name, Qt::CaseInsensitive) == 0)
			return it.key();
	for (const auto &entry : QDir(config->contestRoot()).entryList(QDir::Dirs | QDir::NoDotAndDotDot))
		if (entry.compare(name, Qt::CaseInsensitive) == 0)
			return entry;
#endif
	return name;
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
	return contest ? QDir(currentDir()).absoluteFilePath(loaded.value(contestName).cdfFile) : QString();
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
		const auto props =
		    loaded.contains(name) ? loaded.value(name).properties : readProperties(root.absoluteFilePath(name));
		QJsonObject item{{"name", name}, {"cdf", QFileInfo(cdf).fileName()},
		                 {"modified", QFileInfo(cdf).lastModified().toString("yyyy-MM-dd hh:mm:ss")},
		                 {"judging", judging && running.contest == name},
		                 {"queuedJobs", queuedJobs(name)},
		                 {"busy", isBusy(name)},
		                 {"public", props["public"].toBool(false)},
		                 {"archived", props["archived"].toBool(false)},
		                 {"downZip", props["downZip"].toString()}};
		QFile f(cdf);
		const QFileInfo info(cdf);
		if (loaded.contains(name)) {
			const auto *c = loaded.value(name).contest;
			item["title"] = c->getContestTitle();
			item["tasks"] = int(c->getTaskList().size());
			item["contestants"] = int(c->getContestantList().size());
		} else if (listSnapshots.contains(cdf) && listSnapshots[cdf].size == info.size() && listSnapshots[cdf].modified == info.lastModified()) {
			const auto summary = listSnapshots[cdf].value;
			for (auto it = summary.begin(); it != summary.end(); ++it) item[it.key()] = it.value();
		} else if (f.open(QFile::ReadOnly)) {
			QJsonObject summary;
			char first = 0;
			f.peek(&first, 1);
			if (first == '{') {
				const auto obj = QJsonDocument::fromJson(f.readAll()).object();
				summary["title"] = obj["contestTitle"].toString();
				summary["tasks"] = obj["tasks"].toArray().size();
				summary["contestants"] = obj["contestants"].toArray().size();
			} else {
				summary["title"] = name;
				summary["legacyFormat"] = true;
			}
			if (listSnapshots.size() > 4096) listSnapshots.clear();
			listSnapshots[cdf] = {info.size(), info.lastModified(), summary};
			for (auto it = summary.begin(); it != summary.end(); ++it) item[it.key()] = it.value();
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
	auto properties = readProperties(dir);
	properties["public"] = false;
	properties["archived"] = false;
	if (! saveProperties(dir, properties, error))
		return false;
	if (loaded.contains(name))
		unload(name);
	auto *c = new Contest(this);
	c->setSettings(settings);
	c->setContestTitle(title.isEmpty() ? name : title);
	QDir(dir).mkdir("data");
	QDir(dir).mkdir("source");
	addLoaded(name, c, name + ".cdf");
	open(name, error);

	LOG("New Contest -", name);
	return save(error);
}

bool ContestManager::deleteContest(const QString &requested, QString *error) {
	const QString name = canonicalName(requested);
	if (! isValidContestName(name) || findCdf(contestDir(name)).isEmpty()) {
		*error = tr("Contest not found");
		return false;
	}
	if (isBusy(name)) {
		*error = tr("This contest is being judged or waiting to be judged");
		return false;
	}
	if (isArchived(name)) {
		*error = tr("This contest is archived. Unarchive it before making changes.");
		return false;
	}
	if (loaded.contains(name)) {
		delete loaded.take(name).contest; // not saved: it is deleted anyway
		if (name == contestName) {
			contest = nullptr;
			contestName.clear();
		}
	}
	QDir::setCurrent(config->contestRoot());
	if (! QDir(contestDir(name)).removeRecursively()) {
		*error = tr("Cannot remove contest folder");
		return false;
	}
	++nextRevision;
	return true;
}

bool ContestManager::cloneContest(const QString &requestedFrom, const QString &to, const QString &title,
                                  bool withSubmissions, QString *error) {
	const QString from = canonicalName(requestedFrom);
	if (config->contestRoot().isEmpty()) {
		*error = tr("Default contest folder is not configured");
		return false;
	}
	if (! isValidContestName(from) || findCdf(contestDir(from)).isEmpty()) {
		*error = tr("Contest not found");
		return false;
	}
	if (! isValidContestName(to)) {
		*error = tr("Invalid contest name");
		return false;
	}
	const QString dstDir = contestDir(to);
	if (QFileInfo::exists(dstDir)) {
		*error = tr("Contest %1 already exists").arg(to);
		return false;
	}
	if (withSubmissions && isBusy(from)) {
		// its results are not final yet
		*error = tr("This contest is being judged or waiting to be judged");
		return false;
	}
	// the contest as LemonLime would save it now (this also converts the old binary .cdf format)
	if (! loaded.contains(from)) {
		const QString cdf = findCdf(contestDir(from));
		Contest *c = loadContest(cdf, error);
		if (! c)
			return false;
		addLoaded(from, c, QFileInfo(cdf).fileName());
	}
	const Loaded &src = loaded[from];
	QJsonObject cdf;
	src.contest->writeToJson(cdf);
	cdf["contestTitle"] = title.isEmpty() ? to : title;
	if (! withSubmissions)
		cdf["contestants"] = QJsonArray();

	static const QStringList resultFiles{"result.html", "result.htm", "result.csv", "statistics.html"};
	const QDir srcDir(contestDir(from));
	const QDir dst(dstDir);
	auto fail = [&](const QString &message) {
		QDir(dstDir).removeRecursively();
		*error = message;
		return false;
	};
	if (! QDir().mkpath(dstDir))
		return fail(tr("Cannot make contest path"));
	for (const auto &fi : srcDir.entryInfoList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden)) {
		const QString n = fi.fileName();
		if (n == src.cdfFile || n == kPropertiesFile)
			continue; // written below
		if (! withSubmissions &&
		    (n == "source" || n.startsWith("source_bak_") || resultFiles.contains(n, Qt::CaseInsensitive)))
			continue;
		if (! copyTree(fi.absoluteFilePath(), dst.filePath(n)))
			return fail(tr("Cannot copy %1").arg(n));
	}
	dst.mkdir("data");
	dst.mkdir("source");
	QSaveFile out(dst.filePath(to + ".cdf"));
	if (! out.open(QFile::WriteOnly))
		return fail(tr("Cannot write file %1").arg(to + ".cdf"));
	out.write(QJsonDocument(cdf).toJson(QJsonDocument::Compact));
	if (! out.commit())
		return fail(tr("Cannot write file %1").arg(to + ".cdf"));
	// LemonServer's properties: keep down.zip (if it was copied)
	const QString down = src.properties["downZip"].toString();
	QJsonObject properties{{"public", false}, {"archived", false}};
	if (! down.isEmpty() && QFileInfo(dst.filePath(down)).isFile())
		properties["downZip"] = down;
	if (! saveProperties(dstDir, properties, error))
		return fail(*error);
	LOG("Cloned contest", from, "to", to, withSubmissions ? "with submissions" : "without submissions");
	return true;
}

void ContestManager::connectContest(Contest *c) {
	// only the contest being judged emits these
	connect(c, &Contest::singleCaseFinished, this, &ContestManager::onSingleCaseFinished);
	connect(c, &Contest::singleSubtaskDependenceFinished, this, &ContestManager::onSubtaskDependenceFinished);
	connect(c, &Contest::taskJudgingStartedFor, this, &ContestManager::onTaskJudgingStarted);
	connect(c, &Contest::taskJudgingFinished, this, &ContestManager::onTaskJudgingFinished);
	connect(c, &Contest::compileError, this, &ContestManager::onCompileError);
	connect(c, &Contest::compileFinishedFor, this, &ContestManager::onCompileFinished);
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
	name = canonicalName(name);
	if (! isValidContestName(name)) {
		*error = tr("Invalid contest name");
		return false;
	}
	// Sanitize in staging, before the imported CDF can become visible in the contest root.
	auto properties = readProperties(source);
	properties["public"] = false;
	properties["archived"] = false;
	if (! saveProperties(source, properties, error))
		return false;
	const QString dest = contestDir(name);
	if (QFileInfo::exists(dest)) {
		if (isArchived(name)) {
			*error = tr("This contest is archived. Unarchive it before making changes.");
			return false;
		}
		if (! overwrite) {
			*error = tr("Contest %1 already exists").arg(name);
			return false;
		}
		if (isBusy(name)) {
			*error = tr("This contest is being judged or waiting to be judged");
			return false;
		}
		if (loaded.contains(name)) {
			delete loaded.take(name).contest; // replaced by the imported one
			if (name == contestName) {
				contest = nullptr;
				contestName.clear();
			}
		}
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
	*finalName = name;
	QString openError;
	if (! open(name, &openError)) {
		*error = openError;
		return false;
	}
	LOG("Imported contest", name);
	return true;
}

Contest *ContestManager::loadContest(const QString &filePath, QString *error) {
	// LemonLime::loadContest()
	auto *newContest = new Contest(this);
	QFile file(filePath);

	if (! file.open(QFile::ReadOnly)) {
		*error = tr("Cannot open file %1").arg(QFileInfo(filePath).fileName());
		delete newContest;
		return nullptr;
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
			return nullptr;
		}
	} else {
		QDataStream _in(&file);
		unsigned checkNumber = 0;
		_in >> checkNumber;
		if (checkNumber != unsigned(MagicNumber)) {
			*error = tr("File %1 is broken").arg(QFileInfo(filePath).fileName());
			delete newContest;
			return nullptr;
		}
		quint16 checksum = 0;
		int len = 0;
		_in >> checksum >> len;
		QByteArray raw(len, Qt::Uninitialized);
		_in.readRawData(raw.data(), len);
		if (qChecksum(QByteArrayView(raw)) != checksum) {
			*error = tr("File %1 is broken").arg(QFileInfo(filePath).fileName());
			delete newContest;
			return nullptr;
		}
		QByteArray data = qUncompress(raw);
		QDataStream in(data);
		newContest->readFromStream(in);
	}
	const QDir dir = QFileInfo(filePath).absoluteDir();
	dir.mkdir("data");
	dir.mkdir("source");

	LOG("Contest -", newContest->getContestTitle(), "loaded successfully");
	return newContest;
}

void ContestManager::addLoaded(const QString &name, Contest *c, const QString &cdfFile) {
	c->setContestDirectory(contestDir(name));
	connectContest(c);
	loaded.insert(name, Loaded{c, cdfFile, readProperties(contestDir(name)), QDateTime::currentDateTimeUtc(), false, nextRevision++});
	evictIdleContests(name);
}

void ContestManager::unload(const QString &name) {
	if (! loaded.contains(name))
		return;
	saveContest(name);
	delete loaded.take(name).contest;
	if (name == contestName) {
		contest = nullptr;
		contestName.clear();
	}
}

void ContestManager::evictIdleContests(const QString &keep) {
	// Keep a few contests in memory; never the current one, one that is being judged / queued, or `keep`
	// (the one just loaded: when every other contest is busy it would be the only candidate, and the caller
	// would then use a deleted contest).
	constexpr int kMaxLoaded = 8;
	while (loaded.size() > kMaxLoaded) {
		QString oldest;
		QDateTime oldestTime;
		for (auto it = loaded.cbegin(); it != loaded.cend(); ++it) {
			if (it.key() == contestName || it.key() == keep || isBusy(it.key()))
				continue;
			if (oldest.isEmpty() || it->lastUsed < oldestTime) {
				oldest = it.key();
				oldestTime = it->lastUsed;
			}
		}
		if (oldest.isEmpty())
			return;
		// A failed disk write must not evict the only up-to-date copy of the results.
		if (!saveContest(oldest))
			return;
		unload(oldest);
	}
}

Contest *ContestManager::open(const QString &requested, QString *error) {
	if (! isValidContestName(requested)) {
		*error = tr("Invalid contest name");
		return nullptr;
	}
	const QString name = canonicalName(requested);
	auto it = loaded.find(name);
	if (it == loaded.end()) {
		const QString cdf = findCdf(contestDir(name));
		if (cdf.isEmpty()) {
			*error = tr("Contest not found");
			return nullptr;
		}
		Contest *c = loadContest(cdf, error);
		if (! c)
			return nullptr;
		addLoaded(name, c, QFileInfo(cdf).fileName());
		it = loaded.find(name);
		if (it == loaded.end()) {
			*error = tr("Contest not found");
			return nullptr;
		}
	}
	it->lastUsed = QDateTime::currentDateTimeUtc();
	contest = it->contest;
	contestName = name;
	// request-scoped helpers use LemonLime's paths relative to the contest folder
	QDir::setCurrent(contestDir(name));
	return contest;
}

void ContestManager::closeAll() {
	if (judging && loaded.contains(running.contest))
		loaded[running.contest].contest->stopJudgingSlot();
	for (const auto &name : loaded.keys())
		saveContest(name);
	for (auto &l : loaded)
		delete l.contest;
	loaded.clear();
	++nextRevision;
	contest = nullptr;
	contestName.clear();
}

QString ContestManager::currentPropertiesPath() const {
	return contest ? QDir(currentDir()).absoluteFilePath(kPropertiesFile) : QString();
}

const QJsonObject &ContestManager::props() const {
	static const QJsonObject empty;
	const auto it = loaded.constFind(contestName);
	return contest && it != loaded.cend() ? it->properties : empty;
}

QJsonObject ContestManager::readProperties(const QString &dir) {
	QFile f(QDir(dir).absoluteFilePath(kPropertiesFile));
	if (! f.open(QFile::ReadOnly))
		return {};
	auto props = QJsonDocument::fromJson(f.readAll()).object();
	// the contest time of LemonServer 0.1.5 and earlier is no longer used
	props.remove("startTime");
	props.remove("endTime");
	return props;
}

bool ContestManager::saveProperties(const QString &dir, const QJsonObject &properties, QString *error) {
	QSaveFile file(QDir(dir).absoluteFilePath(kPropertiesFile));
	if (file.open(QFile::WriteOnly)) {
		const auto bytes = QJsonDocument(properties).toJson(QJsonDocument::Indented);
		if (file.write(bytes) == bytes.size() && file.commit())
			return true;
	}
	if (error) *error = tr("Cannot write file %1").arg(kPropertiesFile);
	return false;
}

bool ContestManager::writeProperties(QString *error) { return saveProperties(currentDir(), props(), error); }

bool ContestManager::isArchived(const QString &requested) const {
	if (! isValidContestName(requested)) return false;
	const auto name = canonicalName(requested);
	const auto properties = loaded.contains(name) ? loaded.value(name).properties : readProperties(contestDir(name));
	return properties["archived"].toBool(false);
}

bool ContestManager::isPublic(const QString &requested) const {
	if (! isValidContestName(requested)) return false;
	const auto name = canonicalName(requested);
	const auto properties = loaded.contains(name) ? loaded.value(name).properties : readProperties(contestDir(name));
	return properties["public"].toBool(false);
}

bool ContestManager::setArchived(bool archived, QString *error) {
	if (! contest) { *error = tr("No contest yet"); return false; }
	if (isBusy(contestName)) { *error = tr("This contest is being judged or waiting to be judged"); return false; }
	if (archived == isArchived(contestName)) return true;
	if (archived && ! saveContest(contestName, error)) return false;
	auto next = props(); next["archived"] = archived;
	if (! saveProperties(currentDir(), next, error)) return false;
	loaded[contestName].properties = next;
	touch(contestName, false);
	return true;
}

bool ContestManager::setPublic(bool visible, QString *error) {
	if (! contest) { *error = tr("No contest yet"); return false; }
	auto next = props(); next["public"] = visible;
	if (! saveProperties(currentDir(), next, error)) return false;
	loaded[contestName].properties = next;
	touch(contestName, false);
	return true;
}

namespace {
	// contestant folder names are case-insensitive on Windows
	QString ownerKey(const QString &who) {
#ifdef Q_OS_WIN
		return who.toLower();
#else
		return who;
#endif
	}
} // namespace

QJsonObject ContestManager::propertiesOf(const QString &requested) const {
	if (! isValidContestName(requested)) return {};
	const auto name = canonicalName(requested);
	return loaded.contains(name) ? loaded.value(name).properties : readProperties(contestDir(name));
}

QString ContestManager::ownerOf(const QString &who) const { return props()["owners"].toObject()[ownerKey(who)].toString(); }

bool ContestManager::ownedBy(const QString &contestName, const QString &who, const QString &owner) const {
	return ! owner.isEmpty() && propertiesOf(contestName)["owners"].toObject()[ownerKey(who)].toString() == owner;
}

bool ContestManager::claimContestant(const QString &who, const QString &owner, bool *conflict, QString *error) {
	*conflict = false;
	if (! contest) { *error = tr("No contest yet"); return false; }
	const QString current = ownerOf(who);
	if (current == owner) return true;
	if (! current.isEmpty()) { *conflict = true; return false; }
	auto next = props();
	auto owners = next["owners"].toObject();
	owners[ownerKey(who)] = owner;
	next["owners"] = owners;
	if (! saveProperties(currentDir(), next, error)) return false;
	loaded[contestName].properties = next;
	touch(contestName, false);
	return true;
}

void ContestManager::releaseContestant(const QString &who) {
	if (! contest || ownerOf(who).isEmpty()) return;
	auto next = props();
	auto owners = next["owners"].toObject();
	owners.remove(ownerKey(who));
	next["owners"] = owners;
	if (saveProperties(currentDir(), next, nullptr)) loaded[contestName].properties = next;
	touch(contestName, false);
}

void ContestManager::restrictToOwner(const QString &contestName, const QJsonObject &request, QMap<QString, QVector<int>> *mapping) const {
	const QString owner = request["owner"].toString();
	if (owner.isEmpty()) return;
	const auto owners = propertiesOf(contestName)["owners"].toObject();
	for (auto it = mapping->begin(); it != mapping->end();)
		it = owners[ownerKey(it.key())].toString() == owner ? std::next(it) : mapping->erase(it);
}

QString ContestManager::downZip() const { return props()["downZip"].toString(); }

bool ContestManager::setDownZip(const QString &relativePath, QString *error) {
	if (! contest) {
		*error = tr("No contest yet");
		return false;
	}
	auto &properties = loaded[contestName].properties;
	QString rel = QDir::cleanPath(QString(relativePath).replace('\\', '/'));
	if (relativePath.trimmed().isEmpty()) {
		properties.remove("downZip");
	} else {
		if (rel.startsWith("../") || rel == ".." || rel.startsWith('/') || rel.contains(':') || rel == ".") {
			*error = tr("The file must be inside the contest folder");
			return false;
		}
		if (! QFileInfo(QDir(currentDir()).absoluteFilePath(rel)).isFile()) {
			*error = tr("File not found");
			return false;
		}
		properties["downZip"] = rel;
	}
	return writeProperties(error);
}

QJsonObject ContestManager::propertiesJson() const {
	QJsonValue down;
	if (! downZip().isEmpty()) {
		const QFileInfo fi(QDir(currentDir()).absoluteFilePath(downZip()));
		down = QJsonObject{{"path", downZip()},
		                   {"exists", fi.isFile()},
		                   {"size", double(fi.isFile() ? fi.size() : 0)},
		                   {"modified", fi.isFile() ? fi.lastModified().toString("yyyy-MM-dd hh:mm:ss") : QString()}};
	}
	return {{"downZip", down}, {"public", isPublic(contestName)}, {"archived", isArchived(contestName)}};
}

void ContestManager::touch(const QString &name, bool dirty) {
	auto it = loaded.find(name);
	if (it == loaded.end()) return;
	it->dirty |= dirty;
	it->revision = nextRevision++;
}

quint64 ContestManager::revision(const QString &name) const {
	if (name.isEmpty()) return nextRevision;
	return loaded.value(canonicalName(name)).revision;
}

bool ContestManager::save(QString *error) {
	if (!contest) return false;
	touch(contestName);
	return saveContest(contestName, error);
}

bool ContestManager::saveContest(const QString &name, QString *error) {
	// LemonLime::saveContest()
	const auto it = loaded.find(name);
	if (it == loaded.end())
		return false;
	if (it->properties["archived"].toBool(false))
		return true; // Reads, eviction and shutdown must not rewrite an archived CDF.
	if (!it->dirty) return true;
	QSaveFile file(QDir(contestDir(name)).absoluteFilePath(it->cdfFile));
	if (! file.open(QFile::WriteOnly)) {
		if (error)
			*error = tr("Cannot open file %1").arg(it->cdfFile);
		WARN(it->cdfFile, "Save Failed");
		return false;
	}
	QJsonObject out;
	it->contest->writeToJson(out);
	const auto bytes = QJsonDocument(out).toJson(QJsonDocument::Compact);
	if (file.write(bytes) != bytes.size() || ! file.commit()) {
		if (error)
			*error = tr("Cannot write file %1").arg(it->cdfFile);
		return false;
	}
	lastSaved[name] = QDateTime::currentDateTimeUtc();
	it->dirty = false;
	return true;
}

QJsonArray ContestManager::scanNewTasks() const {
	// First half of LemonLime::addTasksAction()
	QJsonArray result;
	if (! contest)
		return result;
	QStringList list = QDir(Settings::dataPath()).entryList(QDir::Dirs | QDir::NoDotAndDotDot);
	QSet<QString> nameSet;
	QSet<QString> sourceNames;
	for (auto *i : contest->getTaskList()) {
		nameSet.insert(i->getSourceFileName());
		sourceNames.insert(i->getSourceFileName().toCaseFolded());
		for (const auto *tc : i->getTestCaseList()) for (const auto &file : tc->getInputFiles()) {
			const QString relative = QDir::fromNativeSeparators(file);
			if (QDir::isRelativePath(relative) && relative.contains('/')) nameSet.insert(relative.section('/', 0, 0));
		}
	}

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
		int ordinal = contest->getTaskList().size() + result.size() + 1;
		QString source = LemonServerJson::defaultTaskFileName(dirName, ordinal);
		while (sourceNames.contains(source.toCaseFolded())) source = QString("task-%1").arg(++ordinal);
		sourceNames.insert(source.toCaseFolded());
		result.append(QJsonObject{{"name", dirName},
		                          {"sourceFileName", source},
		                          {"testCases", arr},
		                          {"fullScore", qMax(100, int(cases.size()))},
		                          {"timeLimit", settings->getDefaultTimeLimit()},
		                          {"memoryLimit", settings->getDefaultMemoryLimit()}});
	}
	return result;
}

int ContestManager::addTasks(const QJsonArray &requested, QString *error) {
	// Second half of LemonLime::addTasksAction() / addTaskWithScoreScale()
	if (! contest)
		return 0;
	const auto candidates = scanNewTasks();
	for (const auto &entry : requested) {
		const auto request = entry.toObject();
		if (request.contains("fullScore") && (!request["fullScore"].isDouble() || !qIsFinite(request["fullScore"].toDouble()) || request["fullScore"].toDouble() < 0 || request["fullScore"].toDouble() > Settings::upperBoundForFullScore())) {
			if (error) *error = "fullScore must be a finite nonnegative number";
			return 0;
		}
		if (request.contains("sourceFileName") && (!LemonServerJson::isPortableTaskFileName(request["sourceFileName"].toString()) || request["sourceFileName"].toString().size() > 64)) {
			if (error) *error = "sourceFileName: use an ASCII file name of at most 64 characters. The display title may contain Chinese.";
			return 0;
		}
	}
	int added = 0;
	for (const auto &r : requested) {
		const auto req = r.toObject();
		for (const auto &c : candidates) {
			const auto cand = c.toObject();
			if (cand["name"].toString() != req["name"].toString())
				continue;
			const QString title = cand["name"].toString();
			const QString source = req.contains("sourceFileName") ? req["sourceFileName"].toString() : cand["sourceFileName"].toString();
			const auto testCases = cand["testCases"].toArray();
			const Score sumScore = req.contains("fullScore") ? req["fullScore"].toDouble() : cand["fullScore"].toDouble();
			const int timeLimit =
			    req.contains("timeLimit") ? req["timeLimit"].toInt() : settings->getDefaultTimeLimit();
			const int memoryLimit =
			    req.contains("memoryLimit") ? req["memoryLimit"].toInt() : settings->getDefaultMemoryLimit();

			Task *newTask = new Task;
			newTask->setProblemTitle(title);
			newTask->setSourceFileName(source);
			newTask->setInputFileName(source + ".in");
			newTask->setOutputFileName(source + ".out");
			newTask->refreshCompilerConfiguration(settings);
			newTask->setAnswerFileExtension(settings->getDefaultOutputFileExtension());
			contest->addTask(newTask);
			const int n = int(testCases.size());
			const bool whole = std::floor(sumScore) == sumScore;
			const Score scorePer = whole ? std::floor(sumScore / n) : sumScore / n;
			const Score scoreLos = sumScore - scorePer * n;
			for (int i = 0; i < n; i++) {
				auto *newTestCase = new TestCase;
				newTestCase->setFullScore(whole ? scorePer + static_cast<int>(i < scoreLos) : i + 1 == n ? sumScore - scorePer * i : scorePer);
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

int ContestManager::markSourceChanged(const QString &who, const QStringList &rest) {
	if (! contest)
		return 0;
	Contestant *ct = contest->getContestant(who);
	if (! ct)
		return 0; // a new contestant: "refresh" adds it unjudged
	const auto taskList = contest->getTaskList();
	int marked = 0;
	for (int j = 0; j < taskList.size(); j++) {
		const Task *task = taskList[j];
		bool hit = rest.isEmpty();
		if (! hit && rest.size() >= 2)
			hit = rest.first() == task->getSourceFileName(); // <who>/<task>/...
		if (! hit && rest.size() == 1) {
			const QString base = QFileInfo(rest.first()).completeBaseName();
			hit = rest.first() == task->getSourceFileName() || base == task->getSourceFileName();
			if (! hit && task->getTaskType() == Task::AnswersOnly)
				for (const auto *tc : task->getTestCaseList())
					for (const auto &in : tc->getInputFiles())
						hit = hit || QFileInfo(in).completeBaseName() == base;
			if (! hit && (task->getTaskType() == Task::Communication ||
			              task->getTaskType() == Task::CommunicationExec))
				for (const auto &p : task->getSourceFilesPath())
					hit = hit || QFileInfo(p).completeBaseName() == base;
		}
		if (! hit)
			continue;
		if (judging && contestName == running.contest)
			changedWhileJudging.insert(who + "\n" + QString::number(j));
		if (ct->getCheckJudged(j)) {
			ct->setCheckJudged(j, false);
			marked++;
		}
	}
	if (marked > 0)
		save();
	return marked;
}

// ----------------------------------------------------------------------------------------------
// Judging queue
// ----------------------------------------------------------------------------------------------

namespace {
	bool cellMatches(const Task *task, const Contestant *ct, int j, const QSet<int> &compileStates,
	                 const QSet<int> &resultStates) {
		if (! ct->getCheckJudged(j))
			return false;
		if (task->getTaskType() != Task::AnswersOnly && compileStates.contains(int(ct->getCompileState(j))))
			return true;
		for (const auto &row : ct->getResult(j))
			for (auto r : row)
				if (resultStates.contains(int(r)))
					return true;
		return false;
	}

	// The cells a judging request asks for (LemonLime's ResultViewer::judge*()).
	bool judgeCells(const Contest *contest, const QJsonObject &body, QMap<QString, QVector<int>> *mapping,
	                QString *error) {
		const QString mode = body["mode"].toString("all");
		const auto contestants = contest->getContestantList();
		const auto tasks = contest->getTaskList();
		if (mode == "all") {
			for (auto *ct : contestants)
				for (int j = 0; j < tasks.size(); j++)
					(*mapping)[ct->getContestantName()].push_back(j);
		} else if (mode == "unjudged") { // ResultViewer::judgeUnjudged()
			for (auto *ct : contestants)
				for (int j = 0; j < tasks.size(); j++)
					if (ct->getTaskScore(j) == -1)
						(*mapping)[ct->getContestantName()].push_back(j);
		} else if (mode == "grey") { // ResultViewer::judgeGrey()
			for (auto *ct : contestants)
				for (int j = 0; j < tasks.size(); j++)
					if (ct->getCompileState(j) == NoValidSourceFile)
						(*mapping)[ct->getContestantName()].push_back(j);
		} else if (mode == "magenta") { // ResultViewer::judgeMagenta()
			for (auto *ct : contestants)
				for (int j = 0; j < tasks.size(); j++)
					if (tasks[j]->getTaskType() != Task::AnswersOnly && ct->getCompileState(j) != CompileSuccessfully &&
					    ct->getCompileState(j) != NoValidSourceFile && ct->getCompileState(j) != NoValidGraderFile)
						(*mapping)[ct->getContestantName()].push_back(j);
		} else if (mode == "selected") { // ResultViewer::judgeSelected()
			for (const auto &v : body["items"].toArray()) {
				const auto item = v.toObject();
				const QString who = item["contestant"].toString();
				if (! contest->getContestant(who)) {
					*error = ContestManager::tr("Contestant %1 not found").arg(who);
					return false;
				}
				if (! item.contains("tasks")) {
					for (int j = 0; j < tasks.size(); j++)
						(*mapping)[who].push_back(j);
					continue;
				}
				for (const auto &t : item["tasks"].toArray()) {
					if (t.toInt() < 0 || t.toInt() >= tasks.size()) {
						*error = ContestManager::tr("Task index %1 out of range").arg(t.toInt());
						return false;
					}
					(*mapping)[who].push_back(t.toInt());
				}
			}
		} else if (mode == "state") {
			// rejudge the cells having a given compile state or containing a given case result
			QSet<int> compileStates, resultStates;
			for (const auto &v : body["compileStates"].toArray())
				compileStates.insert(v.toInt());
			for (const auto &v : body["resultStates"].toArray())
				resultStates.insert(v.toInt());
			for (auto *ct : contestants)
				for (int j = 0; j < tasks.size(); j++)
					if (cellMatches(tasks[j], ct, j, compileStates, resultStates))
						(*mapping)[ct->getContestantName()].push_back(j);
		} else {
			*error = "mode must be all, unjudged, grey, magenta, state or selected";
			return false;
		}
		// "tasks": only judge these tasks (any mode)
		if (body.contains("tasks")) {
			if (! body["tasks"].isArray()) {
				*error = "tasks must be an array of task indices";
				return false;
			}
			QSet<int> only;
			for (const auto &t : body["tasks"].toArray()) {
				if (! t.isDouble() || t.toInt() < 0 || t.toInt() >= tasks.size()) {
					*error = ContestManager::tr("Task index %1 out of range").arg(t.toInt());
					return false;
				}
				only.insert(t.toInt());
			}
			for (auto it = mapping->begin(); it != mapping->end();) {
				it->removeIf([&](int j) { return ! only.contains(j); });
				it = it->isEmpty() ? mapping->erase(it) : std::next(it);
			}
		}
		return true;
	}

	// Drop unknown contestants / tasks and duplicates; also count the cells and the total time limit.
	QList<std::pair<QString, QVector<int>>> judgeList(const Contest *contest, const QMap<QString, QVector<int>> &mapping,
	                                                  qint64 *totalTime, int *count) {
		QList<std::pair<QString, QVector<int>>> list;
		*totalTime = 0;
		*count = 0;
		const int taskCount = int(contest->getTaskList().size());
		for (auto it = mapping.cbegin(); it != mapping.cend(); ++it) {
			if (! contest->getContestant(it.key()))
				continue;
			QVector<int> valid;
			for (int t : it.value()) {
				if (t < 0 || t >= taskCount || valid.contains(t))
					continue;
				valid.append(t);
				*totalTime += contest->getTask(t)->getTotalTimeLimit();
			}
			if (! valid.isEmpty()) {
				list.append({it.key(), valid});
				*count += int(valid.size());
			}
		}
		return list;
	}
} // namespace

QString ContestManager::Job::mode() const { return request["mode"].toString("all"); }

bool ContestManager::isBusy(const QString &name) const {
	if (judging && running.contest == name)
		return true;
	return queuedJobs(name) > 0;
}

int ContestManager::queuedJobs(const QString &name) const {
	int n = 0;
	for (const auto &j : queue)
		if (j.contest == name)
			n++;
	return n;
}

QJsonObject ContestManager::jobJson(const Job &job, int position) const {
	return {{"id", double(job.id)},
	        {"contest", job.contest},
	        {"mode", job.mode()},
	        {"owner", job.request["owner"].toString()}, // the CodeHub server that queued it, if any
	        {"queued", job.queued.toString(Qt::ISODate)},
	        {"position", position}};
}

bool ContestManager::enqueueJudge(const QJsonObject &request, QJsonObject *job, QString *error, bool *nothingToJudge) {
	*nothingToJudge = false;
	if (! contest) {
		*error = tr("No contest yet");
		return false;
	}
	if (isArchived(contestName)) {
		*error = tr("This contest is archived. Unarchive it before making changes.");
		return false;
	}
	const bool busy = isBusy(contestName);
	// "refresh": pick up new contestant folders first. A busy contest is refreshed when its job starts
	// (refreshing removes contestants, which must not happen while they are being judged).
	if (! busy && request["refresh"].toBool()) {
		contest->refreshContestantList();
		save();
	}
	// check the request now; the cells are chosen again when the job starts
	QMap<QString, QVector<int>> mapping;
	if (! judgeCells(contest, request, &mapping, error))
		return false;
	restrictToOwner(contestName, request, &mapping);
	for (const auto &indices : mapping) for (const int index : indices) {
		QString invalid;
		if (!LemonServerJson::validateTaskFileNames(contest->getTask(index), &invalid)) {
			*error = contest->getTask(index)->getProblemTitle() + ": " + invalid;
			return false;
		}
	}
	qint64 total = 0;
	int count = 0;
	judgeList(contest, mapping, &total, &count);
	if (count == 0 && ! busy) {
		*error = tr("Nothing to judge");
		*nothingToJudge = true;
		return false;
	}
	// the same request is already waiting: do not judge it twice
	for (int i = 0; i < queue.size(); i++) {
		if (queue[i].contest == contestName && queue[i].request == request) {
			*job = jobJson(queue[i], i + 1);
			(*job)["duplicate"] = true;
			return true;
		}
	}
	const Job newJob{nextJobId++, contestName, request, QDateTime::currentDateTime()};
	queue.append(newJob);
	LOG("Queued judging job", newJob.id, "of", contestName, "mode", newJob.mode());
	// Nothing else to do: start it now, so that the response already shows its progress.
	if (! judging && ! nextScheduled && queue.size() == 1)
		startNext();
	const bool started = judging && running.id == newJob.id;
	int position = 0;
	for (int i = 0; i < queue.size() && ! position; i++)
		if (queue[i].id == newJob.id)
			position = i + 1;
	*job = jobJson(newJob, position);
	if (! started && ! position)
		(*job)["skipped"] = true; // nothing to judge after all (see the "skipped" event)
	if (! judging)
		scheduleNext();
	return true;
}

bool ContestManager::cancelJob(qint64 id, QString *error) {
	if (judging && running.id == id)
		return stopJudge(running.contest);
	for (int i = 0; i < queue.size(); i++) {
		if (queue[i].id == id) {
			LOG("Removed judging job", id, "of", queue[i].contest, "from the queue");
			queue.removeAt(i);
			return true;
		}
	}
	*error = tr("No such judging job");
	return false;
}

int ContestManager::dequeueContest(const QString &requested) {
	const QString name = canonicalName(requested);
	int n = 0;
	for (int i = int(queue.size()) - 1; i >= 0; i--) {
		if (queue[i].contest == name) {
			queue.removeAt(i);
			n++;
		}
	}
	if (stopJudge(name))
		n++;
	if (n)
		LOG("Removed", n, "judging job(s) of", name);
	return n;
}

bool ContestManager::stopJudge(const QString &requested) {
	const QString name = canonicalName(requested);
	if (! judging || running.contest != name || ! loaded.contains(name))
		return false;
	if (! stopRequested) {
		stopRequested = true;
		pushEvent({{"type", "stopping"}});
		loaded[name].contest->stopJudgingSlot();
	}
	return true;
}

bool ContestManager::cancelJudge(const QString &requested) {
	const QString name = canonicalName(requested);
	if (! judging || running.contest != name || ! loaded.contains(name))
		return false;
	if (! stopRequested) {
		stopRequested = true;
		cancelRequested = true;
		pushEvent({{"type", "canceling"}});
		loaded[name].contest->cancelJudgingSlot();
	}
	return true;
}

void ContestManager::scheduleNext() {
	if (judging || nextScheduled || queue.isEmpty())
		return;
	nextScheduled = true;
	// Contest::judge() runs its own event loop until all tasks are judged (like the GUI's modal
	// JudgingDialog). Start it from the event loop so that the HTTP request can return immediately.
	QTimer::singleShot(0, this, [this] {
		nextScheduled = false;
		startNext();
	});
}

void ContestManager::startNext() {
	while (! judging && ! queue.isEmpty()) {
		const Job job = queue.takeFirst();
		if (isArchived(job.contest)) {
			pushEvent({{"type", "skipped"}, {"job", double(job.id)}, {"contest", job.contest}, {"error", tr("This contest is archived.")}});
			continue;
		}
		QString error;
		Contest *c = nullptr;
		if (loaded.contains(job.contest)) {
			c = loaded[job.contest].contest;
		} else {
			// it may have been unloaded meanwhile (contests that are queued are not, but be safe)
			const QString cdf = findCdf(contestDir(job.contest));
			if (! cdf.isEmpty() && (c = loadContest(cdf, &error)))
				addLoaded(job.contest, c, QFileInfo(cdf).fileName());
			else if (error.isEmpty())
				error = tr("Contest not found");
		}
		QList<std::pair<QString, QVector<int>>> list;
		qint64 total = 0;
		int count = 0;
		if (c) {
			if (job.request["refresh"].toBool()) {
				c->refreshContestantList();
				touch(job.contest);
				saveContest(job.contest);
			}
			QMap<QString, QVector<int>> mapping;
			if (judgeCells(c, job.request, &mapping, &error)) {
				restrictToOwner(job.contest, job.request, &mapping);
				list = judgeList(c, mapping, &total, &count);
			}
			if (list.isEmpty() && error.isEmpty())
				error = tr("Nothing to judge");
		}
#ifndef Q_OS_WIN
		// A checker uploaded without its executable bit (single file upload, zip made on Windows) cannot run.
		if (c && ! list.isEmpty()) {
			for (const auto *t : c->getTaskList()) {
				if (t->getComparisonMode() != Task::LemonSpecialJudgeMode &&
				    t->getComparisonMode() != Task::TestlibSpecialJudgeMode)
					continue;
				QFile checker(c->dataPath() + t->getSpecialJudge());
				if (checker.exists() && ! (checker.permissions() & QFile::ExeOwner))
					checker.setPermissions(checker.permissions() | QFile::ExeOwner | QFile::ExeUser |
					                       QFile::ExeGroup | QFile::ExeOther);
			}
		}
#endif
		if (list.isEmpty()) {
			LOG("Skipped judging job", job.id, "of", job.contest, ":", error);
			pushEvent({{"type", "skipped"}, {"job", double(job.id)}, {"contest", job.contest}, {"error", error}});
			continue;
		}

		running = job;
		judging = true;
		stopRequested = false;
		cancelRequested = false;
		progressValue = 0;
		progressMaximum = total;
		tasksDone = 0;
		tasksTotal = count;
		changedWhileJudging.clear();
		judgeStarted = QDateTime::currentDateTime();
		judgeFinished = QDateTime();
		events.clear(); // each run has its own log; event ids keep increasing
		pushEvent({{"type", "start"}, {"tasks", count}, {"job", double(job.id)}, {"contest", job.contest}});
		LOG("Judging job", job.id, "of", job.contest, ":", count, "cell(s)");
		QTimer::singleShot(0, this, [this, list] { runJudge(list); });
		return;
	}
}

void ContestManager::runJudge(const QList<std::pair<QString, QVector<int>>> &list) {
	Contest *c = loaded.value(running.contest).contest;
	// stopped / canceled before it really started: nothing was judged, nothing changes
	if (c && ! stopRequested)
		c->judge(list);
	judging = false;
	// sources replaced during the run may have been judged in their old version
	for (const auto &key : std::as_const(changedWhileJudging)) {
		const auto parts = key.split('\n');
		if (Contestant *ct = c->getContestant(parts[0])) {
			const int j = parts[1].toInt();
			if (j >= 0 && j < c->getTaskList().size())
				ct->setCheckJudged(j, false);
		}
	}
	changedWhileJudging.clear();
	judgeFinished = QDateTime::currentDateTime();
	touch(running.contest);
	saveContest(running.contest);
	pushEvent({{"type", "finished"},
	           {"stopped", stopRequested},
	           {"canceled", cancelRequested},
	           {"job", double(running.id)},
	           {"contest", running.contest}});
	scheduleNext();
}

QJsonObject ContestManager::queueJson() const {
	QJsonArray waiting;
	for (int i = 0; i < queue.size(); i++)
		waiting.append(jobJson(queue[i], i + 1));
	QJsonValue current;
	if (judging) {
		auto r = jobJson(running, 0);
		r["tasksDone"] = tasksDone;
		r["tasksTotal"] = tasksTotal;
		r["progress"] = double(progressValue);
		r["progressMaximum"] = double(progressMaximum);
		r["stopRequested"] = stopRequested;
		r["started"] = judgeStarted.toString(Qt::ISODate);
		current = r;
	}
	return {{"running", current}, {"queue", waiting}};
}

QJsonObject ContestManager::judgeStatus(qint64 since) const {
	QJsonArray ev;
	const auto first = std::upper_bound(events.cbegin(), events.cend(), since, [](qint64 id, const QJsonObject &event) { return id < event["id"].toInteger(); });
	for (auto it = first; it != events.cend(); ++it) ev.append(*it);
	QJsonArray waiting;
	for (int i = 0; i < queue.size(); i++)
		waiting.append(jobJson(queue[i], i + 1));
	// judging: there is still work (a job is being judged or waiting); running: a job is being judged
	return {{"contest", running.contest},
	        {"job", double(running.id)},
	        {"judging", judging || nextScheduled || ! queue.isEmpty()},
	        {"running", judging},
	        {"stopRequested", stopRequested},
	        {"progress", double(progressValue)},
	        {"progressMaximum", double(progressMaximum)},
	        {"tasksDone", tasksDone},
	        {"tasksTotal", tasksTotal},
	        {"started", judgeStarted.isValid() ? judgeStarted.toString(Qt::ISODateWithMs) : QString()},
	        {"finished", judgeFinished.isValid() ? judgeFinished.toString(Qt::ISODate) : QString()},
	        {"queue", waiting},
	        {"lastEventId", double(nextEventId - 1)},
	        {"events", ev}};
}

void ContestManager::pushEvent(QJsonObject event) {
	touch(running.contest, false);
	event["id"] = double(nextEventId++);
	event["time"] = QDateTime::currentDateTime().toString("hh:mm:ss");
	events.append(event);
	while (events.size() > 20000)
		events.removeFirst();
}

void ContestManager::onSingleCaseFinished(const QString &contestant, int progress, int x, int y, int result,
                                          Score score, int timeUsed, qint64 memoryUsed) {
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
	touch(running.contest);
	tasksDone++;
	pushEvent({{"type", "taskFinished"}, {"done", tasksDone}, {"total", tasksTotal}});
	// Persist intermediate results like an autosave: at most every 2 s, and always within 2 s of a result.
	const QDateTime last = lastSaved.value(running.contest);
	if (! last.isValid() || last.msecsTo(QDateTime::currentDateTimeUtc()) >= 2000) {
		saveContest(running.contest);
	} else if (! saveScheduled) {
		saveScheduled = true;
		QTimer::singleShot(2000, this, [this, name = running.contest] {
			saveScheduled = false;
			if (loaded.contains(name))
				saveContest(name);
		});
	}
}

void ContestManager::onCompileError(int progress, int) { progressValue += progress; touch(running.contest, false); }
