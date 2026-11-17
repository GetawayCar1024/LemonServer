#pragma once
#include <QByteArray>
#include <QString>

namespace LemonPersistence {
bool read(const QString &path, QByteArray *bytes, bool *recovered = nullptr, QString *error = nullptr);
bool write(const QString &path, const QByteArray &bytes, QString *error = nullptr);
}
