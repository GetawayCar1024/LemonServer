/*
 * SPDX-FileCopyrightText: 2026 LemonServer contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#include "serverconfig.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QRandomGenerator>
#include <QSaveFile>

ServerConfig::ServerConfig(QString path) : filePath(std::move(path)) {}

QString ServerConfig::hashed(const QString &salt, const QString &value) {
	return QString::fromLatin1(
	    QCryptographicHash::hash((salt + value).toUtf8(), QCryptographicHash::Sha256).toHex());
}

QString ServerConfig::randomHex(int bytes) {
	QByteArray data(bytes, Qt::Uninitialized);
	for (auto &c : data)
		c = static_cast<char>(QRandomGenerator::system()->bounded(256));
	return QString::fromLatin1(data.toHex());
}

bool ServerConfig::load() {
	QFile file(filePath);
	if (! file.exists()) {
		setToken(defaultToken);
		return save();
	}
	if (! file.open(QFile::ReadOnly))
		return false;
	const auto obj = QJsonDocument::fromJson(file.readAll()).object();
	tokenSalt = obj.value("tokenSalt").toString();
	tokenHash = obj.value("tokenHash").toString();
	isDefaultToken = obj.value("tokenIsDefault").toBool(false);
	root = obj.value("contestRoot").toString();
	apiKeys.clear();
	for (const auto &v : obj.value("apiKeys").toArray()) {
		const auto k = v.toObject();
		apiKeys.append({k.value("id").toString(), k.value("name").toString(), k.value("salt").toString(),
		                k.value("hash").toString(), k.value("preview").toString(),
		                k.value("created").toString(), k.value("lastUsed").toString()});
	}
	if (tokenHash.isEmpty()) {
		setToken(defaultToken);
		save();
	}
	return true;
}

bool ServerConfig::save() const {
	QJsonObject obj;
	obj["tokenSalt"] = tokenSalt;
	obj["tokenHash"] = tokenHash;
	obj["tokenIsDefault"] = isDefaultToken;
	obj["contestRoot"] = root;
	QJsonArray keys;
	for (const auto &k : apiKeys) {
		keys.append(QJsonObject{{"id", k.id},
		                        {"name", k.name},
		                        {"salt", k.salt},
		                        {"hash", k.hash},
		                        {"preview", k.preview},
		                        {"created", k.created},
		                        {"lastUsed", k.lastUsed}});
	}
	obj["apiKeys"] = keys;
	QDir().mkpath(QFileInfo(filePath).absolutePath());
	QSaveFile file(filePath);
	if (! file.open(QFile::WriteOnly))
		return false;
	file.write(QJsonDocument(obj).toJson());
	return file.commit();
}

bool ServerConfig::checkToken(const QString &token) const {
	return ! tokenHash.isEmpty() && hashed(tokenSalt, token) == tokenHash;
}

void ServerConfig::setToken(const QString &token) {
	tokenSalt = randomHex(16);
	tokenHash = hashed(tokenSalt, token);
	isDefaultToken = token == QLatin1String(defaultToken);
	sessions.clear();
}

QString ServerConfig::newSession() {
	const auto now = QDateTime::currentDateTimeUtc();
	for (auto it = sessions.begin(); it != sessions.end();) {
		if (it.value() < now)
			it = sessions.erase(it);
		else
			++it;
	}
	const QString s = randomHex(32);
	sessions.insert(s, now.addDays(7));
	return s;
}

bool ServerConfig::checkSession(const QString &session) {
	auto it = sessions.find(session);
	if (it == sessions.end())
		return false;
	if (it.value() < QDateTime::currentDateTimeUtc()) {
		sessions.erase(it);
		return false;
	}
	return true;
}

void ServerConfig::dropSession(const QString &session) { sessions.remove(session); }

QJsonObject ServerConfig::publicKey(const ApiKey &key) {
	return {{"id", key.id},
	        {"name", key.name},
	        {"preview", key.preview},
	        {"created", key.created},
	        {"lastUsed", key.lastUsed}};
}

QJsonObject ServerConfig::addApiKey(const QString &name, const QString &value) {
	ApiKey k;
	k.id = randomHex(6);
	k.name = name.isEmpty() ? QStringLiteral("api-key") : name;
	k.salt = randomHex(8);
	k.hash = hashed(k.salt, value);
	k.preview = value.size() > 10 ? value.left(4) + "…" + value.right(4) : value.left(2) + "…";
	k.created = QDateTime::currentDateTime().toString("yyyy-MM-dd hh:mm:ss");
	apiKeys.append(k);
	save();
	return publicKey(k);
}

bool ServerConfig::deleteApiKey(const QString &id) {
	const auto removed = apiKeys.removeIf([&](const ApiKey &k) { return k.id == id; });
	save();
	return removed > 0;
}

bool ServerConfig::checkApiKey(const QString &key) {
	if (key.isEmpty())
		return false;
	for (auto &k : apiKeys) {
		if (hashed(k.salt, key) == k.hash) {
			k.lastUsed = QDateTime::currentDateTime().toString("yyyy-MM-dd hh:mm:ss");
			return true;
		}
	}
	return false;
}

QJsonArray ServerConfig::listApiKeys() const {
	QJsonArray arr;
	for (const auto &k : apiKeys)
		arr.append(publicKey(k));
	return arr;
}

void ServerConfig::setContestRoot(const QString &dir) {
	root = QDir::cleanPath(QDir(dir).absolutePath());
	save();
}
