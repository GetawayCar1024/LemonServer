#pragma once
#include <QJsonObject>
#include <QString>

// Only accepts the already allowlisted public result model. Never reads source files or compiler logs.
QString publicResultsDocument(const QJsonObject &contest, const QString &format);
