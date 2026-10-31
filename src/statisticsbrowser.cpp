/*
 * SPDX-FileCopyrightText: 2019-2022 Project LemonLime
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#include "statisticsbrowser.h"
#include "ui_statisticsbrowser.h"
//
#include "base/LemonType.hpp"
#include "base/settings.h"
#include "component/statistics/statisticsutil.h"
#include "core/contest.h"
#include "core/contestant.h"
#include "core/task.h"
//
#include <QApplication>
#include <QCheckBox>
#include <QFileDialog>
#include <QGridLayout>
#include <QHeaderView>
#include <QMap>
#include <QMenu>
#include <QMessageBox>
#include <QtMath>

StatisticsBrowser::StatisticsBrowser(QWidget *parent) : QWidget(parent), ui(new Ui::StatisticsBrowser) {
	ui->setupUi(this);
	curContest = nullptr;
}

StatisticsBrowser::~StatisticsBrowser() { delete ui; }

void StatisticsBrowser::setContest(Contest *contest) { curContest = contest; }

void StatisticsBrowser::refresh() {
	QString buffer = StatisticsUtil::generateHtml(curContest);
	ui->textBrowser->setHtml(buffer);
	nowBrowserText = buffer;
}
void StatisticsBrowser::exportStatisticsHtml(QWidget *widget, const QString &fileName) {
	QFile file(fileName);

	if (! file.open(QFile::WriteOnly)) {
		QMessageBox::warning(widget, tr("LemonLime"),
		                     tr("Cannot open file %1").arg(QFileInfo(file).fileName()), QMessageBox::Ok);
		return;
	}

	QApplication::setOverrideCursor(Qt::WaitCursor);
	QTextStream out(&file);
	out << nowBrowserText;
	QApplication::restoreOverrideCursor();
	QMessageBox::information(widget, tr("LemonLime"), tr("Export is done"), QMessageBox::Ok);
}

void StatisticsBrowser::exportStatistics(QWidget *widget, Contest *curContest) {
	if (! curContest) {
		QMessageBox::warning(widget, tr("LemonLime"), tr("No contest yet"), QMessageBox::Ok);
		return;
	}

	QList<Task *> taskList = curContest->getTaskList();
	QList<Contestant *> contestantList = curContest->getContestantList();

	if (taskList.empty()) {
		QMessageBox::warning(widget, tr("LemonLime"), tr("No task yet"), QMessageBox::Ok);
		return;
	}

	if (contestantList.empty()) {
		QMessageBox::warning(widget, tr("LemonLime"), tr("No contestant yet"), QMessageBox::Ok);
		return;
	}

	QString filter = tr("HTML Document (*.html)");
	QString fileName = QFileDialog::getSaveFileName(
	    widget, tr("Export Statistics"), QDir::currentPath() + QDir::separator() + "statistics.html", filter);

	if (fileName.isEmpty())
		return;

	if (QFileInfo(fileName).suffix() == "html")
		exportStatisticsHtml(widget, fileName);
}
