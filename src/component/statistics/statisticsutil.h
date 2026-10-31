/*
 * SPDX-FileCopyrightText: 2019-2022 Project LemonLime
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#pragma once

#include "base/LemonType.hpp"
#include <QCoreApplication>
#include <QList>
#include <QMap>
#include <QString>

class Contest;
class Contestant;
class Task;
class TestCase;

// Widget-free statistics report, shared by StatisticsBrowser (GUI) and lemon-server.
class StatisticsUtil {
	// Keep the "StatisticsBrowser" translation context of the original widget.
	Q_DECLARE_TR_FUNCTIONS(StatisticsBrowser)

  public:
	static QString generateHtml(Contest *);
	static bool checkValid(QList<Task *>, const QList<Contestant *> &);
	static QString getScoreNormalChart(const QMap<int, int> &, int, int);
	static QString getTestcaseScoreChart(QList<TestCase *>, QList<QList<QList<int>>>,
	                                     QList<QList<QList<ResultState>>>);
};
