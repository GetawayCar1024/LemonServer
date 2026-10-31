/*
 * SPDX-FileCopyrightText: 2011-2018 Project Lemon, Zhipeng Jia
 * SPDX-FileCopyrightText: 2018-2019 Project LemonPlus, Dust1404
 * SPDX-FileCopyrightText: 2019-2022 Project LemonLime
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

// Widget based parts of ExportUtil (only built into the desktop GUI).

#include "exportutil.h"
//
#include "base/LemonType.hpp"
#include "base/settings.h"
#include "core/contest.h"
#include "core/contestant.h"
#include "core/task.h"

#include <QApplication>
#include <QFileDialog>
#include <QMessageBox>
#include <algorithm>

static void writeWithFeedback(QWidget *widget, Contest *contest, const QString &fileName) {
	QApplication::setOverrideCursor(Qt::WaitCursor);
	QString error;
	const bool ok = ExportUtil::writeResultFile(contest, fileName, &error);
	QApplication::restoreOverrideCursor();

	if (! ok) {
		QMessageBox::warning(widget, ExportUtil::tr("LemonLime"), error, QMessageBox::Ok);
		return;
	}

	QMessageBox::information(widget, ExportUtil::tr("LemonLime"), ExportUtil::tr("Export is done"),
	                         QMessageBox::Ok);
}

void ExportUtil::exportHtml(QWidget *widget, Contest *contest, const QString &fileName) {
	writeWithFeedback(widget, contest, fileName);
}

void ExportUtil::exportSmallerHtml(QWidget *widget, Contest *contest, const QString &fileName) {
	writeWithFeedback(widget, contest, fileName);
}

void ExportUtil::exportCsv(QWidget *widget, Contest *contest, const QString &fileName) {
	writeWithFeedback(widget, contest, fileName);
}
#ifdef ENABLE_XLS_EXPORT
void ExportUtil::exportXls(QWidget *widget, Contest *contest, const QString &fileName) {

	if (QFile(fileName).exists()) {
		if (! QFile(fileName).remove()) {
			QMessageBox::warning(widget, tr("LemonLime"),
			                     tr("Cannot open file %1").arg(QFileInfo(fileName).fileName()),
			                     QMessageBox::Ok);
			return;
		}
	}

	QApplication::setOverrideCursor(Qt::WaitCursor);
	QList<Contestant *> contestantList = contest->getContestantList();
	QList<Task *> taskList = contest->getTaskList();
	QList<std::pair<int, QString>> sortList;

	for (int i = 0; i < contestantList.size(); i++) {
		int totalScore = contestantList[i]->getTotalScore();

		if (totalScore != -1) {
			sortList.append(std::make_pair(-totalScore, contestantList[i]->getContestantName()));
		} else {
			sortList.append(std::make_pair(1, contestantList[i]->getContestantName()));
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

	QMap<Contestant *, int> loc;

	for (int i = 0; i < contestantList.size(); i++) {
		loc.insert(contestantList[i], i);
	}

	QAxObject *excel = new QAxObject("Excel.Application", widget);
	QAxObject *workbook = excel->querySubObject("Workbooks")->querySubObject("Add");
	QAxObject *sheet = workbook->querySubObject("ActiveSheet");
	sheet->setProperty("Name", QDate::currentDate().toString("yyyy-MM-dd"));
	sheet->querySubObject("Cells(int, int)", 1, 1)->setProperty("Value", tr("Rank"));
	sheet->querySubObject("Cells(int, int)", 1, 2)->setProperty("Value", tr("Name"));

	for (int i = 0; i < taskList.size(); i++)
		sheet->querySubObject("Cells(int, int)", 1, 3 + i)
		    ->setProperty("Value", taskList[i]->getProblemTitle());

	sheet->querySubObject("Cells(int, int)", 1, 3 + taskList.size())->setProperty("Value", tr("Total Score"));

	for (int i = 0; i < taskList.size() + 3; i++)
		sheet->querySubObject("Cells(int, int)", 1, i + 1)->querySubObject("Font")->setProperty("Bold", true);

	for (int i = 0; i < sortList.size(); i++) {
		Contestant *contestant = contest->getContestant(sortList[i].second);
		sheet->querySubObject("Cells(int, int)", 2 + i, 1)
		    ->setProperty("Value", rankList[contestant->getContestantName()] + 1);
		sheet->querySubObject("Cells(int, int)", 2 + i, 2)->setProperty("Value", sortList[i].second);

		for (int j = 0; j < taskList.size(); j++) {
			int score = contestant->getTaskScore(j);

			if (score != -1) {
				sheet->querySubObject("Cells(int, int)", 2 + i, 3 + j)->setProperty("Value", score);
			} else {
				sheet->querySubObject("Cells(int, int)", 2 + i, 3 + j)->setProperty("Value", tr("Invalid"));
			}
		}

		int score = contestant->getTotalScore();

		if (score != -1) {
			sheet->querySubObject("Cells(int, int)", 2 + i, 3 + taskList.size())->setProperty("Value", score);
		} else {
			sheet->querySubObject("Cells(int, int)", 2 + i, 3 + taskList.size())
			    ->setProperty("Value", tr("Invalid"));
		}
	}

	workbook->dynamicCall("SaveAs(const QString&, int)", QDir::toNativeSeparators(fileName), -4143);
	excel->dynamicCall("Quit()");
	delete excel;
	QApplication::restoreOverrideCursor();
	QMessageBox::information(widget, tr("LemonLime"), tr("Export is done"), QMessageBox::Ok);
}
#endif

void ExportUtil::exportResult(QWidget *widget, Contest *contest) {
	QList<Contestant *> contestantList = contest->getContestantList();
	QList<Task *> taskList = contest->getTaskList();

	if (contestantList.isEmpty()) {
		QMessageBox::warning(widget, tr("LemonLime"), tr("No contestant in current contest"),
		                     QMessageBox::Ok);
		return;
	}

	if (taskList.isEmpty()) {
		QMessageBox::warning(widget, tr("LemonLime"), tr("No task in current contest"), QMessageBox::Ok);
		return;
	}

	QString filter = tr("HTML Document (*.html *.htm);;CSV (*.csv)");
#ifdef ENABLE_XLS_EXPORT
	QAxObject *excel = new QAxObject("Excel.Application", widget);

	if (! excel->isNull())
		filter = filter + tr(";;Excel Workbook (*.xls)");

	delete excel;
#endif
	QString fileName = QFileDialog::getSaveFileName(
	    widget, tr("Export Result"), QDir::currentPath() + QDir::separator() + "result.html", filter);

	if (fileName.isEmpty())
		return;
	// TODO: refactor
	if (QFileInfo(fileName).suffix() == "html")
		exportHtml(widget, contest, fileName);

	if (QFileInfo(fileName).suffix() == "htm")
		exportSmallerHtml(widget, contest, fileName);

	if (QFileInfo(fileName).suffix() == "csv")
		exportCsv(widget, contest, fileName);
#ifdef ENABLE_XLS_EXPORT
	if (QFileInfo(fileName).suffix() == "xls")
		exportXls(widget, contest, fileName);
#endif
}
