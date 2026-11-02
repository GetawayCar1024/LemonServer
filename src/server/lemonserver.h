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
	// The .cdf and lemonserver.json are managed by the server, not through the file system API.
	bool isReservedFile(const QString &abs) const;
	// abs was written / removed: if it is a submission under source/, mark the results outdated.
	void sourceChanged(const QString &abs);

	QJsonObject contestJson(Contest *contest) const;
	QJsonObject contestantJson(Contest *contest, Contestant *ct) const;
	// Files submitted by a contestant for a task (source files, or answer files of an answers-only task).
	QStringList submissionFiles(Contest *contest, Contestant *ct, int taskIndex) const;
	void serveStatic(const QHttpServerRequest &req, QHttpServerResponder &responder) const;
	void reinstallTranslation();

	Settings *settings;
	ServerConfig *config;
	ContestManager *manager;
	QString webRoot;
	QHttpServer server;
};
