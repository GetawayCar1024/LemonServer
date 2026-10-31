/*
 * SPDX-FileCopyrightText: 2026 LemonServer contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#pragma once

#include <QDateTime>
#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>

// Server-only configuration (access token, API keys, default contest folder).
// Judging settings and compilers stay in LemonLime's own Settings class (stored in settings.ini).
class ServerConfig {
  public:
	static constexpr const char *defaultToken = "123456";

	explicit ServerConfig(QString path);

	const QString &path() const { return filePath; }
	bool load();
	bool save() const;

	// access token
	bool checkToken(const QString &token) const;
	void setToken(const QString &token);
	bool tokenIsDefault() const { return isDefaultToken; }

	// browser sessions (in memory only)
	QString newSession();
	bool checkSession(const QString &session);
	void dropSession(const QString &session);

	// API keys
	QJsonObject addApiKey(const QString &name, const QString &key);
	bool deleteApiKey(const QString &id);
	bool checkApiKey(const QString &key);
	QJsonArray listApiKeys() const;

	// default contest folder
	const QString &contestRoot() const { return root; }
	void setContestRoot(const QString &dir);

  private:
	struct ApiKey {
		QString id, name, salt, hash, preview, created, lastUsed;
	};
	static QString hashed(const QString &salt, const QString &value);
	static QString randomHex(int bytes);
	static QJsonObject publicKey(const ApiKey &key);

	QString filePath;
	QString tokenSalt, tokenHash;
	bool isDefaultToken = true;
	QString root;
	QList<ApiKey> apiKeys;
	QHash<QString, QDateTime> sessions;
};
