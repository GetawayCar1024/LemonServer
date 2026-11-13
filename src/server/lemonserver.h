/*
 * SPDX-FileCopyrightText: 2026 LemonServer contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#pragma once

#include <QHostAddress>
#include <QHttpServer>
#include <QHttpServerRequest>
#include <QHttpServerResponse>
#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <optional>
#include <functional>
#include <QMap>

class Contest;
class Contestant;
class ContestManager;
class ServerConfig;
class Settings;

// HTTP front-end of LemonServer: REST API under /api and the bundled web UI.
class LemonServer : public QObject {
	Q_OBJECT
  public:
	LemonServer(Settings *settings, ServerConfig *config, ContestManager *manager, QString webRoot,
	            QObject *parent = nullptr);

	bool listen(const QHostAddress &address, quint16 port, QString *error);
	// Compilers found in PATH, like the built-in page of AddCompilerWizard.
	static QJsonArray detectCompilers();

  private:
	enum class Access { None, Session, ApiKey };

	void setupRoutes();
	void setupAuthRoutes();
	void setupSettingsRoutes();
	void setupImportRoutes();
	void setupTestlibRoutes();
	void setupContestRoutes();
	void setupPublicRoutes();
	void setupFileRoutes();

	Access access(const QHttpServerRequest &req) const;
	// Returns an error response if the request is not authenticated.
	std::optional<QHttpServerResponse> denied(const QHttpServerRequest &req, bool sessionOnly = false) const;
	// Opens the contest (making it current); on failure returns an error response.
	std::optional<QHttpServerResponse> withContest(const QString &name, Contest **out);
	// Something is being judged (settings and compilers are in use).
	std::optional<QHttpServerResponse> notWhileJudging() const;
	// The current contest is being judged or waiting in the judging queue: it can be viewed, not changed.
	std::optional<QHttpServerResponse> notWhileBusy() const;
	std::optional<QHttpServerResponse> notWhileArchived() const;
	// The .cdf and lemonserver.json are managed by the server, not through the file system API.
	bool isReservedFile(const QString &abs) const;
	// abs was written / removed: if it is a submission under source/, mark the results outdated.
	void sourceChanged(const QString &abs);
	// The CodeHub server making the request (X-CodeHub-Instance header), empty for other clients.
	QString clientInstance(const QHttpServerRequest &req) const;
	// Only the contestants of that CodeHub server (see ContestManager::claimContestant).
	QJsonObject forClient(const QHttpServerRequest &req, QJsonObject contest) const;
	QJsonObject judgeStatusFor(const QHttpServerRequest &req, qint64 since) const;
	// abs is under source/<who>/: a CodeHub server may only use its own contestants (claim = write).
	std::optional<QHttpServerResponse> checkSourceOwner(const QHttpServerRequest &req, const QString &abs, bool claim);

	QJsonObject contestJson(Contest *contest) const;
	QJsonObject contestantJson(Contest *contest, Contestant *ct) const;
	QJsonObject publicContestantJson(Contest *contest, Contestant *ct, bool details = false) const;
	QJsonObject publicContestJson(Contest *contest) const;
	QJsonObject publicJudgeStatus(const QString &name, qint64 since = 0) const;
	QHttpServerResponse cachedPublicResponse(const QString &key, quint64 revision, const QHttpServerRequest &request,
	                                         const std::function<QJsonObject()> &build, int lifetime = 1000) const;
	// Files submitted by a contestant for a task (source files, or answer files of an answers-only task).
	QStringList submissionFiles(Contest *contest, Contestant *ct, int taskIndex) const;
	void serveStatic(const QHttpServerRequest &req, QHttpServerResponder &responder) const;
	void reinstallTranslation();

	Settings *settings;
	ServerConfig *config;
	ContestManager *manager;
	QString webRoot;
	QHttpServer server;
	struct PublicSnapshot { quint64 revision; qint64 expires; QByteArray bytes; QByteArray etag; };
	mutable QMap<QString, PublicSnapshot> publicSnapshots;
	mutable qint64 publicSnapshotBytes = 0;
};
