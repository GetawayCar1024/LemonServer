/*
 * SPDX-FileCopyrightText: 2026 LemonServer contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>

class Compiler;
class Contest;
class Contestant;
class Settings;
class Task;
class TestCase;

// Conversions between LemonLime's core objects and the JSON used by the REST API.
// Paths are always exposed with '/' separators and converted back to native separators on input.
namespace LemonServerJson {
	QString toApiPath(QString path);
	QString fromApiPath(QString path);

	QJsonObject testCaseToJson(const TestCase *);
	QJsonObject taskToJson(const Task *);
	// Update the task with the fields present in obj. Returns false (with message) on invalid data.
	bool applyTaskJson(Task *, const QJsonObject &obj, Settings *, QString *error);

	QJsonObject contestantSummary(const Contest *, const Contestant *);
	QJsonObject contestantTaskDetail(const Contestant *, int taskIndex);

	QJsonObject compilerToJson(const Compiler *);
	Compiler *compilerFromJson(const QJsonObject &obj, QString *error);

	QJsonObject settingsToJson(const Settings *);
	void applySettingsJson(Settings *, const QJsonObject &obj);

	QString resultStateName(int state);
	QString compileStateName(int state);
} // namespace LemonServerJson
