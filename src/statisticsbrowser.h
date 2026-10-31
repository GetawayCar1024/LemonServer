/*
 * SPDX-FileCopyrightText: 2019-2022 Project LemonLime
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#pragma once
//

#include "base/LemonType.hpp"
#include "core/contestant.h"
#include "core/task.h"
#include "core/testcase.h"
#include <QWidget>

namespace Ui {
	class StatisticsBrowser;
}

class Contest;
class TestCase;

static QString nowBrowserText;

class StatisticsBrowser : public QWidget {
	Q_OBJECT

  public:
	explicit StatisticsBrowser(QWidget *parent = nullptr);
	void setContest(Contest *);
	static void exportStatistics(QWidget *, Contest *);
	~StatisticsBrowser();

  public slots:
	void refresh();

  private:
	Ui::StatisticsBrowser *ui;
	Contest *curContest;
	static void exportStatisticsHtml(QWidget *, const QString &);
};
