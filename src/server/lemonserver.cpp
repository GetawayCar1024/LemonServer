/*
 * SPDX-FileCopyrightText: 2026 LemonServer contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#include "lemonserver.h"
#include "contestmanager.h"
#include "jsonapi.h"
#include "serverconfig.h"
#include "testlibtools.h"

#include "base/LemonLog.hpp"
#include "base/LemonTranslator.hpp"
#include "base/compiler.h"
#include "base/settings.h"
#include "component/exportutil/exportutil.h"
#include "component/statistics/statisticsutil.h"
#include "core/contest.h"
#include "core/contestant.h"
#include "core/task.h"
#include "core/testcase.h"

#include <QBuffer>
#include <QFuture>
#include <QProcess>
#include <QtConcurrent/QtConcurrentRun>
#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QHttpHeaders>
#include <QHttpServerResponder>
#include <QJsonDocument>
#include <QMimeDatabase>
#include <QRandomGenerator>
#include <QSaveFile>
#include <QStandardPaths>
#include <QStringDecoder>
#include <QTcpServer>
#include <QTimeZone>
#include <QUrl>
#include <QUrlQuery>

#include <QtCore/private/qzipreader_p.h>
#include <QtCore/private/qzipwriter_p.h>

#define LEMON_MODULE_NAME "LemonServer"

using Method = QHttpServerRequest::Method;
using Status = QHttpServerResponse::StatusCode;
using namespace LemonServerJson;

namespace {
	constexpr qint64 kEditableFileSize = 100 * 1024;

	QHttpServerResponse jsonResponse(const QJsonObject &obj, Status status = Status::Ok) {
		return QHttpServerResponse(obj, status);
	}

	QHttpServerResponse jsonResponse(const QJsonArray &arr, Status status = Status::Ok) {
		return QHttpServerResponse(arr, status);
	}

	QHttpServerResponse errorResponse(Status status, const QString &message) {
		return QHttpServerResponse(QJsonObject{{"error", message}}, status);
	}

	QHttpServerResponse okResponse(QJsonObject extra = {}) {
		extra["ok"] = true;
		return QHttpServerResponse(extra);
	}

	QJsonObject parseBody(const QHttpServerRequest &req, bool *ok) {
		const auto body = req.body();
		if (body.trimmed().isEmpty()) {
			*ok = true;
			return {};
		}
		QJsonParseError err;
		const auto doc = QJsonDocument::fromJson(body, &err);
		*ok = err.error == QJsonParseError::NoError && doc.isObject();
		return doc.object();
	}

	QString queryValue(const QHttpServerRequest &req, const QString &key) {
		return req.query().queryItemValue(key, QUrl::FullyDecoded);
	}

	bool queryFlag(const QHttpServerRequest &req, const QString &key) {
		const auto v = queryValue(req, key).toLower();
		return v == "1" || v == "true" || v == "yes";
	}

	QHttpServerResponse downloadResponse(const QByteArray &mime, const QByteArray &data, const QString &fileName,
	                                     bool attachment = true) {
		QHttpServerResponse resp(mime, data);
		QHttpHeaders headers = resp.headers();
		const QByteArray encoded = QUrl::toPercentEncoding(fileName);
		headers.replaceOrAppend(QHttpHeaders::WellKnownHeader::ContentDisposition,
		                        QByteArray(attachment ? "attachment" : "inline") + "; filename*=UTF-8''" + encoded);
		headers.replaceOrAppend(QHttpHeaders::WellKnownHeader::CacheControl, "no-store");
		resp.setHeaders(std::move(headers));
		return resp;
	}

	QString decodeText(const QByteArray &data) {
		auto decoder = QStringDecoder(QStringDecoder::Utf8);
		QString text = decoder(data);
		if (! decoder.hasError())
			return text;
		return QString::fromLocal8Bit(data);
	}

	// Resolve `relative` inside <contestDir>/<root>, refusing anything that escapes it.
	bool resolvePath(const QString &contestDir, const QString &root, const QString &relative, QString *absolute,
	                 QString *baseDir, QString *error) {
		QString base;
		if (root == "data")
			base = QDir(contestDir).absoluteFilePath("data");
		else if (root == "source")
			base = QDir(contestDir).absoluteFilePath("source");
		else if (root == "contest" || root.isEmpty())
			base = QDir(contestDir).absolutePath();
		else {
			*error = "root must be one of data, source, contest";
			return false;
		}
		base = QDir::cleanPath(base);
		QString rel = relative;
		rel.replace('\\', '/');
		if (rel.contains(':') || rel.startsWith('/')) {
			*error = "invalid path";
			return false;
		}
		const QString abs = QDir::cleanPath(base + "/" + rel);
#ifdef Q_OS_WIN
		const auto cs = Qt::CaseInsensitive;
#else
		const auto cs = Qt::CaseSensitive;
#endif
		if (abs.compare(base, cs) != 0 && ! abs.startsWith(base + "/", cs)) {
			*error = "path escapes the contest folder";
			return false;
		}
		*absolute = abs;
		if (baseDir)
			*baseDir = base;
		return true;
	}

	QString safeZipEntry(QString name) {
		name.replace('\\', '/');
		name = QDir::cleanPath(name);
		if (name.isEmpty() || name == "." || name.startsWith("../") || name == ".." || name.startsWith('/') ||
		    name.contains(':'))
			return {};
		return name;
	}

	// "name.ext" -> "name (2).ext" until it does not exist in dir
	QString uniqueName(const QDir &dir, const QString &name) {
		if (! dir.exists(name))
			return name;
		QString base = name, ext;
		if (! QFileInfo(dir.filePath(name)).isDir()) {
			const int dot = name.lastIndexOf('.');
			if (dot > 0) {
				base = name.left(dot);
				ext = name.mid(dot);
			}
		}
		for (int i = 2;; i++) {
			const QString candidate = QString("%1 (%2)%3").arg(base).arg(i).arg(ext);
			if (! dir.exists(candidate))
				return candidate;
		}
	}

	bool copyRecursively(const QString &from, const QString &to) {
		QFileInfo fi(from);
		if (fi.isDir()) {
			if (! QDir().mkpath(to))
				return false;
			for (const auto &e : QDir(from).entryInfoList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden))
				if (! copyRecursively(e.absoluteFilePath(), QDir(to).filePath(e.fileName())))
					return false;
			return true;
		}
		return QFile::copy(from, to);
	}

	// Extract a zip archive into dest, optionally stripping a single common top-level folder.
	bool extractZip(QByteArray data, const QString &destPath, bool stripTop, int *files, QString *error) {
		QBuffer buffer(&data);
		buffer.open(QIODevice::ReadOnly);
		QZipReader zip(&buffer);
		if (! zip.isReadable() || zip.status() != QZipReader::NoError) {
			*error = LemonServer::tr("Not a valid zip archive");
			return false;
		}
		const auto infos = zip.fileInfoList();
		QString strip;
		if (stripTop) {
			QSet<QString> tops;
			bool allNested = true;
			for (const auto &fi : infos) {
				const QString entry = safeZipEntry(fi.filePath);
				if (entry.isEmpty())
					continue;
				const int slash = entry.indexOf('/');
				if (slash < 0 && fi.isFile)
					allNested = false;
				tops.insert(slash < 0 ? entry : entry.left(slash));
			}
			if (allNested && tops.size() == 1)
				strip = *tops.begin() + "/";
		}
		*files = 0;
		QDir dest(destPath);
		dest.mkpath(".");
		for (const auto &fi : infos) {
			QString entry = safeZipEntry(fi.filePath);
			if (entry.isEmpty())
				continue;
			if (! strip.isEmpty()) {
				if (! entry.startsWith(strip))
					continue;
				entry = entry.mid(strip.size());
				if (entry.isEmpty())
					continue;
			}
			if (fi.isDir) {
				dest.mkpath(entry);
			} else if (fi.isFile) {
				dest.mkpath(QFileInfo(entry).path());
				QFile f(dest.filePath(entry));
				if (f.open(QFile::WriteOnly)) {
					QByteArray content = zip.fileData(fi.filePath);
					// QZipReader decodes UTF-8 names in fileInfoList() but looks them up with the local
					// 8-bit codec in fileData(); retry with the name as fileData() sees it.
					if (content.isEmpty() && fi.size > 0)
						content = zip.fileData(QString::fromLocal8Bit(fi.filePath.toUtf8()));
					f.write(content);
					f.close();
#ifndef Q_OS_WIN
					// keep executables (e.g. compiled checkers) executable
					constexpr auto exe = QFile::ExeOwner | QFile::ExeUser | QFile::ExeGroup | QFile::ExeOther;
					if (fi.permissions & exe)
						f.setPermissions(f.permissions() | (fi.permissions & exe));
#endif
					(*files)++;
				}
			}
		}
		return true;
	}
} // namespace

LemonServer::LemonServer(Settings *settings, ServerConfig *config, ContestManager *manager, QString webRoot,
                         QObject *parent)
    : QObject(parent), settings(settings), config(config), manager(manager), webRoot(std::move(webRoot)) {
	setupRoutes();
}

bool LemonServer::listen(const QHostAddress &address, quint16 port, QString *error) {
	auto *tcp = new QTcpServer(this);
	if (! tcp->listen(address, port)) {
		*error = tcp->errorString();
		delete tcp;
		return false;
	}
	if (! server.bind(tcp)) {
		*error = "cannot bind HTTP server";
		delete tcp;
		return false;
	}
	return true;
}

// ----------------------------------------------------------------------------------------------
// Authentication helpers
// ----------------------------------------------------------------------------------------------

LemonServer::Access LemonServer::access(const QHttpServerRequest &req) const {
	QString credential;
	const auto auth = req.headers().value(QHttpHeaders::WellKnownHeader::Authorization).toByteArray().trimmed();
	if (auth.startsWith("Bearer ") || auth.startsWith("bearer "))
		credential = QString::fromUtf8(auth.mid(7)).trimmed();
	if (credential.isEmpty())
		credential = QString::fromUtf8(req.headers().value("X-API-Key").toByteArray()).trimmed();
	if (credential.isEmpty())
		credential = queryValue(req, "access_token");
	if (credential.isEmpty())
		return Access::None;
	if (config->checkSession(credential))
		return Access::Session;
	if (config->checkApiKey(credential))
		return Access::ApiKey;
	return Access::None;
}

std::optional<QHttpServerResponse> LemonServer::denied(const QHttpServerRequest &req, bool sessionOnly) const {
	const auto a = access(req);
	if (a == Access::None)
		return errorResponse(Status::Unauthorized, tr("Not authenticated"));
	if (sessionOnly && a != Access::Session)
		return errorResponse(Status::Forbidden, tr("This operation requires logging in with the access token"));
	return std::nullopt;
}

std::optional<QHttpServerResponse> LemonServer::withContest(const QString &name, Contest **out) {
	if (config->contestRoot().isEmpty())
		return errorResponse(Status::Conflict, tr("Default contest folder is not configured"));
	QString error;
	Contest *c = manager->open(name, &error);
	if (! c)
		return errorResponse(Status::NotFound, error);
	*out = c;
	return std::nullopt;
}

std::optional<QHttpServerResponse> LemonServer::notWhileJudging() const {
	if (manager->isJudging())
		return errorResponse(Status::Conflict, tr("Judging is in progress"));
	return std::nullopt;
}

std::optional<QHttpServerResponse> LemonServer::notWhileBusy() const {
	if (manager->isBusy(manager->currentName()))
		return QHttpServerResponse(
		    QJsonObject{{"error", tr("This contest is being judged or waiting to be judged. Remove its judging "
		                             "jobs from the queue to change it.")},
		                {"busy", true}},
		    Status::Conflict);
	return std::nullopt;
}

namespace {
#ifdef Q_OS_WIN
	constexpr auto kPathCase = Qt::CaseInsensitive;
#else
	constexpr auto kPathCase = Qt::CaseSensitive;
#endif
	bool sameOrInside(const QString &path, const QString &dir) {
		return path.compare(dir, kPathCase) == 0 || path.startsWith(dir + "/", kPathCase);
	}
} // namespace

bool LemonServer::isReservedFile(const QString &abs) const {
	return abs.compare(QDir::cleanPath(manager->currentCdfPath()), kPathCase) == 0 ||
	       abs.compare(QDir::cleanPath(manager->currentPropertiesPath()), kPathCase) == 0;
}

void LemonServer::sourceChanged(const QString &abs) {
	if (! manager->current())
		return;
	const QString base = QDir::cleanPath(QDir(manager->currentDir()).absoluteFilePath("source"));
	const QString path = QDir::cleanPath(abs);
	if (path.compare(base, kPathCase) == 0) {
		// the whole source folder: every contestant
		for (auto *ct : manager->current()->getContestantList())
			manager->markSourceChanged(ct->getContestantName(), {});
		return;
	}
	if (! sameOrInside(path, base))
		return;
	const QStringList parts = path.mid(base.size() + 1).split('/', Qt::SkipEmptyParts);
	if (! parts.isEmpty())
		manager->markSourceChanged(parts.first(), parts.mid(1));
}

QStringList LemonServer::submissionFiles(Contest *contest, Contestant *ct, int index) const {
	const Task *task = contest->getTask(index);
	if (! task)
		return {};
	const QString who = ct->getContestantName();
	const QDir dir(task->getSubFolderCheck()
	                   ? Settings::sourcePath() + who + QDir::separator() + task->getSourceFileName()
	                   : Settings::sourcePath() + who);
	QStringList names;
	if (task->getTaskType() == Task::AnswersOnly) {
		// TaskJudger: <input base name>.<answer extension>
		for (const auto *tc : task->getTestCaseList())
			for (const auto &in : tc->getInputFiles())
				names.append(QFileInfo(in).completeBaseName() + "." + task->getAnswerFileExtension());
	} else {
		names = ct->getSourceFile(index).split(' ', Qt::SkipEmptyParts);
		if (names.isEmpty()) {
			// not judged yet: look for <sourceFileName>.<ext> of any compiler
			for (const auto *comp : settings->getCompilerList())
				for (const auto &ext : comp->getSourceExtensions())
					names.append(task->getSourceFileName() + "." + ext);
		}
	}
	QStringList files;
	for (const auto &n : names) {
		const QString path = dir.absoluteFilePath(n);
		if (QFileInfo(path).isFile() && ! files.contains(path))
			files.append(path);
	}
	return files;
}

QJsonObject LemonServer::contestantJson(Contest *contest, Contestant *ct) const {
	auto obj = contestantSummary(contest, ct);
	QJsonArray tasks = obj["tasks"].toArray();
	for (int i = 0; i < tasks.size(); i++) {
		auto t = tasks[i].toObject();
		const auto files = submissionFiles(contest, ct, i);
		qint64 size = 0;
		for (const auto &f : files)
			size += QFileInfo(f).size();
		t["submitted"] = ! files.isEmpty();
		t["codeSize"] = files.isEmpty() ? QJsonValue() : QJsonValue(double(size));
		tasks[i] = t;
	}
	obj["tasks"] = tasks;
	return obj;
}

QJsonObject LemonServer::contestJson(Contest *contest) const {
	QJsonArray tasks;
	for (const auto *t : contest->getTaskList())
		tasks.append(taskToJson(t));
	QJsonArray contestants;
	for (auto *c : contest->getContestantList())
		contestants.append(contestantJson(contest, c));
	QJsonObject obj{{"name", manager->currentName()},
	                {"title", contest->getContestTitle()},
	                {"directory", QDir::toNativeSeparators(manager->currentDir())},
	                {"cdf", QFileInfo(manager->currentCdfPath()).fileName()},
	                {"totalScore", contest->getTotalScore()},
	                {"tasks", tasks},
	                {"contestants", contestants},
	                {"judging", manager->judgingContest() == manager->currentName()},
	                {"busy", manager->isBusy(manager->currentName())},
	                {"queuedJobs", manager->queuedJobs(manager->currentName())}};
	const auto props = manager->propertiesJson();
	for (auto it = props.begin(); it != props.end(); ++it)
		obj[it.key()] = it.value();
	return obj;
}

void LemonServer::reinstallTranslation() {
	if (! Lemon::common::LemonLimeTranslator)
		Lemon::common::LemonLimeTranslator = std::make_unique<Lemon::common::LemonTranslator>();
	Lemon::common::LemonLimeTranslator->InstallTranslation(settings->getUiLanguage());
}

// ----------------------------------------------------------------------------------------------
// Routes
// ----------------------------------------------------------------------------------------------

void LemonServer::setupRoutes() {
	setupAuthRoutes();
	setupSettingsRoutes();
	setupImportRoutes();
	setupTestlibRoutes();
	setupContestRoutes();
	setupFileRoutes();

	server.setMissingHandler(this, [this](const QHttpServerRequest &req, QHttpServerResponder &responder) {
		serveStatic(req, responder);
	});
}

void LemonServer::serveStatic(const QHttpServerRequest &req, QHttpServerResponder &responder) const {
	QString path = req.url().path();
	if (path.startsWith("/api/") || path == "/api") {
		responder.sendResponse(errorResponse(Status::NotFound, "no such API endpoint"));
		return;
	}
	if (req.method() != Method::Get && req.method() != Method::Head) {
		responder.sendResponse(QHttpServerResponse(Status::MethodNotAllowed));
		return;
	}
	path = QDir::cleanPath(path);
	if (path.isEmpty() || path == "/" || path.contains(".."))
		path = "/index.html";

	QString file;
	if (! webRoot.isEmpty() && QFileInfo(webRoot + path).isFile())
		file = webRoot + path;
	else if (QFileInfo(":/web" + path).isFile())
		file = ":/web" + path;
	else if (! QFileInfo(path).suffix().isEmpty()) {
		responder.sendResponse(QHttpServerResponse(Status::NotFound));
		return;
	} else
		file = webRoot.isEmpty() || ! QFileInfo(webRoot + "/index.html").isFile() ? ":/web/index.html"
		                                                                           : webRoot + "/index.html";

	QFile f(file);
	if (! f.open(QFile::ReadOnly)) {
		responder.sendResponse(QHttpServerResponse(Status::NotFound));
		return;
	}
	QByteArray mime = QMimeDatabase().mimeTypeForFile(file, QMimeDatabase::MatchExtension).name().toLatin1();
	if (file.endsWith(".js"))
		mime = "text/javascript";
	if (mime.startsWith("text/") || mime == "application/javascript")
		mime += "; charset=utf-8";
	QHttpServerResponse resp(mime, f.readAll());
	QHttpHeaders headers = resp.headers();
	headers.replaceOrAppend(QHttpHeaders::WellKnownHeader::CacheControl, "no-cache");
	resp.setHeaders(std::move(headers));
	responder.sendResponse(resp);
}

void LemonServer::setupAuthRoutes() {
	server.route("/api/auth/status", Method::Get, [this](const QHttpServerRequest &req) {
		const auto a = access(req);
		return jsonResponse(QJsonObject{{"authenticated", a != Access::None},
		                                {"session", a == Access::Session},
		                                {"tokenIsDefault", config->tokenIsDefault()},
		                                {"setupRequired", config->contestRoot().isEmpty()},
		                                {"version", QString(LEMONSERVER_VERSION)},
		                                {"lemonlimeVersion", QString(LEMON_VERSION_STRING)},
		                                {"platform", QSysInfo::prettyProductName()}});
	});

	server.route("/api/auth/login", Method::Post, [this](const QHttpServerRequest &req) {
		bool ok = false;
		const auto body = parseBody(req, &ok);
		if (! ok || ! config->checkToken(body["token"].toString())) {
			LOG("Failed login from", req.remoteAddress().toString());
			return errorResponse(Status::Unauthorized, tr("Wrong token"));
		}
		return jsonResponse(QJsonObject{{"session", config->newSession()},
		                                {"tokenIsDefault", config->tokenIsDefault()},
		                                {"setupRequired", config->contestRoot().isEmpty()}});
	});

	server.route("/api/auth/logout", Method::Post, [this](const QHttpServerRequest &req) {
		const auto auth = req.headers().value(QHttpHeaders::WellKnownHeader::Authorization).toByteArray().trimmed();
		if (auth.startsWith("Bearer ") || auth.startsWith("bearer "))
			config->dropSession(QString::fromUtf8(auth.mid(7)).trimmed());
		return okResponse();
	});

	server.route("/api/auth/token", Method::Put, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req, true))
			return std::move(*r);
		bool ok = false;
		const auto body = parseBody(req, &ok);
		if (! ok)
			return errorResponse(Status::BadRequest, "invalid JSON");
		if (! config->checkToken(body["currentToken"].toString()))
			return errorResponse(Status::Forbidden, tr("Current token is wrong"));
		const QString token = body["newToken"].toString();
		if (token.size() < 4)
			return errorResponse(Status::BadRequest, tr("The new token must have at least 4 characters"));
		config->setToken(token);
		config->save();
		// all sessions are invalidated, hand out a fresh one for the caller
		return jsonResponse(QJsonObject{{"ok", true}, {"session", config->newSession()}});
	});

	server.route("/api/apikeys", Method::Get, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req, true))
			return std::move(*r);
		return jsonResponse(config->listApiKeys());
	});

	server.route("/api/apikeys", Method::Post, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req, true))
			return std::move(*r);
		bool ok = false;
		const auto body = parseBody(req, &ok);
		if (! ok)
			return errorResponse(Status::BadRequest, "invalid JSON");
		QString key = body["key"].toString().trimmed();
		if (key.isEmpty()) {
			QByteArray bytes(24, Qt::Uninitialized);
			for (auto &c : bytes)
				c = char(QRandomGenerator::system()->bounded(256));
			key = "lsk_" + QString::fromLatin1(bytes.toBase64(QByteArray::Base64UrlEncoding |
			                                                  QByteArray::OmitTrailingEquals));
		} else if (key.size() < 8) {
			return errorResponse(Status::BadRequest, tr("An API key must have at least 8 characters"));
		}
		if (config->checkApiKey(key) || config->checkToken(key))
			return errorResponse(Status::Conflict, tr("This API key is already in use"));
		const auto info = config->addApiKey(body["name"].toString().trimmed(), key);
		return jsonResponse(QJsonObject{{"key", key}, {"info", info}});
	});

	server.route("/api/apikeys/<arg>", Method::Delete, [this](const QString &id, const QHttpServerRequest &req) {
		if (auto r = denied(req, true))
			return std::move(*r);
		if (! config->deleteApiKey(id))
			return errorResponse(Status::NotFound, "no such key");
		return okResponse();
	});
}

QJsonArray LemonServer::detectCompilers() {
	// Mirrors the "built-in compilers" page of AddCompilerWizard
	QJsonArray list;
	QString stackArg;
#ifdef Q_OS_WIN32
	stackArg = " -Wl,--stack=2147483647";
#endif
	auto addConfigs = [](QJsonObject &c, const QList<std::pair<QString, QString>> &configs) {
		QJsonArray names, cargs, iargs;
		for (const auto &[n, a] : configs) {
			names.append(n);
			cargs.append(a);
			iargs.append(QString());
		}
		c["configurationNames"] = names;
		c["compilerArguments"] = cargs;
		c["interpreterArguments"] = iargs;
	};
	auto envFor = [](const QString &path) {
		QJsonArray env;
#ifdef Q_OS_WIN32
		env.append("PATH=" + QDir::toNativeSeparators(QFileInfo(path).absolutePath()));
#else
		Q_UNUSED(path)
#endif
		return env;
	};
	auto base = [](const QString &name, const QStringList &ext, int type) {
		return QJsonObject{{"compilerType", type},
		                   {"compilerName", name},
		                   {"sourceExtensions", QJsonArray::fromStringList(ext)},
		                   {"compilerLocation", QString()},
		                   {"interpreterLocation", QString()},
		                   {"bytecodeExtensions", QJsonArray()},
		                   {"timeLimitRatio", 1.0},
		                   {"memoryLimitRatio", 1.0},
		                   {"disableMemoryLimitCheck", false},
		                   {"interpreterAsWatcher", false},
		                   {"environment", QJsonArray()}};
	};

	if (const QString gcc = QStandardPaths::findExecutable("gcc"); ! gcc.isEmpty()) {
		auto c = base("gcc", {"c"}, Compiler::Typical);
		c["compilerLocation"] = gcc;
		c["environment"] = envFor(gcc);
		QList<std::pair<QString, QString>> conf{{"default", "-o %s %s.* -lm" + stackArg}};
		for (const QString ver : {"89", "99", "11", "17"}) {
			conf.append({"C" + ver, "-o %s %s.* -lm -std=c" + ver + stackArg});
			conf.append({"C" + ver + " O2", "-o %s %s.* -lm -std=c" + ver + " -O2" + stackArg});
		}
		addConfigs(c, conf);
		list.append(c);
	}
	if (const QString gpp = QStandardPaths::findExecutable("g++"); ! gpp.isEmpty()) {
		auto c = base("g++", {"cpp", "cc", "cxx"}, Compiler::Typical);
		c["compilerLocation"] = gpp;
		c["environment"] = envFor(gpp);
		QList<std::pair<QString, QString>> conf{{"default", "-o %s %s.* -lm" + stackArg}};
		for (const QString ver : {"98", "03", "11", "14", "17", "20"}) {
			conf.append({"C++" + ver, "-o %s %s.* -lm -std=c++" + ver + stackArg});
			conf.append({"C++" + ver + " O2", "-o %s %s.* -lm -std=c++" + ver + " -O2" + stackArg});
		}
		addConfigs(c, conf);
		list.append(c);
	}
	if (const QString fpc = QStandardPaths::findExecutable("fpc"); ! fpc.isEmpty()) {
		auto c = base("fpc", {"pas", "pp", "inc"}, Compiler::Typical);
		c["compilerLocation"] = fpc;
		addConfigs(c, {{"default", "%s.*"}, {"O2", "%s.* -O2"}});
		list.append(c);
	}
	const QString javac = QStandardPaths::findExecutable("javac");
	const QString java = QStandardPaths::findExecutable("java");
	if (! javac.isEmpty() && ! java.isEmpty()) {
		auto c = base("jdk", {"java"}, Compiler::InterpretiveWithByteCode);
		c["compilerLocation"] = javac;
		c["interpreterLocation"] = java;
		c["bytecodeExtensions"] = QJsonArray{"class"};
		c["timeLimitRatio"] = 5.0;
		c["disableMemoryLimitCheck"] = true;
		c["configurationNames"] = QJsonArray{"default"};
		c["compilerArguments"] = QJsonArray{"%s.*"};
		c["interpreterArguments"] = QJsonArray{"-Xmx512m %s"};
		list.append(c);
	}
	QString python = QStandardPaths::findExecutable("python3");
	if (python.isEmpty() || python.contains("WindowsApps"))
		python = QStandardPaths::findExecutable("python");
	if (! python.isEmpty() && ! python.contains("WindowsApps")) {
		auto c = base("python", {"py"}, Compiler::InterpretiveWithoutByteCode);
		c["interpreterLocation"] = python;
		c["timeLimitRatio"] = 10.0;
		c["memoryLimitRatio"] = 5.0;
		c["configurationNames"] = QJsonArray{"default"};
		c["compilerArguments"] = QJsonArray{""};
		c["interpreterArguments"] = QJsonArray{"%s.*"};
		list.append(c);
	}
	return list;
}

void LemonServer::setupSettingsRoutes() {
	server.route("/api/setup", Method::Get, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		return jsonResponse(QJsonObject{{"contestRoot", QDir::toNativeSeparators(config->contestRoot())},
		                                {"configFile", QDir::toNativeSeparators(config->path())},
		                                {"suggestedRoot",
		                                 QDir::toNativeSeparators(
		                                     QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation) +
		                                     "/LemonServerContests")}});
	});

	server.route("/api/setup", Method::Put, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req, true))
			return std::move(*r);
		if (auto r = notWhileJudging())
			return std::move(*r);
		if (manager->hasQueuedJobs())
			return errorResponse(Status::Conflict, tr("Contests are waiting to be judged"));
		bool ok = false;
		const auto body = parseBody(req, &ok);
		const QString root = body["contestRoot"].toString().trimmed();
		if (! ok || root.isEmpty())
			return errorResponse(Status::BadRequest, tr("contestRoot is required"));
		if (QDir::isRelativePath(root))
			return errorResponse(Status::BadRequest, tr("Please use an absolute path"));
		if (! QDir().mkpath(root))
			return errorResponse(Status::BadRequest, tr("Cannot create folder %1").arg(root));
		manager->closeAll();
		config->setContestRoot(root);
		QDir::setCurrent(config->contestRoot());
		return okResponse({{"contestRoot", QDir::toNativeSeparators(config->contestRoot())}});
	});

	server.route("/api/settings", Method::Get, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		auto obj = settingsToJson(settings);
		obj["languages"] = QJsonArray::fromStringList(
		    Lemon::common::LemonLimeTranslator ? Lemon::common::LemonLimeTranslator->GetAvailableLanguages()
		                                       : QStringList());
		return jsonResponse(obj);
	});

	server.route("/api/settings", Method::Put, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		if (auto r = notWhileJudging())
			return std::move(*r);
		bool ok = false;
		const auto body = parseBody(req, &ok);
		if (! ok)
			return errorResponse(Status::BadRequest, "invalid JSON");
		const QString oldLanguage = settings->getUiLanguage();
		applySettingsJson(settings, body);
		settings->saveSettings();
		if (settings->getUiLanguage() != oldLanguage)
			reinstallTranslation();
		return jsonResponse(settingsToJson(settings));
	});

	server.route("/api/compilers", Method::Get, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		QJsonArray arr;
		for (const auto *c : settings->getCompilerList())
			arr.append(compilerToJson(c));
		return jsonResponse(arr);
	});

	server.route("/api/compilers/detect", Method::Get, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		return jsonResponse(detectCompilers());
	});

	server.route("/api/compilers", Method::Put, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		if (auto r = notWhileJudging())
			return std::move(*r);
		const auto doc = QJsonDocument::fromJson(req.body());
		if (! doc.isArray())
			return errorResponse(Status::BadRequest, "expected a JSON array of compilers");
		QList<Compiler *> list;
		QSet<QString> names;
		for (const auto &v : doc.array()) {
			QString error;
			Compiler *c = compilerFromJson(v.toObject(), &error);
			if (c && names.contains(c->getCompilerName())) {
				error = tr("Duplicated compiler name %1").arg(c->getCompilerName());
				delete c;
				c = nullptr;
			}
			if (! c) {
				qDeleteAll(list);
				return errorResponse(Status::BadRequest, error);
			}
			names.insert(c->getCompilerName());
			list.append(c);
		}
		while (! settings->getCompilerList().isEmpty())
			settings->deleteCompiler(0);
		for (auto *c : list)
			settings->addCompiler(c);
		settings->saveSettings();
		if (Contest *c = manager->current()) {
			for (auto *t : c->getTaskList())
				t->refreshCompilerConfiguration(settings);
			manager->save();
		}
		QJsonArray arr;
		for (const auto *c : settings->getCompilerList())
			arr.append(compilerToJson(c));
		return jsonResponse(arr);
	});
}

void LemonServer::setupImportRoutes() {
	// Upload a ready-made contest (folder with .cdf, data/ and source/).
	// 1) as one zip:            POST /api/import-contest?name=&overwrite=1   (body = zip)
	// 2) as separate files:     PUT  /api/import-contest/file?id=&path=      (body = file), then
	//                           POST /api/import-contest/finish?id=&name=&overwrite=1
	static const QRegularExpression idPattern("^[A-Za-z0-9_-]{4,64}$");
	auto finish = [this](const QString &staging, const QHttpServerRequest &req) {
		QString finalName, error;
		if (! manager->importContest(staging, queryValue(req, "name").trimmed(), queryFlag(req, "overwrite"), &finalName,
		                             &error))
			return errorResponse(Status::BadRequest, error);
		return jsonResponse(QJsonObject{{"ok", true}, {"name", finalName}}, Status::Created);
	};

	server.route("/api/import-contest", Method::Post, [this, finish](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		if (config->contestRoot().isEmpty())
			return errorResponse(Status::Conflict, tr("Default contest folder is not configured"));
		const QString staging =
		    manager->importStagingDir("zip-" + QString::number(QDateTime::currentMSecsSinceEpoch()) + "-" +
		                              QString::number(QRandomGenerator::global()->bounded(1 << 30)));
		int files = 0;
		QString error;
		if (! extractZip(req.body(), staging, false, &files, &error)) {
			QDir(staging).removeRecursively();
			return errorResponse(Status::BadRequest, error);
		}
		return finish(staging, req);
	});

	server.route("/api/import-contest/file", Method::Put | Method::Post, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		if (config->contestRoot().isEmpty())
			return errorResponse(Status::Conflict, tr("Default contest folder is not configured"));
		const QString id = queryValue(req, "id");
		if (! idPattern.match(id).hasMatch())
			return errorResponse(Status::BadRequest, "invalid id");
		QString abs, base, error;
		if (! resolvePath(manager->importStagingDir(id), "contest", queryValue(req, "path"), &abs, &base, &error) ||
		    abs == base)
			return errorResponse(Status::BadRequest, error.isEmpty() ? "path is required" : error);
		QDir().mkpath(QFileInfo(abs).absolutePath());
		QFile f(abs);
		if (! f.open(QFile::WriteOnly))
			return errorResponse(Status::InternalServerError, tr("Cannot write %1").arg(abs));
		f.write(req.body());
		return okResponse();
	});

	server.route("/api/import-contest/finish", Method::Post, [this, finish](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		const QString id = queryValue(req, "id");
		if (! idPattern.match(id).hasMatch() || ! QFileInfo(manager->importStagingDir(id)).isDir())
			return errorResponse(Status::BadRequest, "unknown import id");
		return finish(manager->importStagingDir(id), req);
	});

	server.route("/api/import-contest", Method::Delete, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		const QString id = queryValue(req, "id");
		if (! idPattern.match(id).hasMatch())
			return errorResponse(Status::BadRequest, "invalid id");
		QDir(manager->importStagingDir(id)).removeRecursively();
		return okResponse();
	});
}

void LemonServer::setupTestlibRoutes() {
	server.route("/api/testlib/templates", Method::Get, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		return jsonResponse(QJsonArray::fromStringList(TestlibTools::templateNames()));
	});

	server.route("/api/testlib/testlib.h", Method::Get, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		return downloadResponse("text/x-c++hdr", TestlibTools::testlibHeader(), "testlib.h");
	});

	// Put a template (e.g. checkers/wcmp.cpp) into a folder: {"root","path":"dir","template","name"?}
	server.route("/api/contests/<arg>/files/template", Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             bool ok = false;
		             const auto body = parseBody(req, &ok);
		             const QString tpl = body["template"].toString();
		             const QByteArray data =
		                 tpl == "testlib.h" ? TestlibTools::testlibHeader() : TestlibTools::templateSource(tpl);
		             if (data.isEmpty())
			             return errorResponse(Status::NotFound, tr("Unknown template %1").arg(tpl));
		             QString dir, error;
		             if (! resolvePath(manager->currentDir(), body["root"].toString(), body["path"].toString(), &dir,
		                               nullptr, &error))
			             return errorResponse(Status::BadRequest, error);
		             QString fileName = body["name"].toString().trimmed();
		             if (fileName.isEmpty())
			             fileName = QFileInfo(tpl).fileName();
		             if (fileName.contains('/') || fileName.contains('\\') || fileName.contains(".."))
			             return errorResponse(Status::BadRequest, "invalid name");
		             QDir().mkpath(dir);
		             fileName = uniqueName(QDir(dir), fileName);
		             QFile f(QDir(dir).filePath(fileName));
		             if (! f.open(QFile::WriteOnly))
			             return errorResponse(Status::InternalServerError, tr("Cannot write %1").arg(fileName));
		             f.write(data);
		             return okResponse({{"name", fileName}});
	             });

	// Compile a source file on the server with Testlib for Lemons:
	// {"root","path","output"?,"compiler"?,"arguments"?:"-O2 -std=c++17","bundledTestlib"?:true}
	server.route(
	    "/api/contests/<arg>/files/compile", Method::Post,
	    [this](const QString &name, const QHttpServerRequest &req) -> QFuture<QHttpServerResponse> {
		    auto ready = [](QHttpServerResponse &&r) { return QtFuture::makeReadyValueFuture(std::move(r)); };
		    if (auto r = denied(req))
			    return ready(std::move(*r));
		    Contest *c = nullptr;
		    if (auto r = withContest(name, &c))
			    return ready(std::move(*r));
		    bool ok = false;
		    const auto body = parseBody(req, &ok);
		    if (! ok)
			    return ready(errorResponse(Status::BadRequest, "invalid JSON"));
		    const QString root = body["root"].toString();
		    QString src, base, error;
		    if (! resolvePath(manager->currentDir(), root, body["path"].toString(), &src, &base, &error))
			    return ready(errorResponse(Status::BadRequest, error));
		    const QFileInfo srcInfo(src);
		    if (! srcInfo.isFile())
			    return ready(errorResponse(Status::NotFound, tr("File not found")));

		    // pick the compiler: by name, otherwise the first typical compiler handling this extension
		    const Compiler *compiler = nullptr;
		    const QString wanted = body["compiler"].toString();
		    for (const auto *cmp : settings->getCompilerList()) {
			    if (cmp->getCompilerType() != Compiler::Typical)
				    continue;
			    if (wanted.isEmpty() ? cmp->getSourceExtensions().contains(srcInfo.suffix(), Qt::CaseInsensitive)
			                         : cmp->getCompilerName() == wanted) {
				    compiler = cmp;
				    break;
			    }
		    }
		    if (! compiler)
			    return ready(errorResponse(
			        Status::BadRequest,
			        wanted.isEmpty() ? tr("No compiled-language compiler handles .%1 files").arg(srcInfo.suffix())
			                         : tr("Compiler %1 not found").arg(wanted)));

		    QString output = body["output"].toString().trimmed();
		    if (output.isEmpty()) {
			    output = QDir(srcInfo.absolutePath()).filePath(srcInfo.completeBaseName());
			    output = QDir(base).relativeFilePath(output);
		    }
#ifdef Q_OS_WIN32
		    if (! output.endsWith(".exe", Qt::CaseInsensitive))
			    output += ".exe";
#endif
		    QString outAbs;
		    if (! resolvePath(manager->currentDir(), root, output, &outAbs, nullptr, &error) || outAbs == src)
			    return ready(errorResponse(Status::BadRequest, error.isEmpty() ? "invalid output" : error));

		    TestlibTools::CompileRequest request;
		    request.source = src;
		    request.output = outAbs;
		    request.compilerPath = compiler->getCompilerLocation();
		    request.environment = TestlibTools::compilerEnvironment(compiler);
		    request.arguments = body.contains("arguments")
		                            ? QProcess::splitCommand(body["arguments"].toString())
		                            : TestlibTools::defaultArguments(srcInfo.suffix());
		    request.bundledTestlib = body["bundledTestlib"].toBool(true);
		    request.timeoutMs = qMax(60000, settings->getCompileTimeLimit());
		    const QString compilerName = compiler->getCompilerName();
		    const QString relOutput = QDir(base).relativeFilePath(outAbs);
		    LOG("Compiling", src, "with", compilerName, "from", req.remoteAddress().toString());

		    return QtConcurrent::run([request, compilerName, relOutput] {
			    const auto r = TestlibTools::compile(request);
			    QJsonObject obj{{"ok", r.ok},
			                    {"compiler", compilerName},
			                    {"exitCode", r.exitCode},
			                    {"timedOut", r.timedOut},
			                    {"seconds", r.seconds},
			                    {"output", r.output},
			                    {"executable", r.ok ? relOutput : QString()}};
			    return QHttpServerResponse(obj, r.started ? Status::Ok : Status::InternalServerError);
		    });
	    });
}

void LemonServer::setupContestRoutes() {
	server.route("/api/contests", Method::Get, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		return jsonResponse(QJsonObject{{"contestRoot", QDir::toNativeSeparators(config->contestRoot())},
		                                {"judging", manager->isJudging()},
		                                {"judgingContest", manager->judgingContest()},
		                                {"queue", manager->queueJson()["queue"]},
		                                {"contests", manager->listContests()}});
	});

	server.route("/api/contests", Method::Post, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		bool ok = false;
		const auto body = parseBody(req, &ok);
		if (! ok)
			return errorResponse(Status::BadRequest, "invalid JSON");
		QString error;
		const QString name = body["name"].toString().trimmed();
		if (! manager->createContest(name, body["title"].toString().trimmed(), &error))
			return errorResponse(Status::BadRequest, error);
		return jsonResponse(contestJson(manager->current()), Status::Created);
	});

	// Clone a contest: {"name", "title"?, "withSubmissions"?: false}
	server.route("/api/contests/<arg>/clone", Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             bool ok = false;
		             const auto body = parseBody(req, &ok);
		             if (! ok)
			             return errorResponse(Status::BadRequest, "invalid JSON");
		             const QString to = body["name"].toString().trimmed();
		             QString error;
		             if (! manager->cloneContest(name, to, body["title"].toString().trimmed(),
		                                         body["withSubmissions"].toBool(), &error))
			             return errorResponse(manager->isBusy(name) ? Status::Conflict : Status::BadRequest, error);
		             Contest *c = nullptr;
		             if (auto r = withContest(to, &c))
			             return std::move(*r);
		             return jsonResponse(contestJson(c), Status::Created);
	             });

	server.route("/api/contests/<arg>", Method::Get, [this](const QString &name, const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		Contest *c = nullptr;
		if (auto r = withContest(name, &c))
			return std::move(*r);
		return jsonResponse(contestJson(c));
	});

	server.route("/api/contests/<arg>", Method::Put, [this](const QString &name, const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		Contest *c = nullptr;
		if (auto r = withContest(name, &c))
			return std::move(*r);
		bool ok = false;
		const auto body = parseBody(req, &ok);
		if (! ok)
			return errorResponse(Status::BadRequest, "invalid JSON");
		// "startTime" / "endTime" (the contest time of 0.1.5 and earlier) are ignored
		if (body.contains("downZip") || body.contains("title"))
			if (auto r = notWhileBusy())
				return std::move(*r);
		if (body.contains("downZip")) {
			QString error;
			if (! manager->setDownZip(body["downZip"].toString(), &error))
				return errorResponse(Status::BadRequest, error);
		}
		if (body.contains("title")) {
			c->setContestTitle(body["title"].toString());
			manager->save();
		}
		return jsonResponse(contestJson(c));
	});

	// down.zip of the contest (reserved for later use): GET downloads it, PUT/POST uploads it
	// (raw zip body, stored as <contest>/down.zip), DELETE clears it (&deleteFile=1 also removes the file).
	server.route("/api/contests/<arg>/down-zip", Method::Get,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             QFile f(QDir(manager->currentDir()).absoluteFilePath(manager->downZip()));
		             if (manager->downZip().isEmpty() || ! f.open(QFile::ReadOnly))
			             return errorResponse(Status::NotFound, tr("This contest has no down.zip"));
		             return downloadResponse("application/zip", f.readAll(), QFileInfo(f).fileName());
	             });

	server.route("/api/contests/<arg>/down-zip", Method::Put | Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             if (auto r = notWhileBusy())
			             return std::move(*r);
		             if (! req.body().startsWith("PK"))
			             return errorResponse(Status::BadRequest, tr("Not a valid zip archive"));
		             QSaveFile f(QDir(manager->currentDir()).absoluteFilePath("down.zip"));
		             if (! f.open(QFile::WriteOnly) || f.write(req.body()) != req.body().size() || ! f.commit())
			             return errorResponse(Status::InternalServerError, tr("Cannot write %1").arg("down.zip"));
		             QString error;
		             if (! manager->setDownZip("down.zip", &error))
			             return errorResponse(Status::InternalServerError, error);
		             return jsonResponse(manager->propertiesJson());
	             });

	server.route("/api/contests/<arg>/down-zip", Method::Delete,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             if (auto r = notWhileBusy())
			             return std::move(*r);
		             const QString file = manager->downZip();
		             QString error;
		             if (! manager->setDownZip(QString(), &error))
			             return errorResponse(Status::InternalServerError, error);
		             if (queryFlag(req, "deleteFile") && ! file.isEmpty())
			             QFile::remove(QDir(manager->currentDir()).absoluteFilePath(file));
		             return jsonResponse(manager->propertiesJson());
	             });

	server.route("/api/contests/<arg>", Method::Delete,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             QString error;
		             if (! manager->deleteContest(name, &error))
			             return errorResponse(Status::BadRequest, error);
		             return okResponse();
	             });

	server.route("/api/contests/<arg>/save", Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             QString error;
		             if (! manager->save(&error))
			             return errorResponse(Status::InternalServerError, error);
		             return okResponse();
	             });

	// ---------------- tasks ----------------
	server.route("/api/contests/<arg>/tasks", Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             if (auto r = notWhileBusy())
			             return std::move(*r);
		             bool ok = false;
		             auto body = parseBody(req, &ok);
		             if (! ok)
			             return errorResponse(Status::BadRequest, "invalid JSON");
		             // SummaryTree::addTask()
		             Task *newTask = new Task;
		             newTask->setAnswerFileExtension(settings->getDefaultOutputFileExtension());
		             if (! body.contains("problemTitle"))
			             body["problemTitle"] = tr("Problem %1").arg(c->getTaskList().size() + 1);
		             if (! body.contains("sourceFileName")) {
			             static const QRegularExpression word("^\\w+$");
			             const QString title = body["problemTitle"].toString();
			             if (word.match(title).hasMatch()) {
				             body["sourceFileName"] = title;
				             if (! body.contains("inputFileName"))
					             body["inputFileName"] = title + "." + settings->getDefaultInputFileExtension();
				             if (! body.contains("outputFileName"))
					             body["outputFileName"] =
					                 title + "." + settings->getDefaultOutputFileExtension();
			             }
		             }
		             QString error;
		             if (! applyTaskJson(newTask, body, settings, &error)) {
			             delete newTask;
			             return errorResponse(Status::BadRequest, error);
		             }
		             c->addTask(newTask);
		             newTask->refreshCompilerConfiguration(settings);
		             manager->save();
		             return jsonResponse(QJsonObject{{"index", int(c->getTaskList().size() - 1)},
		                                             {"task", taskToJson(newTask)}},
		                                 Status::Created);
	             });

	server.route("/api/contests/<arg>/tasks/<arg>", Method::Get,
	             [this](const QString &name, int index, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             Task *t = c->getTask(index);
		             if (! t)
			             return errorResponse(Status::NotFound, "no such task");
		             return jsonResponse(taskToJson(t));
	             });

	server.route("/api/contests/<arg>/tasks/<arg>", Method::Put,
	             [this](const QString &name, int index, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             if (auto r = notWhileBusy())
			             return std::move(*r);
		             Task *t = c->getTask(index);
		             if (! t)
			             return errorResponse(Status::NotFound, "no such task");
		             bool ok = false;
		             const auto body = parseBody(req, &ok);
		             if (! ok)
			             return errorResponse(Status::BadRequest, "invalid JSON");
		             QString error;
		             if (! applyTaskJson(t, body, settings, &error))
			             return errorResponse(Status::BadRequest, error);
		             manager->save();
		             return jsonResponse(taskToJson(t));
	             });

	server.route("/api/contests/<arg>/tasks/<arg>", Method::Delete,
	             [this](const QString &name, int index, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             if (auto r = notWhileBusy())
			             return std::move(*r);
		             if (! c->getTask(index))
			             return errorResponse(Status::NotFound, "no such task");
		             c->deleteTask(index);
		             manager->save();
		             return okResponse();
	             });

	server.route("/api/contests/<arg>/tasks/<arg>/move", Method::Post,
	             [this](const QString &name, int index, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             if (auto r = notWhileBusy())
			             return std::move(*r);
		             bool ok = false;
		             const auto body = parseBody(req, &ok);
		             const int to = body["direction"].toString() == "up" ? index - 1 : index + 1;
		             if (! c->getTask(index) || ! c->getTask(to))
			             return errorResponse(Status::BadRequest, "cannot move task");
		             c->swapTask(index, to);
		             manager->save();
		             return okResponse({{"index", to}});
	             });

	server.route("/api/contests/<arg>/scan-tasks", Method::Get,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             return jsonResponse(manager->scanNewTasks());
	             });

	server.route("/api/contests/<arg>/add-tasks", Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             if (auto r = notWhileBusy())
			             return std::move(*r);
		             bool ok = false;
		             const auto body = parseBody(req, &ok);
		             QJsonArray tasks = body["tasks"].toArray();
		             if (! body.contains("tasks")) {
			             // add everything that was found, with the default scores
			             for (const auto &t : manager->scanNewTasks())
				             tasks.append(QJsonObject{{"name", t.toObject()["name"]}});
		             }
		             const int added = manager->addTasks(tasks);
		             if (added == 0)
			             return errorResponse(Status::BadRequest, tr("No task found"));
		             manager->save();
		             return okResponse({{"added", added}});
	             });

	// ---------------- contestants ----------------
	server.route("/api/contests/<arg>/refresh", Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             if (auto r = notWhileBusy())
			             return std::move(*r);
		             c->refreshContestantList();
		             manager->save();
		             return jsonResponse(contestJson(c));
	             });

	server.route("/api/contests/<arg>/cleanup", Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             if (auto r = notWhileBusy())
			             return std::move(*r);
		             bool ok = false;
		             const auto body = parseBody(req, &ok);
		             const auto result = manager->cleanupSourceFiles(body["backup"].toBool(true));
		             if (! result["ok"].toBool())
			             return jsonResponse(result, Status::BadRequest);
		             return jsonResponse(result);
	             });

	server.route("/api/contests/<arg>/contestants/<arg>", Method::Get,
	             [this](const QString &name, const QString &who, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             Contestant *ct = c->getContestant(who);
		             if (! ct)
			             return errorResponse(Status::NotFound, "no such contestant");
		             auto obj = contestantJson(c, ct);
		             QJsonArray details;
		             for (int i = 0; i < c->getTaskList().size(); i++)
			             details.append(contestantTaskDetail(ct, i));
		             obj["details"] = details;
		             return jsonResponse(obj);
	             });

	server.route("/api/contests/<arg>/contestants/<arg>", Method::Delete,
	             [this](const QString &name, const QString &who, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             if (auto r = notWhileBusy())
			             return std::move(*r);
		             if (! c->getContestant(who))
			             return errorResponse(Status::NotFound, "no such contestant");
		             // ResultViewer::deleteContestant()
		             c->deleteContestant(who);
		             if (queryFlag(req, "deleteFiles") && ContestManager::isValidContestName(who))
			             QDir(Settings::sourcePath() + who).removeRecursively();
		             manager->save();
		             return okResponse();
	             });

	server.route("/api/contests/<arg>/contestants/<arg>/source/<arg>", Method::Get,
	             [this](const QString &name, const QString &who, int index, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             Contestant *ct = c->getContestant(who);
		             if (! ct || ! c->getTask(index))
			             return errorResponse(Status::NotFound, "not found");
		             QJsonArray files;
		             for (const auto &path : submissionFiles(c, ct, index)) {
			             QFile f(path);
			             if (! f.open(QFile::ReadOnly))
				             continue;
			             files.append(QJsonObject{{"name", QFileInfo(path).fileName()},
			                                      {"content", decodeText(f.read(4 << 20))}});
		             }
		             return jsonResponse(QJsonObject{{"files", files}});
	             });

	// ---------------- judging ----------------
	server.route("/api/contests/<arg>/judge", Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             bool ok = false;
		             const auto body = parseBody(req, &ok);
		             if (! ok)
			             return errorResponse(Status::BadRequest, "invalid JSON");
		             const QString mode = body["mode"].toString("all");
		             QJsonObject request{{"mode", mode}};
		             for (const char *key : {"items", "compileStates", "resultStates", "refresh"})
			             if (body.contains(key))
				             request[key] = body[key];
		             QJsonObject job;
		             QString error;
		             bool nothingToJudge = false;
		             if (! manager->enqueueJudge(request, &job, &error, &nothingToJudge))
			             return QHttpServerResponse(QJsonObject{{"error", error}, {"nothingToJudge", nothingToJudge}},
			                                        nothingToJudge ? Status::Conflict : Status::BadRequest);
		             auto status = manager->judgeStatus(0);
		             status["job"] = job;
		             return jsonResponse(status, Status::Accepted);
	             });

	// Remove every judging job of the contest from the queue (and stop it if it is being judged).
	server.route("/api/contests/<arg>/judge", Method::Delete,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             return okResponse({{"removed", manager->dequeueContest(name)}});
	             });

	// How many (contestant, task) cells have each compile state / contain each case result.
	server.route("/api/contests/<arg>/state-summary", Method::Get,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             QMap<int, int> compileCount, resultCount;
		             int unjudged = 0;
		             const auto tasks = c->getTaskList();
		             for (auto *ct : c->getContestantList()) {
			             for (int j = 0; j < tasks.size(); j++) {
				             if (! ct->getCheckJudged(j)) {
					             unjudged++;
					             continue;
				             }
				             if (tasks[j]->getTaskType() != Task::AnswersOnly)
					             compileCount[int(ct->getCompileState(j))]++;
				             QSet<int> seen;
				             for (const auto &row : ct->getResult(j))
					             for (auto r : row)
						             seen.insert(int(r));
				             for (int r : seen)
					             resultCount[r]++;
			             }
		             }
		             QJsonObject compile, result;
		             for (auto it = compileCount.begin(); it != compileCount.end(); ++it)
			             compile[QString::number(it.key())] = it.value();
		             for (auto it = resultCount.begin(); it != resultCount.end(); ++it)
			             result[QString::number(it.key())] = it.value();
		             return jsonResponse(QJsonObject{{"unjudged", unjudged}, {"compile", compile}, {"result", result}});
	             });

	server.route("/api/contests/<arg>/judge/stop", Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             if (! manager->stopJudge(name))
			             return errorResponse(Status::Conflict, tr("This contest is not being judged"));
		             return okResponse();
	             });

	// The judging log is shared by all contests (one job at a time); the contest in the path is not used.
	server.route("/api/contests/<arg>/judge/status", Method::Get, [this](const QString &, const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		return jsonResponse(manager->judgeStatus(queryValue(req, "since").toLongLong()));
	});
	server.route("/api/judge/status", Method::Get, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		return jsonResponse(manager->judgeStatus(queryValue(req, "since").toLongLong()));
	});

	// The judging queue of the whole server: {"running": job | null, "queue": [jobs]}
	server.route("/api/judge-queue", Method::Get, [this](const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		return jsonResponse(manager->queueJson());
	});
	server.route("/api/judge-queue/<arg>", Method::Delete, [this](qint64 id, const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		QString error;
		if (! manager->cancelJob(id, &error))
			return errorResponse(Status::NotFound, error);
		return okResponse();
	});

	// ---------------- export / statistics ----------------
	server.route("/api/contests/<arg>/export", Method::Get,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             // ExportUtil::exportResult()
		             if (c->getContestantList().isEmpty())
			             return errorResponse(Status::BadRequest, ExportUtil::tr("No contestant in current contest"));
		             if (c->getTaskList().isEmpty())
			             return errorResponse(Status::BadRequest, ExportUtil::tr("No task in current contest"));
		             const QString format = queryValue(req, "format").isEmpty() ? "html" : queryValue(req, "format");
		             QString content;
		             QByteArray mime;
		             if (format == "html") {
			             content = ExportUtil::generateHtml(c);
			             mime = "text/html; charset=utf-8";
		             } else if (format == "htm") {
			             content = ExportUtil::generateSmallerHtml(c);
			             mime = "text/html; charset=utf-8";
		             } else if (format == "csv") {
			             content = ExportUtil::generateCsv(c);
			             mime = "text/csv; charset=utf-8";
		             } else
			             return errorResponse(Status::BadRequest, "format must be html, htm or csv");
		             const QString fileName = "result." + format;
		             if (queryFlag(req, "save")) {
			             QString error;
			             if (! ExportUtil::writeResultFile(c, QDir(manager->currentDir()).filePath(fileName), &error))
				             return errorResponse(Status::InternalServerError, error);
			             return okResponse({{"file", QDir::toNativeSeparators(
			                                             QDir(manager->currentDir()).filePath(fileName))}});
		             }
		             QByteArray data = content.toUtf8();
		             if (format == "csv")
			             data.prepend("\xEF\xBB\xBF"); // let spreadsheet software detect UTF-8
		             return downloadResponse(mime, data, fileName, ! queryFlag(req, "inline"));
	             });

	server.route("/api/contests/<arg>/statistics", Method::Get,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             const QString html = StatisticsUtil::generateHtml(c);
		             if (queryFlag(req, "download"))
			             return downloadResponse("text/html; charset=utf-8", html.toUtf8(), "statistics.html");
		             return QHttpServerResponse("text/html; charset=utf-8", html.toUtf8());
	             });
}

void LemonServer::setupFileRoutes() {
	// List a directory: ?root=data|source|contest&path=sub/dir[&recursive=1]
	server.route("/api/contests/<arg>/files", Method::Get, [this](const QString &name, const QHttpServerRequest &req) {
		if (auto r = denied(req))
			return std::move(*r);
		Contest *c = nullptr;
		if (auto r = withContest(name, &c))
			return std::move(*r);
		QString abs, base, error;
		if (! resolvePath(manager->currentDir(), queryValue(req, "root"), queryValue(req, "path"), &abs, &base,
		                  &error))
			return errorResponse(Status::BadRequest, error);
		QDir dir(abs);
		if (! dir.exists())
			return errorResponse(Status::NotFound, tr("Folder not found"));
		QJsonArray entries;
		if (queryFlag(req, "recursive")) {
			QDirIterator it(abs, QDir::Files | QDir::Hidden, QDirIterator::Subdirectories);
			int count = 0;
			while (it.hasNext() && count < 50000) {
				it.next();
				entries.append(QJsonObject{{"path", dir.relativeFilePath(it.filePath())},
				                           {"size", double(it.fileInfo().size())}});
				count++;
			}
		} else {
			for (const auto &fi : dir.entryInfoList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden,
			                                        QDir::DirsFirst | QDir::Name | QDir::IgnoreCase)) {
				entries.append(QJsonObject{{"name", fi.fileName()},
				                           {"dir", fi.isDir()},
				                           {"size", double(fi.isDir() ? 0 : fi.size())},
				                           {"modified", fi.lastModified().toString("yyyy-MM-dd hh:mm:ss")}});
			}
		}
		QString rel = QDir(base).relativeFilePath(abs);
		if (rel == ".")
			rel.clear();
		return jsonResponse(QJsonObject{{"root", queryValue(req, "root")}, {"path", rel}, {"entries", entries}});
	});

	server.route("/api/contests/<arg>/files/download", Method::Get,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             QString abs, error;
		             if (! resolvePath(manager->currentDir(), queryValue(req, "root"), queryValue(req, "path"),
		                               &abs, nullptr, &error))
			             return errorResponse(Status::BadRequest, error);
		             QFileInfo fi(abs);
		             if (fi.isDir()) {
			             // zip the whole folder
			             QBuffer buffer;
			             buffer.open(QIODevice::WriteOnly);
			             {
				             QZipWriter zip(&buffer);
				             QDir dir(abs);
				             QDirIterator it(abs, QDir::Files | QDir::Hidden, QDirIterator::Subdirectories);
				             while (it.hasNext()) {
					             it.next();
					             QFile f(it.filePath());
					             if (! f.open(QFile::ReadOnly))
						             continue;
					             zip.setCreationPermissions(f.permissions()); // e.g. executable checkers
					             zip.addFile(dir.relativeFilePath(it.filePath()), f.readAll());
				             }
				             zip.close();
			             }
			             const QString zipName = (fi.fileName().isEmpty() ? QString("contest") : fi.fileName()) + ".zip";
			             return downloadResponse("application/zip", buffer.data(), zipName);
		             }
		             QFile f(abs);
		             if (! f.open(QFile::ReadOnly))
			             return errorResponse(Status::NotFound, tr("File not found"));
		             if (queryFlag(req, "text")) {
			             const QByteArray data = f.read(1 << 20);
			             const bool binary = data.contains('\0');
			             auto decoder = QStringDecoder(QStringDecoder::Utf8);
			             QString text = decoder(data);
			             const bool utf8 = ! decoder.hasError();
			             if (! utf8)
				             text = QString::fromLocal8Bit(data);
			             return jsonResponse(QJsonObject{
			                 {"name", fi.fileName()},
			                 {"size", double(fi.size())},
			                 {"modified", fi.lastModified().toString("yyyy-MM-dd hh:mm:ss")},
			                 {"modifiedMs", double(fi.lastModified().toMSecsSinceEpoch())},
			                 {"truncated", fi.size() > (1 << 20)},
			                 {"binary", binary},
			                 {"editable", ! binary && fi.size() < kEditableFileSize},
			                 {"encoding", utf8 ? "utf-8" : "local"},
			                 {"eol", data.contains("\r\n") ? "crlf" : "lf"},
			                 {"content", binary ? QString() : text}});
		             }
		             const QByteArray mime =
		                 QMimeDatabase().mimeTypeForFile(fi, QMimeDatabase::MatchExtension).name().toLatin1();
		             return downloadResponse(mime, f.readAll(), fi.fileName());
	             });

	// Upload one file (raw request body): PUT ?root=&path=dir/name.ext
	server.route("/api/contests/<arg>/files/upload", Method::Put | Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             QString abs, base, error;
		             if (! resolvePath(manager->currentDir(), queryValue(req, "root"), queryValue(req, "path"),
		                               &abs, &base, &error))
			             return errorResponse(Status::BadRequest, error);
		             if (abs == base || QFileInfo(abs).isDir())
			             return errorResponse(Status::BadRequest, tr("A file name is required"));
		             if (isReservedFile(abs))
			             return errorResponse(Status::BadRequest, tr("This item cannot be edited"));
		             QDir().mkpath(QFileInfo(abs).absolutePath());
		             QFile f(abs);
		             if (! f.open(QFile::WriteOnly))
			             return errorResponse(Status::InternalServerError, tr("Cannot write %1").arg(abs));
		             f.write(req.body());
		             f.close();
		             sourceChanged(abs);
		             return okResponse({{"size", double(req.body().size())},
		                                {"modified", QFileInfo(abs).lastModified().toString("yyyy-MM-dd hh:mm:ss")}});
	             });

	// Save a small text file edited in the browser:
	// {"root","path","content","encoding":"utf-8"|"local","eol":"lf"|"crlf","expectedModifiedMs"?}
	server.route("/api/contests/<arg>/files/text", Method::Put,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             bool ok = false;
		             const auto body = parseBody(req, &ok);
		             if (! ok)
			             return errorResponse(Status::BadRequest, "invalid JSON");
		             QString abs, base, error;
		             if (! resolvePath(manager->currentDir(), body["root"].toString(), body["path"].toString(), &abs,
		                               &base, &error))
			             return errorResponse(Status::BadRequest, error);
		             if (abs == base || QFileInfo(abs).isDir())
			             return errorResponse(Status::BadRequest, tr("A file name is required"));
		             if (isReservedFile(abs))
			             return errorResponse(Status::BadRequest, tr("This item cannot be edited"));
		             QFileInfo fi(abs);
		             if (fi.exists() && body.contains("expectedModifiedMs") &&
		                 qint64(body["expectedModifiedMs"].toDouble()) != fi.lastModified().toMSecsSinceEpoch())
			             return errorResponse(Status::Conflict,
			                                  tr("The file was modified at %1 by someone else")
			                                      .arg(fi.lastModified().toString("yyyy-MM-dd hh:mm:ss")));
		             QString text = body["content"].toString();
		             if (body["eol"].toString() == "crlf") {
			             text.replace("\r\n", "\n");
			             text.replace("\n", "\r\n");
		             }
		             const QByteArray data = body["encoding"].toString() == "local" ? text.toLocal8Bit() : text.toUtf8();
		             if (data.size() >= kEditableFileSize)
			             return errorResponse(Status::BadRequest, tr("Files edited online must be smaller than 100 KiB"));
		             QDir().mkpath(fi.absolutePath());
		             QFile f(abs);
		             if (! f.open(QFile::WriteOnly))
			             return errorResponse(Status::InternalServerError, tr("Cannot write %1").arg(abs));
		             f.write(data);
		             f.close();
		             fi.refresh();
		             sourceChanged(abs);
		             LOG("Edited", abs, "from", req.remoteAddress().toString());
		             return okResponse({{"size", double(fi.size())},
		                                {"modified", fi.lastModified().toString("yyyy-MM-dd hh:mm:ss")},
		                                {"modifiedMs", double(fi.lastModified().toMSecsSinceEpoch())}});
	             });

	// Extract a zip archive (raw request body) into ?root=&path=
	server.route("/api/contests/<arg>/files/unzip", Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             QString abs, error;
		             if (! resolvePath(manager->currentDir(), queryValue(req, "root"), queryValue(req, "path"),
		                               &abs, nullptr, &error))
			             return errorResponse(Status::BadRequest, error);
		             int files = 0;
		             if (! extractZip(req.body(), abs, queryFlag(req, "stripTop"), &files, &error))
			             return errorResponse(Status::BadRequest, error);
		             sourceChanged(abs);
		             return okResponse({{"files", files}});
	             });

	server.route("/api/contests/<arg>/files/mkdir", Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             bool ok = false;
		             const auto body = parseBody(req, &ok);
		             QString abs, error;
		             if (! resolvePath(manager->currentDir(), body["root"].toString(), body["path"].toString(), &abs,
		                               nullptr, &error))
			             return errorResponse(Status::BadRequest, error);
		             if (! QDir().mkpath(abs))
			             return errorResponse(Status::InternalServerError, tr("Cannot create folder %1").arg(abs));
		             return okResponse();
	             });

	server.route("/api/contests/<arg>/files/delete", Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             if (auto r = notWhileBusy())
			             return std::move(*r);
		             bool ok = false;
		             const auto body = parseBody(req, &ok);
		             QJsonArray paths = body["paths"].toArray();
		             if (body.contains("path"))
			             paths.append(body["path"]);
		             int removed = 0;
		             for (const auto &p : paths) {
			             QString abs, base, error;
			             if (! resolvePath(manager->currentDir(), body["root"].toString(), p.toString(), &abs, &base,
			                               &error))
				             return errorResponse(Status::BadRequest, error);
			             if (abs == base || isReservedFile(abs))
				             return errorResponse(Status::BadRequest, tr("This item cannot be deleted"));
			             QFileInfo fi(abs);
			             if (fi.isDir() ? QDir(abs).removeRecursively() : QFile::remove(abs)) {
				             removed++;
				             sourceChanged(abs);
			             }
		             }
		             return okResponse({{"removed", removed}});
	             });

	// Move or copy several items into a folder: {"root","paths":[...],"to":"dir","overwrite"?:false}
	for (const bool copy : {false, true}) {
		server.route(copy ? "/api/contests/<arg>/files/copy" : "/api/contests/<arg>/files/move", Method::Post,
		             [this, copy](const QString &name, const QHttpServerRequest &req) {
			             if (auto r = denied(req))
				             return std::move(*r);
			             Contest *c = nullptr;
			             if (auto r = withContest(name, &c))
				             return std::move(*r);
			             if (auto r = notWhileBusy())
				             return std::move(*r);
			             bool ok = false;
			             const auto body = parseBody(req, &ok);
			             const QString root = body["root"].toString();
			             QString dest, base, error;
			             if (! ok || ! resolvePath(manager->currentDir(), root, body["to"].toString(), &dest, &base, &error))
				             return errorResponse(Status::BadRequest, error.isEmpty() ? "invalid JSON" : error);
			             if (! QFileInfo(dest).isDir())
				             return errorResponse(Status::BadRequest, tr("Target folder not found"));
			             const QDir destDir(dest);
			             QJsonArray done;
			             for (const auto &p : body["paths"].toArray()) {
				             QString src, srcBase;
				             if (! resolvePath(manager->currentDir(), root, p.toString(), &src, &srcBase, &error))
					             return errorResponse(Status::BadRequest, error);
				             const QFileInfo fi(src);
				             if (src == srcBase || ! fi.exists())
					             return errorResponse(Status::BadRequest, tr("Not found: %1").arg(p.toString()));
				             if (! copy && isReservedFile(src))
					             return errorResponse(Status::BadRequest, tr("The contest file cannot be moved"));
				             if (dest == src || dest.startsWith(src + "/"))
					             return errorResponse(Status::BadRequest,
					                                  tr("Cannot put %1 into itself").arg(fi.fileName()));
				             if (! copy && fi.absolutePath() == dest)
					             continue; // already there
				             QString target = destDir.filePath(fi.fileName());
				             if (QFileInfo::exists(target)) {
					             if (copy || ! body["overwrite"].toBool())
						             target = destDir.filePath(uniqueName(destDir, fi.fileName()));
					             else if (QFileInfo(target).isDir() ? ! QDir(target).removeRecursively()
					                                                : ! QFile::remove(target))
						             return errorResponse(Status::InternalServerError, tr("Cannot replace %1").arg(target));
				             }
				             const bool success = copy ? copyRecursively(src, target) : QDir().rename(src, target);
				             if (! success)
					             return errorResponse(Status::InternalServerError,
					                                  tr("Cannot %1 %2").arg(copy ? "copy" : "move", fi.fileName()));
				             sourceChanged(target);
				             if (! copy)
					             sourceChanged(src);
				             done.append(QDir(base).relativeFilePath(target));
			             }
			             return okResponse({{"items", done}});
		             });
	}

	server.route("/api/contests/<arg>/files/rename", Method::Post,
	             [this](const QString &name, const QHttpServerRequest &req) {
		             if (auto r = denied(req))
			             return std::move(*r);
		             Contest *c = nullptr;
		             if (auto r = withContest(name, &c))
			             return std::move(*r);
		             if (auto r = notWhileBusy())
			             return std::move(*r);
		             bool ok = false;
		             const auto body = parseBody(req, &ok);
		             QString from, to, base, error;
		             if (! resolvePath(manager->currentDir(), body["root"].toString(), body["from"].toString(), &from,
		                               &base, &error) ||
		                 ! resolvePath(manager->currentDir(), body["root"].toString(), body["to"].toString(), &to,
		                               nullptr, &error))
			             return errorResponse(Status::BadRequest, error);
		             if (from == base || ! QFileInfo::exists(from) || QFileInfo::exists(to) || isReservedFile(from) ||
		                 isReservedFile(to))
			             return errorResponse(Status::BadRequest, tr("Cannot rename"));
		             QDir().mkpath(QFileInfo(to).absolutePath());
		             if (! QDir().rename(from, to))
			             return errorResponse(Status::InternalServerError, tr("Cannot rename"));
		             sourceChanged(from);
		             sourceChanged(to);
		             return okResponse();
	             });
}
