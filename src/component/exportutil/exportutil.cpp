/*
 * SPDX-FileCopyrightText: 2011-2018 Project Lemon, Zhipeng Jia
 * SPDX-FileCopyrightText: 2018-2019 Project LemonPlus, Dust1404
 * SPDX-FileCopyrightText: 2019-2022 Project LemonLime
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#include "exportutil.h"
//
#include "base/LemonType.hpp"
#include "base/settings.h"
#include "core/contest.h"
#include "core/contestant.h"
#include "core/subtaskdependencelib.h"
#include "core/task.h"
#include "core/testcase.h"

#include <QFile>
#include <QFileInfo>
#include <QTextStream>
#include <algorithm>
#include <cmath>
#include <iostream>
#include <ranges>

ExportUtil::ExportUtil(QObject *parent) : QObject(parent) {}

const auto resultStateMap = []() {
	QMap<ResultState, std::tuple<QString, QString, QString>> resMap;
	for (int i = static_cast<int>(CorrectAnswer); i != static_cast<int>(LastResultState); i++) {
		QString text, frColor, bgColor;
		Settings::setTextAndColor(static_cast<ResultState>(i), text, frColor, bgColor);
		resMap[static_cast<ResultState>(i)] = {text, frColor, bgColor};
	}
	return resMap;
}();
auto ExportUtil::getContestantHtmlCode(Contest *contest, Contestant *contestant, int num) -> QString {
	QString htmlCode;
	QList<Task *> taskList = contest->getTaskList();

	for (int i = 0; i < taskList.size(); i++) {
		htmlCode += QString(R"(<div id="c%1p%2"><p><span>)").arg(num).arg(i);
		htmlCode += QString("%1 %2</span><br>").arg(tr("Task")).arg(taskList[i]->getProblemTitle());

		if (! contestant->getCheckJudged(i)) {
			htmlCode += QString("&nbsp;&nbsp;%1</p></div>").arg(tr("Not judged"));
			continue;
		}

		if (taskList[i]->getTaskType() == Task::Traditional ||
		    taskList[i]->getTaskType() == Task::Interaction ||
		    taskList[i]->getTaskType() == Task::Communication ||
		    taskList[i]->getTaskType() == Task::CommunicationExec) {
			if (contestant->getCompileState(i) != CompileSuccessfully) {
				switch (contestant->getCompileState(i)) {
					case NoValidGraderFile:
						htmlCode += QString("&nbsp;&nbsp;%1</p></div>")
						                .arg(tr("Main grader (grader.*) cannot be found"));
						break;

					case NoValidSourceFile:
						htmlCode +=
						    QString("&nbsp;&nbsp;%1</p></div>").arg(tr("Cannot find valid source file"));
						break;

					case CompileTimeLimitExceeded:
						htmlCode += QString("&nbsp;&nbsp;%1%2<br>")
						                .arg(tr("Source file: "))
						                .arg(contestant->getSourceFile(i));
						htmlCode +=
						    QString("&nbsp;&nbsp;%1</p></div>").arg(tr("Compile time limit exceeded"));
						break;

					case InvalidCompiler:
						htmlCode += QString("&nbsp;&nbsp;%1</p></div>").arg(tr("Cannot run given compiler"));
						break;

					case CompileError:
						htmlCode += QString("&nbsp;&nbsp;%1%2<br>")
						                .arg(tr("Source file: "))
						                .arg(contestant->getSourceFile(i));
						htmlCode += QString("&nbsp;&nbsp;%1").arg(tr("Compile error"));

						if (! contestant->getCompileMessage(i).isEmpty()) {
							QString compileMessage = contestant->getCompileMessage(i);
							compileMessage.replace("\r\n", "<br>");
							compileMessage.replace("\n", "<br>");
							compileMessage.replace("\r", "<br>");

							if (compileMessage.endsWith("<br>"))
								compileMessage.chop(4);

							htmlCode += R"(<table border="1"  cellpadding="1">)";
							htmlCode += "<tr><td style=\"padding: 0.5em; text-align: left;\"><code>";
							htmlCode += compileMessage;
							htmlCode += "</code></td></tr></table>";
						}

						htmlCode += "</p></div>";
						break;

					default:
						break;
				}

				continue;
			}

			htmlCode +=
			    QString("&nbsp;&nbsp;%1%2").arg(tr("Source file: ")).arg(contestant->getSourceFile(i));
		}

		htmlCode += "<table><tr>";
		htmlCode += QString(R"(<th>%1</th>)").arg(tr("Test Case"));
		htmlCode += QString(R"(<th>%1</th>)").arg(tr("Input File"));
		htmlCode += QString(R"(<th>%1</th>)").arg(tr("Result"));
		htmlCode += QString(R"(<th>%1</th>)").arg(tr("Time Used"));
		htmlCode += QString(R"(<th>%1</th>)").arg(tr("Memory Used"));
		htmlCode += QString(R"(<th>%1</th></tr>)").arg(tr("Score"));
		QList<TestCase *> testCases = taskList[i]->getTestCaseList();
		QList<QStringList> inputFiles = contestant->getInputFiles(i);
		QList<QList<ResultState>> result = contestant->getResult(i);
		QList<QStringList> message = contestant->getMessage(i);
		QList<QList<int>> timeUsed = contestant->getTimeUsed(i);
		QList<QList<qint64>> memoryUsed = contestant->getMemoryUsed(i);
		QList<QList<int>> score = contestant->getScore(i);

		for (int j = 0; j < inputFiles.size(); j++) {
			for (int k = 0; k < inputFiles[j].size(); k++) {
				htmlCode += "<tr>";

				if (k == 0) {
					if (score[j].size() == inputFiles[j].size())
						htmlCode +=
						    QString(R"(<td rowspan="%1">#%2</td>)").arg(inputFiles[j].size()).arg(j + 1);
					else
						htmlCode += QString(R"(<td rowspan="%1">#%2<br>%3:%4</td>)")
						                .arg(inputFiles[j].size())
						                .arg(j + 1)
						                .arg(tr("Subtask Dependence Status"))
						                .arg(statusRankingText(score[j].back()));
				}

				htmlCode += QString("<td>%1</td>").arg(inputFiles[j][k]);
				QString text, bgColor, frColor;
				Settings::setTextAndColor(result[j][k], text, frColor, bgColor);
				htmlCode +=
				    QString("<td class=\"result%2\">%1").arg(text).arg(static_cast<int>(result[j][k]));

				if (! message[j][k].isEmpty()) {
					QString tmp = message[j][k];
					tmp.replace("\n", "\\n");
					tmp.replace("\"", "\\&quot;");
					htmlCode += QString("<a href=\"javascript:alert(&quot;%1&quot;)\"> (...)").arg(tmp);
				}

				htmlCode += "</td>";
				htmlCode += "<td>";

				if (timeUsed[j][k] != -1) {
					htmlCode += QString("").asprintf("%.3lf s", double(timeUsed[j][k]) / 1000);
				} else {
					htmlCode += tr("Invalid");
				}

				htmlCode += "</td>";
				htmlCode += "<td>";

				if (memoryUsed[j][k] != -1) {
					htmlCode += QString("").asprintf("%.3lf MiB", double(memoryUsed[j][k]) / 1024 / 1024);
				} else {
					htmlCode += tr("Invalid");
				}

				htmlCode += "</td>";

				if (k == 0) {
					const int minv = std::ranges::min(score[j] | std::views::take(inputFiles[j].size()));
					int maxv = testCases[j]->getFullScore();

					QString bgClass = "zero-score";

					if (minv >= maxv)
						bgClass = "full-score";
					else if (minv > 0)
						bgClass = "partial-score";

					htmlCode += QString(R"(<td rowspan="%1" class="%2"><span class="c">%3</span> / %4</td>)")
					                .arg(inputFiles[j].size())
					                .arg(bgClass)
					                .arg(minv)
					                .arg(maxv);
				}

				htmlCode += "</tr>";
			}
		}

		htmlCode += "</table><br></p></div>";
	}

	htmlCode += QString("<p><a href=\"#top\">%1</a></p>").arg(tr("Return to top"));
	return htmlCode;
}
/*
 * Generate the HTML code for the summary page
 * Might be difficult to maintain
 * Use Javascript to shrink the filesize
 */
auto ExportUtil::generateHtml(Contest *contest) -> QString {
	Settings settings;
	contest->copySettings(settings);
	ColorTheme colors = settings.getCurrentColorTheme();

	QString buffer;
	QTextStream out(&buffer);
	QList<Contestant *> contestantList = contest->getContestantList();
	QList<Task *> taskList = contest->getTaskList();
	out << "<html><head>";
	out << R"(<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />)";

	// Style sheet
	out << "<style type=\"text/css\">"
	       "th, td {padding-left: 1em; padding-right: 1em; white-space: nowrap; "
	       "text-align: center; verticle-align: middle;}"
	       ".td-0 {border-style: none solid solid none; border-width: 1px 3px; border-color: #ccc;}"
	       ".th-0 {border-style: none solid solid none; border-width: 3px 3px; border-color: #000;}"
	       ".th-1 {border-style: none solid solid none; border-width: 3px 2px; border-color: #000;}"
	       ".a-0 {color: black; text-decoration: none;} .c {font-weight: bold; font-size: large;}"
	       ".td-2 {border-radius: 5px; font-weight: bold;}"
	       ".td-3 {border-radius: 5px;}"
	       ".full-score {background: rgb(192, 255, 192)}"
	       ".partial-score {background: rgb(192, 255, 255)}"
	       ".zero-score {background: rgb(255, 192, 192)}";
	for (auto [k, v] : resultStateMap.toStdMap()) {
		out << ".result" << static_cast<int>(k);
		out << QString(" {color: %1;background: %2;}").arg(std::get<1>(v)).arg(std::get<2>(v));
	}
	out << "</style>";

	out << "<title>" << contest->getContestTitle() << " : " << tr("Contest Result") << "</title>";
	out << "</head><body>";
	QList<std::pair<int, QString>> sortList;

	for (auto &i : contestantList) {
		int totalScore = i->getTotalScore();

		if (totalScore != -1) {
			sortList.append(std::make_pair(-totalScore, i->getContestantName()));
		} else {
			sortList.append(std::make_pair(1, i->getContestantName()));
		}
	}

	std::sort(sortList.begin(), sortList.end());
	QMap<QString, int> rankList;

	for (int i = 0; i < sortList.size(); i++) {
		if (i > 0 && sortList[i].first == sortList[i - 1].first) {
			rankList.insert(sortList[i].second, rankList[sortList[i - 1].second]);
		} else {
			rankList.insert(sortList[i].second, i);
		}
	}

	QHash<Contestant *, int> loc;

	for (int i = 0; i < contestantList.size(); i++) {
		loc.insert(contestantList[i], i);
	}

	out << "<p><span class=\"d\">";
	out << "<a name=\"top\"></a>" << contest->getContestTitle() << " : " << tr("Rank List") << "</span></p>";
	out << "<p>" << tr("Click names or task scores to jump to details. Judged By LemonLime") << "</p>";
	out << R"(<p><table cellpadding="1" style="border-style: solid;"><tr>)";
	out << QString(R"(<th class="th-0" scope="col">%1</th>)").arg(tr("Rank"));
	out << QString(R"(<th class="th-0" scope="col">%1</th>)").arg(tr("Name"));
	out << QString(R"(<th class="th-1" scope="col">%1</th>)").arg(tr("Total Score"));

	for (auto &i : taskList)
		out << QString(R"(<th class="th-1" scope="col">%1</th>)").arg(i->getProblemTitle());

	out << "</tr>";
	QList<int> fullScore;
	int sfullScore = contest->getTotalScore();

	for (auto &i : taskList) {
		fullScore.append(i->getTotalScore());
	}

	for (auto &i : sortList) {
		Contestant *contestant = contest->getContestant(i.second);
		out << "<tr>";
		out << QString("<td class=\"td-0\">%1</td>").arg(rankList[contestant->getContestantName()] + 1);
		out << QString(R"(<td class="td-0"><a href="#c%1" class="a-0">%2</a></td>)")
		           .arg(loc[contestant])
		           .arg(i.second);
		int allScore = contestant->getTotalScore();

		if (allScore >= 0) {
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
			float h = NAN;
			float s = NAN;
			float l = NAN;
#else
			double h = NAN;
			double s = NAN;
			double l = NAN;
#endif
			colors.getColorGrand(allScore, sfullScore).getHslF(&h, &s, &l);
			h *= 360, s *= 100, l *= 100;
			out << QString("<td class=\"td-2\" style=\"background: hsl(%2,%3%,%4%); border: 2px solid "
			               "hsl(%2,%3%,%5%);\">%1</td>")
			           .arg(allScore)
			           .arg(h)
			           .arg(s)
			           .arg(l)
			           .arg(qMax(l - 20, 0.00));
		} else {
			out << QString("<td class=\"td-2\">%1</td>").arg(tr("Invalid"));
		}

		for (int j = 0; j < taskList.size(); j++) {
			int score = contestant->getTaskScore(j);

			if (score != -1) {
#if QT_VERSION >= QT_VERSION_CHECK(6, 0, 0)
				float h = NAN;
				float s = NAN;
				float l = NAN;
#else
				double h = NAN;
				double s = NAN;
				double l = NAN;
#endif
				QColor col = colors.getColorPer(score, fullScore[j]);
				col.getHslF(&h, &s, &l);

				if (taskList[j]->getTaskType() != Task::AnswersOnly &&
				    contestant->getCompileState(j) != CompileSuccessfully) {
					if (contestant->getCompileState(j) == NoValidSourceFile) {
						colors.getColorNf().getHslF(&h, &s, &l);
					} else {
						colors.getColorCe().getHslF(&h, &s, &l);
					}
				}

				h *= 360, s *= 100, l *= 100;
				out << QString(
				           R"(<td class="td-3" style="background: hsl(%2,%3%,%4%);"><a href="#c%5p%6" class="a-0">%1</a></td>)")
				           .arg(score)
				           .arg(h)
				           .arg(s)
				           .arg(l)
				           .arg(loc[contestant])
				           .arg(j);
			} else {
				out << QString(R"(<td class="td-3"><a href="#c%2p%3" class="a-0">%1</a></td>)")
				           .arg(tr("Invalid"))
				           .arg(loc[contestant])
				           .arg(j);
			}
		}
		out << "</tr>";
	}

	out << "</table></p>";

	for (int i = 0; i < contestantList.size(); i++) {
		out << QString("<a name=\"c%1\"><hr></a>").arg(i) << "<span class=\"d\">";
		out << tr("Contestant: %1").arg(contestantList[i]->getContestantName()) << "</span>";
		out << getContestantHtmlCode(contest, contestantList[i], i);
	}

	out << QString(R"(<footer><p><i>Lemonlime Version %1:%2</i></p></footer>)")
	           .arg(LEMON_VERSION_STRING)
	           .arg(LEMON_VERSION_BUILD);

	out << R"(
	<script>
		document.querySelectorAll("div[id^='c'] th").forEach(e=>e.classList.add("td-0"));
		document.querySelectorAll("div[id^='c'] td").forEach(e=>e.classList.add("td-0"));
		document.querySelectorAll("div[id^='c']>p>span").forEach(e=>{e.style.fontWeight="bold";e.style.fontSize="large";});
		document.querySelectorAll("div[id^='c']>p>table").forEach(e=>e.style.border="solid");
		document.querySelectorAll("div[id^='c']>p>table th").forEach(e=>e.setAttribute("scope","col"));
	</script>
	)";
	out << "</body>";
	out << "</html>";
	out.flush();
	return buffer;
}

auto ExportUtil::getSmallerContestantHtmlCode(Contest *contest, Contestant *contestant) -> QString {
	QString htmlCode;
	QList<Task *> taskList = contest->getTaskList();

	for (int i = 0; i < taskList.size(); i++) {
		htmlCode += "<p><span style=\"font-weight:bold; font-size:large;\">";
		htmlCode += QString("%1 %2</span><br>").arg(tr("Task")).arg(taskList[i]->getProblemTitle());

		if (! contestant->getCheckJudged(i)) {
			htmlCode += QString("&nbsp;&nbsp;%1</p>").arg(tr("Not judged"));
			continue;
		}

		if (taskList[i]->getTaskType() == Task::Traditional ||
		    taskList[i]->getTaskType() == Task::Interaction ||
		    taskList[i]->getTaskType() == Task::Communication ||
		    taskList[i]->getTaskType() == Task::CommunicationExec) {
			if (contestant->getCompileState(i) != CompileSuccessfully) {
				switch (contestant->getCompileState(i)) {
					case NoValidGraderFile:
						htmlCode += QString("&nbsp;&nbsp;%1</p></a>")
						                .arg(tr("Main grader (grader.*) cannot be found"));
						break;

					case NoValidSourceFile:
						htmlCode += QString("&nbsp;&nbsp;%1</p>").arg(tr("Cannot find valid source file"));
						break;

					case CompileTimeLimitExceeded:
						htmlCode += QString("&nbsp;&nbsp;%1%2<br>")
						                .arg(tr("Source file: "))
						                .arg(contestant->getSourceFile(i));
						htmlCode += QString("&nbsp;&nbsp;%1</p>").arg(tr("Compile time limit exceeded"));
						break;

					case InvalidCompiler:
						htmlCode += QString("&nbsp;&nbsp;%1</p>").arg(tr("Cannot run given compiler"));
						break;

					case CompileError:
						htmlCode += QString("&nbsp;&nbsp;%1%2<br>")
						                .arg(tr("Source file: "))
						                .arg(contestant->getSourceFile(i));
						htmlCode += QString("&nbsp;&nbsp;%1").arg(tr("Compile error"));

						if (! contestant->getCompileMessage(i).isEmpty()) {
							QString compileMessage = contestant->getCompileMessage(i);
							compileMessage.replace("\r\n", "<br>");
							compileMessage.replace("\n", "<br>");
							compileMessage.replace("\r", "<br>");

							if (compileMessage.endsWith("<br>"))
								compileMessage.chop(4);

							htmlCode += R"(<table border="1" cellpadding="1">)";
							htmlCode += "<tr><td style=\"padding: 0.5em; text-align: left;\"><code>";
							htmlCode += compileMessage;
							htmlCode += "</code></td></tr></table>";
						}

						htmlCode += "</p>";
						break;

					default:
						break;
				}

				continue;
			}

			htmlCode +=
			    QString("&nbsp;&nbsp;%1%2").arg(tr("Source file: ")).arg(contestant->getSourceFile(i));
		}

		htmlCode += R"(<table border="1"  cellpadding="1"><tr>)";
		htmlCode += QString("<th scope=\"col\">%1</th>").arg(tr("Test Case"));
		htmlCode += QString("<th scope=\"col\">%1</th>").arg(tr("Input File"));
		htmlCode += QString("<th scope=\"col\">%1</th>").arg(tr("Result"));
		htmlCode += QString("<th scope=\"col\">%1</th>").arg(tr("Time Used"));
		htmlCode += QString("<th scope=\"col\">%1</th>").arg(tr("Memory Used"));
		htmlCode += QString("<th scope=\"col\">%1</th></tr>").arg(tr("Score"));
		QList<TestCase *> testCases = taskList[i]->getTestCaseList();
		QList<QStringList> inputFiles = contestant->getInputFiles(i);
		QList<QList<ResultState>> result = contestant->getResult(i);
		QList<QStringList> message = contestant->getMessage(i);
		QList<QList<int>> timeUsed = contestant->getTimeUsed(i);
		QList<QList<qint64>> memoryUsed = contestant->getMemoryUsed(i);
		QList<QList<int>> score = contestant->getScore(i);

		for (int j = 0; j < inputFiles.size(); j++) {
			for (int k = 0; k < inputFiles[j].size(); k++) {
				htmlCode += "<tr>";

				if (k == 0) {
					if (score[j].size() == inputFiles[j].size())
						htmlCode +=
						    QString("<td rowspan=\"%1\">#%2</td>").arg(inputFiles[j].size()).arg(j + 1);
					else
						htmlCode += QString("<td rowspan=\"%1\">#%2<br>%3:%4</td>")
						                .arg(inputFiles[j].size())
						                .arg(j + 1)
						                .arg(tr("Subtask Dependence Status"))
						                .arg(statusRankingText(score[j].back()));
				}

				htmlCode += QString("<td>%1</td>").arg(inputFiles[j][k]);
				QString text;
				QString bgColor;
				QString frColor;
				Settings::setTextAndColor(result[j][k], text, frColor, bgColor);
				htmlCode += QString("<td>%1").arg(text);

				if (! message[j][k].isEmpty()) {
					QString tmp = message[j][k];
					tmp.replace("\n", "\\n");
					tmp.replace("\"", "\\&quot;");
					htmlCode += QString("<a href=\"javascript:alert(&quot;%1&quot;)\"> (...)").arg(tmp);
				}

				htmlCode += "</td>";
				htmlCode += "<td>";

				if (timeUsed[j][k] != -1) {
					htmlCode += QString("").asprintf("%.3lf s", double(timeUsed[j][k]) / 1000);
				} else {
					htmlCode += tr("Invalid");
				}

				htmlCode += "</td>";
				htmlCode += "<td>";

				if (memoryUsed[j][k] != -1) {
					htmlCode += QString("").asprintf("%.3lf MiB", double(memoryUsed[j][k]) / 1024 / 1024);
				} else {
					htmlCode += tr("Invalid");
				}

				htmlCode += "</td>";

				if (k == 0) {
					const int minv = std::ranges::min(score[j] | std::views::take(inputFiles[j].size()));
					int maxv = testCases[j]->getFullScore();

					htmlCode += QString(R"(<td rowspan="%1"><span class="c">%2</span> / %3</td>)")
					                .arg(inputFiles[j].size())
					                .arg(minv)
					                .arg(maxv);
				}

				htmlCode += "</tr>";
			}
		}

		htmlCode += "</table><br></p>";
	}

	htmlCode += QString("<p><a href=\"#top\">%1</a></p>").arg(tr("Return to top"));
	return htmlCode;
}

auto ExportUtil::generateSmallerHtml(Contest *contest) -> QString {
	QString buffer;
	QTextStream out(&buffer);
	QList<Contestant *> contestantList = contest->getContestantList();
	QList<Task *> taskList = contest->getTaskList();
	out << "<html><head>";
	out << R"(<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />)";
	out << "<style type=\"text/css\">th, td {padding-left: 1em; padding-right: 1em; white-space: nowrap; "
	       "text-align: center; verticle-align: middle;} .a {border-style: none solid solid none; "
	       "border-width: 1px 3px; border-color: #ccc;} .b {border-style: none solid solid none; "
	       "border-width: 3px 3px; border-color: #000;} .c {font-weight: bold; font-size: large;} "
	       ".d {font-size:x-large; font-weight:bold;} .e {font-size: small;} .f {font-weight: bold;}"
	       ".g {border-style: none solid solid none; border-width: 3px 2px; border-color: #000;}</style>";
	out << "<title>" << contest->getContestTitle() << " : " << tr("Contest Result") << "</title>";
	out << "</head><body>";
	QList<std::pair<int, QString>> sortList;

	for (auto &i : contestantList) {
		int totalScore = i->getTotalScore();

		if (totalScore != -1) {
			sortList.append(std::make_pair(-totalScore, i->getContestantName()));
		} else {
			sortList.append(std::make_pair(1, i->getContestantName()));
		}
	}

	std::sort(sortList.begin(), sortList.end());
	QMap<QString, int> rankList;

	for (int i = 0; i < sortList.size(); i++) {
		if (i > 0 && sortList[i].first == sortList[i - 1].first) {
			rankList.insert(sortList[i].second, rankList[sortList[i - 1].second]);
		} else {
			rankList.insert(sortList[i].second, i);
		}
	}

	QHash<Contestant *, int> loc;

	for (int i = 0; i < contestantList.size(); i++) {
		loc.insert(contestantList[i], i);
	}

	out << "<p><span class=\"d\">";
	out << "<a name=\"top\"></a>" << contest->getContestTitle() << " : " << tr("Rank List") << "</span></p>";
	out << "<p class=\"e\">" << tr("Judged By LemonLime") << "</p>";
	out << R"(<p><table border="1" cellpadding="1"><tr>)";
	out << QString("<th scope=\"col\">%1</th>").arg(tr("Rank"));
	out << QString("<th scope=\"col\">%1</th>").arg(tr("Name"));
	out << QString("<th scope=\"col\">%1</th>").arg(tr("Total Score"));

	for (auto &i : taskList)
		out << QString("<th scope=\"col\">%1</th>").arg(i->getProblemTitle());

	out << QString("</tr>");
	QList<int> fullScore;

	for (auto &i : taskList) {
		int a = i->getTotalScore();
		fullScore.append(a);
	}

	for (auto &i : sortList) {
		Contestant *contestant = contest->getContestant(i.second);
		out << QString("<tr><td>%1</td>").arg(rankList[contestant->getContestantName()] + 1);
		out << QString("<td><a href=\"#c%1\">%2</a></td>").arg(loc[contestant]).arg(i.second);
		int allScore = contestant->getTotalScore();

		if (allScore != -1) {
			out << QString("<td class=\"f\">%1</td>").arg(allScore);
		} else {
			out << QString("<td class=\"f\">%1</td>").arg(tr("Invalid"));
		}

		for (int j = 0; j < taskList.size(); j++) {
			int score = contestant->getTaskScore(j);

			if (score != -1) {
				out << QString("<td>%1</td>").arg(score);
			} else {
				out << QString("<td>%1</td>").arg(tr("Invalid"));
			}
		}
	}

	out << "</table></p>";

	for (int i = 0; i < contestantList.size(); i++) {
		out << QString("<a name=\"c%1\"><hr><a>").arg(i) << "<span class=\"d\">";
		out << tr("Contestant: %1").arg(contestantList[i]->getContestantName()) << "</span>";
		out << getSmallerContestantHtmlCode(contest, contestantList[i]);
	}

	out << "</body></html>";
	out.flush();
	return buffer;
}

auto ExportUtil::generateCsv(Contest *contest) -> QString {
	QString buffer;
	QTextStream out(&buffer);
	QList<Contestant *> contestantList = contest->getContestantList();
	QList<Task *> taskList = contest->getTaskList();
	QList<std::pair<int, QString>> sortList;

	for (auto &i : contestantList) {
		int totalScore = i->getTotalScore();

		if (totalScore != -1) {
			sortList.append(std::make_pair(-totalScore, i->getContestantName()));
		} else {
			sortList.append(std::make_pair(1, i->getContestantName()));
		}
	}

	std::sort(sortList.begin(), sortList.end());
	QMap<QString, int> rankList;

	for (int i = 0; i < sortList.size(); i++) {
		if (i > 0 && sortList[i].first == sortList[i - 1].first) {
			rankList.insert(sortList[i].second, rankList[sortList[i - 1].second]);
		} else {
			rankList.insert(sortList[i].second, i);
		}
	}

	QHash<Contestant *, int> loc;

	for (int i = 0; i < contestantList.size(); i++) {
		loc.insert(contestantList[i], i);
	}

	out << "\"" << tr("Rank") << "\"" << "," << "\"" << tr("Name") << "\"" << ",";

	for (auto &i : taskList) {
		out << "\"" << i->getProblemTitle() << "\"" << ",";
	}

	out << "\"" << tr("Total Score") << "\"" << Qt::endl;

	for (auto &i : sortList) {
		Contestant *contestant = contest->getContestant(i.second);
		out << "\"" << rankList[contestant->getContestantName()] + 1 << "\"" << ",";
		out << "\"" << i.second << "\"" << ",";

		for (int j = 0; j < taskList.size(); j++) {
			int score = contestant->getTaskScore(j);

			if (score != -1) {
				out << "\"" << score << "\"" << ",";
			} else {
				out << "\"" << tr("Invalid") << "\"" << ",";
			}
		}

		int score = contestant->getTotalScore();

		if (score != -1) {
			out << "\"" << score << "\"" << Qt::endl;
		} else {
			out << "\"" << tr("Invalid") << "\"" << Qt::endl;
		}
	}

	out.flush();
	return buffer;
}

auto ExportUtil::writeResultFile(Contest *contest, const QString &fileName, QString *errorMessage) -> bool {
	const QString suffix = QFileInfo(fileName).suffix().toLower();
	QString content;

	if (suffix == "html")
		content = generateHtml(contest);
	else if (suffix == "htm")
		content = generateSmallerHtml(contest);
	else if (suffix == "csv")
		content = generateCsv(contest);
	else {
		if (errorMessage)
			*errorMessage = tr("Unsupported export format: %1").arg(suffix);
		return false;
	}

	QFile file(fileName);

	if (! file.open(QFile::WriteOnly)) {
		if (errorMessage)
			*errorMessage = tr("Cannot open file %1").arg(QFileInfo(file).fileName());
		return false;
	}

	file.write(content.toUtf8());
	return true;
}