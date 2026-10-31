/*
 * SPDX-FileCopyrightText: 2026 LemonServer contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#include "jsonapi.h"

#include "base/LemonType.hpp"
#include "base/compiler.h"
#include "base/settings.h"
#include "core/contest.h"
#include "core/contestant.h"
#include "core/task.h"
#include "core/testcase.h"

#include <QDir>

namespace LemonServerJson {

	QString toApiPath(QString path) { return path.replace('\\', '/'); }

	QString fromApiPath(QString path) {
		path.replace('\\', '/');
		return path.replace('/', QDir::separator());
	}

	static QJsonArray pathArray(const QStringList &list) {
		QJsonArray arr;
		for (const auto &s : list)
			arr.append(toApiPath(s));
		return arr;
	}

	static QStringList pathList(const QJsonValue &v) {
		QStringList list;
		for (const auto &x : v.toArray())
			list.append(fromApiPath(x.toString()));
		return list;
	}

	QJsonObject testCaseToJson(const TestCase *tc) {
		QJsonArray deps;
		for (int d : tc->getDependenceSubtask())
			deps.append(d);
		return {{"fullScore", tc->getFullScore()},
		        {"timeLimit", tc->getTimeLimit()},
		        {"memoryLimit", tc->getMemoryLimit()},
		        {"inputFiles", pathArray(tc->getInputFiles())},
		        {"outputFiles", pathArray(tc->getOutputFiles())},
		        {"dependenceSubtask", deps}};
	}

	QJsonObject taskToJson(const Task *task) {
		QJsonObject obj;
		obj["problemTitle"] = task->getProblemTitle();
		obj["sourceFileName"] = task->getSourceFileName();
		obj["inputFileName"] = task->getInputFileName();
		obj["outputFileName"] = task->getOutputFileName();
		obj["standardInputCheck"] = task->getStandardInputCheck();
		obj["standardOutputCheck"] = task->getStandardOutputCheck();
		obj["subFolderCheck"] = task->getSubFolderCheck();
		obj["taskType"] = int(task->getTaskType());
		obj["comparisonMode"] = int(task->getComparisonMode());
		obj["diffArguments"] = task->getDiffArguments();
		obj["realPrecision"] = task->getRealPrecision();
		obj["specialJudge"] = toApiPath(task->getSpecialJudge());
		obj["interactor"] = toApiPath(task->getInteractor());
		obj["interactorName"] = task->getInteractorName();
		obj["grader"] = toApiPath(task->getGrader());
		obj["sourceFilesPath"] = pathArray(task->getSourceFilesPath());
		obj["sourceFilesName"] = pathArray(task->getSourceFilesName());
		obj["graderFilesPath"] = pathArray(task->getGraderFilesPath());
		obj["graderFilesName"] = pathArray(task->getGraderFilesName());
		obj["answerFileExtension"] = task->getAnswerFileExtension();
		QJsonObject cdf;
		task->writeToJson(cdf);
		obj["compilerConfiguration"] = cdf["compilerConfiguration"];
		obj["totalScore"] = task->getTotalScore();
		obj["totalTimeLimit"] = task->getTotalTimeLimit();
		QJsonArray cases;
		for (const auto *tc : task->getTestCaseList())
			cases.append(testCaseToJson(tc));
		obj["testCases"] = cases;
		return obj;
	}

	bool applyTaskJson(Task *task, const QJsonObject &obj, Settings *settings, QString *error) {
		if (obj.contains("taskType")) {
			const int t = obj["taskType"].toInt();
			if (t < Task::Traditional || t > Task::CommunicationExec) {
				*error = "invalid taskType";
				return false;
			}
		}
		if (obj.contains("comparisonMode")) {
			const int m = obj["comparisonMode"].toInt();
			if (m < Task::LineByLineMode || m > Task::TestlibSpecialJudgeMode) {
				*error = "invalid comparisonMode";
				return false;
			}
		}
		if (obj.contains("testCases")) {
			const auto arr = obj["testCases"].toArray();
			for (int i = 0; i < arr.size(); i++) {
				const auto tc = arr[i].toObject();
				if (tc["inputFiles"].toArray().size() != tc["outputFiles"].toArray().size()) {
					*error = QString("test case #%1: inputFiles and outputFiles differ in length").arg(i + 1);
					return false;
				}
				for (const auto &d : tc["dependenceSubtask"].toArray()) {
					if (d.toInt() <= 0 || d.toInt() > i) {
						*error = QString("test case #%1: invalid dependence subtask %2").arg(i + 1).arg(d.toInt());
						return false;
					}
				}
			}
		}

		if (obj.contains("problemTitle"))
			task->setProblemTitle(obj["problemTitle"].toString());
		if (obj.contains("sourceFileName"))
			task->setSourceFileName(obj["sourceFileName"].toString());
		if (obj.contains("inputFileName"))
			task->setInputFileName(obj["inputFileName"].toString());
		if (obj.contains("outputFileName"))
			task->setOutputFileName(obj["outputFileName"].toString());
		if (obj.contains("standardInputCheck"))
			task->setStandardInputCheck(obj["standardInputCheck"].toBool());
		if (obj.contains("standardOutputCheck"))
			task->setStandardOutputCheck(obj["standardOutputCheck"].toBool());
		if (obj.contains("subFolderCheck"))
			task->setSubFolderCheck(obj["subFolderCheck"].toBool());
		if (obj.contains("taskType"))
			task->setTaskType(Task::TaskType(obj["taskType"].toInt()));
		if (obj.contains("comparisonMode"))
			task->setComparisonMode(Task::ComparisonMode(obj["comparisonMode"].toInt()));
		if (obj.contains("diffArguments"))
			task->setDiffArguments(obj["diffArguments"].toString());
		if (obj.contains("realPrecision"))
			task->setRealPrecision(qBound(0, obj["realPrecision"].toInt(), 18));
		if (obj.contains("specialJudge"))
			task->setSpecialJudge(fromApiPath(obj["specialJudge"].toString()));
		if (obj.contains("interactor"))
			task->setInteractor(fromApiPath(obj["interactor"].toString()));
		if (obj.contains("interactorName"))
			task->setInteractorName(obj["interactorName"].toString());
		if (obj.contains("grader"))
			task->setGrader(fromApiPath(obj["grader"].toString()));
		if (obj.contains("sourceFilesPath"))
			task->setSourceFilesPath(pathList(obj["sourceFilesPath"]));
		if (obj.contains("sourceFilesName"))
			task->setSourceFilesName(pathList(obj["sourceFilesName"]));
		if (obj.contains("graderFilesPath"))
			task->setGraderFilesPath(pathList(obj["graderFilesPath"]));
		if (obj.contains("graderFilesName"))
			task->setGraderFilesName(pathList(obj["graderFilesName"]));
		if (obj.contains("answerFileExtension"))
			task->setAnswerFileExtension(obj["answerFileExtension"].toString());
		if (obj.contains("compilerConfiguration")) {
			const auto conf = obj["compilerConfiguration"].toObject();
			for (auto it = conf.begin(); it != conf.end(); ++it)
				task->setCompilerConfiguration(it.key(), it.value().toString());
		}
		if (obj.contains("testCases")) {
			while (! task->getTestCaseList().isEmpty())
				task->deleteTestCase(0);
			for (const auto &v : obj["testCases"].toArray()) {
				const auto o = v.toObject();
				auto *tc = new TestCase;
				tc->setFullScore(qBound(0, o["fullScore"].toInt(settings->getDefaultFullScore()),
				                        Settings::upperBoundForFullScore()));
				tc->setTimeLimit(qBound(0, o["timeLimit"].toInt(settings->getDefaultTimeLimit()),
				                        Settings::upperBoundForTimeLimit()));
				tc->setMemoryLimit(qBound(0, o["memoryLimit"].toInt(settings->getDefaultMemoryLimit()),
				                          Settings::upperBoundForMemoryLimit()));
				const auto in = o["inputFiles"].toArray();
				const auto out = o["outputFiles"].toArray();
				for (int i = 0; i < in.size(); i++)
					tc->addSingleCase(fromApiPath(in[i].toString()), fromApiPath(out[i].toString()));
				QList<int> deps;
				for (const auto &d : o["dependenceSubtask"].toArray())
					if (! deps.contains(d.toInt()))
						deps.append(d.toInt());
				tc->setDependenceSubtask(deps);
				task->addTestCase(tc);
			}
		}
		task->refreshCompilerConfiguration(settings);
		return true;
	}

	QJsonObject contestantSummary(const Contest *contest, const Contestant *c) {
		QJsonArray tasks;
		const auto &taskList = contest->getTaskList();
		for (int i = 0; i < taskList.size(); i++) {
			tasks.append(QJsonObject{{"judged", c->getCheckJudged(i)},
			                         {"score", c->getTaskScore(i)},
			                         {"compileState", int(c->getCompileState(i))},
			                         {"sourceFile", c->getSourceFile(i)}});
		}
		const auto jt = c->getJudingTime();
		return {{"name", c->getContestantName()},
		        {"totalScore", c->getTotalScore()},
		        {"totalUsedTime", c->getTotalUsedTime()},
		        {"judgingTime", c->getTotalScore() >= 0 && jt.isValid() ? jt.toString("yyyy-MM-dd hh:mm:ss")
		                                                                 : QString()},
		        {"tasks", tasks}};
	}

	QJsonObject contestantTaskDetail(const Contestant *c, int i) {
		QJsonArray inputFiles, result, message, score, timeUsed, memoryUsed;
		for (const auto &row : c->getInputFiles(i))
			inputFiles.append(QJsonArray::fromStringList(row));
		for (const auto &row : c->getResult(i)) {
			QJsonArray r;
			for (auto x : row)
				r.append(int(x));
			result.append(r);
		}
		for (const auto &row : c->getMessage(i))
			message.append(QJsonArray::fromStringList(row));
		for (const auto &row : c->getScore(i)) {
			QJsonArray r;
			for (auto x : row)
				r.append(x);
			score.append(r);
		}
		for (const auto &row : c->getTimeUsed(i)) {
			QJsonArray r;
			for (auto x : row)
				r.append(x);
			timeUsed.append(r);
		}
		for (const auto &row : c->getMemoryUsed(i)) {
			QJsonArray r;
			for (auto x : row)
				r.append(double(x));
			memoryUsed.append(r);
		}
		return {{"judged", c->getCheckJudged(i)},
		        {"taskScore", c->getTaskScore(i)},
		        {"compileState", int(c->getCompileState(i))},
		        {"compileMessage", c->getCompileMessage(i)},
		        {"sourceFile", c->getSourceFile(i)},
		        {"inputFiles", inputFiles},
		        {"result", result},
		        {"message", message},
		        {"score", score},
		        {"timeUsed", timeUsed},
		        {"memoryUsed", memoryUsed}};
	}

	QJsonObject compilerToJson(const Compiler *c) {
		QJsonObject obj;
		c->write(obj);
		// Compiler::write() stores the environment under a mangled key; expose it properly.
		obj.remove("environment.toStringList()");
		obj["environment"] = QJsonArray::fromStringList(c->getEnvironment().toStringList());
		return obj;
	}

	Compiler *compilerFromJson(const QJsonObject &in, QString *error) {
		QJsonObject obj = in;
		const QString name = obj["compilerName"].toString().trimmed();
		if (name.isEmpty()) {
			*error = "compilerName is required";
			return nullptr;
		}
		obj["compilerName"] = name;
		for (const char *key : {"compilerLocation", "interpreterLocation"})
			if (! obj[key].isString())
				obj[key] = QString();
		for (const char *key : {"sourceExtensions", "bytecodeExtensions", "configurationNames",
		                        "compilerArguments", "interpreterArguments", "environment"})
			if (! obj[key].isArray())
				obj[key] = QJsonArray();
		if (! obj["timeLimitRatio"].isDouble())
			obj["timeLimitRatio"] = 1.0;
		if (! obj["memoryLimitRatio"].isDouble())
			obj["memoryLimitRatio"] = 1.0;
		if (! obj["disableMemoryLimitCheck"].isBool())
			obj["disableMemoryLimitCheck"] = false;
		if (! obj["interpreterAsWatcher"].isBool())
			obj["interpreterAsWatcher"] = false;

		auto names = obj["configurationNames"].toArray();
		auto cargs = obj["compilerArguments"].toArray();
		auto iargs = obj["interpreterArguments"].toArray();
		if (names.isEmpty()) {
			names.append("default");
		}
		while (cargs.size() < names.size())
			cargs.append(QString());
		while (iargs.size() < names.size())
			iargs.append(QString());
		obj["configurationNames"] = names;
		obj["compilerArguments"] = cargs;
		obj["interpreterArguments"] = iargs;

		auto *compiler = new Compiler;
		compiler->setTimeLimitRatio(1);
		compiler->setMemoryLimitRatio(1);
		compiler->setDisableMemoryLimitCheck(false);
		compiler->setInterpreterAsWatcher(false);
		if (compiler->read(obj) == -1) {
			delete compiler;
			*error = "invalid compiler definition";
			return nullptr;
		}
		return compiler;
	}

	QJsonObject settingsToJson(const Settings *s) {
		QJsonArray themes;
		for (const auto *t : s->getColorThemeList())
			themes.append(t->getName());
		QJsonObject theme;
		if (! s->getColorThemeList().isEmpty()) {
			const ColorTheme t = s->getCurrentColorTheme();
			auto hsl = [](const hslTuple &x) { return QJsonArray{x.h, x.s, x.l}; };
			auto ddd = [](const dddTuple &x) { return QJsonArray{x.h, x.s, x.l}; };
			theme = {{"mx", hsl(t.getMxColor())}, {"mi", hsl(t.getMiColor())},
			         {"nf", hsl(t.getNfColor())}, {"ce", hsl(t.getCeColor())},
			         {"grandComp", ddd(t.getGrandComp())}, {"grandRate", ddd(t.getGrandRate())}};
		}
		return {{"colorTheme", theme},{"defaultFullScore", s->getDefaultFullScore()},
		        {"defaultTimeLimit", s->getDefaultTimeLimit()},
		        {"defaultMemoryLimit", s->getDefaultMemoryLimit()},
		        {"compileTimeLimit", s->getCompileTimeLimit()},
		        {"specialJudgeTimeLimit", s->getSpecialJudgeTimeLimit()},
		        {"fileSizeLimit", s->getFileSizeLimit()},
		        {"rejudgeTimes", s->getRejudgeTimes()},
		        {"maxJudgingThreads", s->getMaxJudgingThreads()},
		        {"preventSleepWhileJudging", s->getPreventSleepWhileJudging()},
		        {"defaultExtraTimeRatio", s->getDefaultExtraTimeRatio()},
		        {"defaultInputFileExtension", s->getDefaultInputFileExtension()},
		        {"defaultOutputFileExtension", s->getDefaultOutputFileExtension()},
		        {"inputFileExtensions", QJsonArray::fromStringList(s->getInputFileExtensions())},
		        {"outputFileExtensions", QJsonArray::fromStringList(s->getOutputFileExtensions())},
		        {"uiLanguage", s->getUiLanguage()},
		        {"diffPath", s->getDiffPath()},
		        {"colorThemes", themes},
		        {"currentColorTheme", s->getCurrentColorThemeIndex()}};
	}

	static QString joinList(const QJsonValue &v) {
		if (v.isString())
			return v.toString();
		QStringList list;
		for (const auto &x : v.toArray())
			list.append(x.toString().trimmed());
		return list.join(";");
	}

	void applySettingsJson(Settings *s, const QJsonObject &o) {
		if (o.contains("defaultFullScore"))
			s->setDefaultFullScore(qBound(0, o["defaultFullScore"].toInt(), Settings::upperBoundForFullScore()));
		if (o.contains("defaultTimeLimit"))
			s->setDefaultTimeLimit(qBound(1, o["defaultTimeLimit"].toInt(), Settings::upperBoundForTimeLimit()));
		if (o.contains("defaultMemoryLimit"))
			s->setDefaultMemoryLimit(
			    qBound(1, o["defaultMemoryLimit"].toInt(), Settings::upperBoundForMemoryLimit()));
		if (o.contains("compileTimeLimit"))
			s->setCompileTimeLimit(qBound(1, o["compileTimeLimit"].toInt(), Settings::upperBoundForTimeLimit()));
		if (o.contains("specialJudgeTimeLimit"))
			s->setSpecialJudgeTimeLimit(
			    qBound(1, o["specialJudgeTimeLimit"].toInt(), Settings::upperBoundForTimeLimit()));
		if (o.contains("fileSizeLimit"))
			s->setFileSizeLimit(qBound(1, o["fileSizeLimit"].toInt(), Settings::upperBoundForFileSizeLimit()));
		if (o.contains("rejudgeTimes"))
			s->setRejudgeTimes(qBound(0, o["rejudgeTimes"].toInt(), Settings::upperBoundForRejudgeTimes()));
		if (o.contains("maxJudgingThreads"))
			s->setMaxJudgingThreads(qBound(1, o["maxJudgingThreads"].toInt(), 256));
		if (o.contains("preventSleepWhileJudging"))
			s->setPreventSleepWhileJudging(o["preventSleepWhileJudging"].toBool());
		if (o.contains("defaultExtraTimeRatio"))
			s->setDefaultExtraTimeRatio(qBound(0.0, o["defaultExtraTimeRatio"].toDouble(),
			                                   Settings::upperBoundForExtraTimeRatio()));
		if (o.contains("defaultInputFileExtension"))
			s->setDefaultInputFileExtension(o["defaultInputFileExtension"].toString().trimmed());
		if (o.contains("defaultOutputFileExtension"))
			s->setDefaultOutputFileExtension(o["defaultOutputFileExtension"].toString().trimmed());
		if (o.contains("inputFileExtensions"))
			s->setInputFileExtensions(joinList(o["inputFileExtensions"]));
		if (o.contains("outputFileExtensions"))
			s->setOutputFileExtensions(joinList(o["outputFileExtensions"]));
		if (o.contains("uiLanguage"))
			s->setUiLanguage(o["uiLanguage"].toString());
		if (o.contains("currentColorTheme"))
			s->setCurrentColorThemeIndex(o["currentColorTheme"].toInt());
	}

	QString resultStateName(int state) {
		QString text, fr, bg;
		Settings::setTextAndColor(ResultState(state), text, fr, bg);
		return text;
	}

	QString compileStateName(int state) {
		switch (CompileState(state)) {
			case CompileSuccessfully:
				return "CompileSuccessfully";
			case NoValidSourceFile:
				return "NoValidSourceFile";
			case CompileError:
				return "CompileError";
			case CompileTimeLimitExceeded:
				return "CompileTimeLimitExceeded";
			case InvalidCompiler:
				return "InvalidCompiler";
			case NoValidGraderFile:
				return "NoValidGraderFile";
		}
		return {};
	}

} // namespace LemonServerJson
