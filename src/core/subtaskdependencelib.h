/*
 * SPDX-FileCopyrightText: 2019-2022 Project LemonLime
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#pragma once
//

#include "base/LemonType.hpp"
#include <QObject>
#include <QString>

const int maxDependValue = 1000000;

inline int stateToStatus(ResultState in, Score score, Score maxScore) {
	if (in == CorrectAnswer)
		return maxDependValue;

	if (in == PartlyCorrect && maxScore == 0)
		return maxDependValue;

	if (score <= 0)
		return -1;

	return int(qBound(0.0, maxDependValue * score / maxScore, double(maxDependValue)));
}

inline Score statusToScore(int ratio, Score maxScore) { return maxScore * ratio / maxDependValue; }

inline QString statusRankingText(int ratio) {
	if (ratio >= maxDependValue)
		return QObject::tr("Pure");

	if (ratio < 0)
		return QObject::tr("Lost");

	return QString::number(100.00 * ratio / maxDependValue, 'f', 3) + "%";
}
