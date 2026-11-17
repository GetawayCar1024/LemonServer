/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "durablefile.h"
#include <QDataStream>
#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QSaveFile>

namespace {
bool valid(const QByteArray &bytes) {
    QJsonParseError error;
    const auto document = QJsonDocument::fromJson(bytes, &error);
    if (error.error == QJsonParseError::NoError && document.isObject()) return true;
    QDataStream stream(bytes);
    quint32 magic = 0; quint16 checksum = 0; qint32 length = 0;
    stream >> magic >> checksum >> length;
    if (magic != 0x20111127 || length < 0 || length != bytes.size() - stream.device()->pos()) return false;
    const auto packed = bytes.mid(stream.device()->pos(), length);
    return qChecksum(QByteArrayView(packed)) == checksum && !qUncompress(packed).isEmpty();
}
bool atomicWrite(const QString &path, const QByteArray &bytes, QString *error) {
    QSaveFile file(path);
    file.setDirectWriteFallback(false);
    if (file.open(QIODevice::WriteOnly) && file.write(bytes) == bytes.size() && file.commit()) return true;
    if (error) *error = QString("Cannot durably write %1: %2").arg(QFileInfo(path).fileName(), file.errorString());
    return false;
}
}

bool LemonPersistence::read(const QString &path, QByteArray *bytes, bool *recovered, QString *error) {
    if (recovered) *recovered = false;
    for (const auto &candidate : {path, path + ".bak"}) {
        QFile file(candidate);
        if (!file.open(QIODevice::ReadOnly)) continue;
        const auto content = file.readAll();
        if (!valid(content)) continue;
        *bytes = content;
        if (candidate != path) {
            if (recovered) *recovered = true;
            QFile broken(path);
            if (broken.open(QIODevice::ReadOnly)) {
                const auto suffix = QCryptographicHash::hash(broken.readAll(), QCryptographicHash::Sha256).toHex().left(16);
                const auto evidence = path + ".corrupt-" + QString::fromLatin1(suffix);
                if (!QFileInfo::exists(evidence)) QFile::copy(path, evidence);
            }
        }
        return true;
    }
    if (error) *error = QString("Cannot read valid data or backup for %1").arg(QFileInfo(path).fileName());
    return false;
}

bool LemonPersistence::write(const QString &path, const QByteArray &bytes, QString *error) {
    if (!valid(bytes)) { if (error) *error = "Refusing to save invalid data"; return false; }
    QFile previous(path);
    if (previous.open(QIODevice::ReadOnly)) {
        const auto content = previous.readAll(); previous.close();
        if (valid(content) && !atomicWrite(path + ".bak", content, error)) return false;
    }
    return atomicWrite(path, bytes, error);
}
