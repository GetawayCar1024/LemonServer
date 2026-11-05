// Run the same task through the current engine or the pinned LemonLime engine sources.
#include "base/LemonLog.hpp"
#include "base/compiler.h"
#include "base/settings.h"
#include "core/casejudger.h"
#include "core/contestant.h"
#include "core/task.h"
#include "core/taskjudger.h"
#include "spdlog/sinks/null_sink.h"
#include <QCoreApplication>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPromise>
#include <QStandardPaths>
#include <cstdio>

#ifdef LEMON_REFERENCE_ENGINE
// API-only additions used by the server's Contest class. The reference judge still uses its
// original relative paths; both processes are started in the same isolated fixture directory.
void TaskJudger::setPaths(QString data, QString source) { dataDir = std::move(data); sourceDir = std::move(source); }
void CaseJudger::setDataPath(const QString &path) { dataDir = path; }
#endif

template<class T> static QJsonArray rows(const QList<QList<T>> &values) {
	QJsonArray out;
	for (const auto &row : values) {
		QJsonArray list;
		for (const auto &value : row) list.append(int(value));
		out.append(list);
	}
	return out;
}

int main(int argc, char **argv) {
	QCoreApplication app(argc, argv);
	Lemon::base::logger = std::make_shared<spdlog::logger>("compat", std::make_shared<spdlog::sinks::null_sink_mt>());
	if (argc != 2) return 2;
	QFile input(QString::fromLocal8Bit(argv[1]));
	if (!input.open(QFile::ReadOnly)) return 3;
	const auto document = QJsonDocument::fromJson(input.readAll()).object();
	Settings::setSettingsFile("settings.ini");
	Settings settings;
	settings.loadSettings();
	settings.setCompileTimeLimit(20000);
	settings.setSpecialJudgeTimeLimit(3000);
	settings.setDefaultExtraTimeRatio(0.2);
	settings.setRejudgeTimes(0);
	settings.setFileSizeLimit(64);
	Compiler cpp;
	cpp.setCompilerName("g++"); cpp.setSourceExtensions("cpp");
	cpp.setCompilerLocation(QStandardPaths::findExecutable("g++"));
	cpp.addConfiguration("default", "%s.* -o %s -O2 -std=c++17", "");
	settings.addCompiler(&cpp);
	Compiler python;
	python.setCompilerName("python"); python.setCompilerType(Compiler::InterpretiveWithoutByteCode);
	python.setSourceExtensions("py");
	const QString testPython = qEnvironmentVariable("LEMON_COMPAT_PYTHON");
	python.setInterpreterLocation(testPython.isEmpty() ? QStandardPaths::findExecutable("python") : testPython);
	python.addConfiguration("default", "", "%s.py"); settings.addCompiler(&python);
	Task task;
	QJsonObject value; task.writeToJson(value);
	for (auto it = document.begin(); it != document.end(); ++it) value[it.key()] = it.value();
	task.readFromJson(value); task.refreshCompilerConfiguration(&settings);
	TaskJudger judge;
	judge.setSettings(&settings); judge.setTask(&task); judge.setContestantName("alice");
	QPromise<TaskResult> promise; promise.start();
	const auto result = judge.judgeIt(promise); promise.finish();
	Contestant contestant; contestant.addTask(); contestant.applyResult(0, result);
	const QJsonObject output{{"judged", result.judged}, {"compileState", int(result.compileState)},
	                         {"result", rows(result.result)}, {"score", rows(result.score)},
	                         {"total", contestant.getTaskScore(0)}};
	const auto bytes = QJsonDocument(output).toJson(QJsonDocument::Compact);
	fwrite(bytes.constData(), 1, size_t(bytes.size()), stdout); putchar('\n');
	return 0;
}
