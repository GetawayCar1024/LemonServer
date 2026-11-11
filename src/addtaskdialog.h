/*
 * SPDX-FileCopyrightText: 2011-2018 Project Lemon, Zhipeng Jia
 * SPDX-FileCopyrightText: 2018-2019 Project LemonPlus, Dust1404
 * SPDX-FileCopyrightText: 2019-2022 Project LemonLime
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#pragma once
//

#include <QDialog>
#include "base/LemonType.hpp"

namespace Ui {
	class AddTaskDialog;
}

class AddTaskDialog : public QDialog {
	Q_OBJECT

  public:
	explicit AddTaskDialog(QWidget *parent = nullptr);
	~AddTaskDialog();
	void addTask(const QString &, Score, int, int);
	Score getFullScore(int) const;
	int getTimeLimit(int) const;
	int getMemoryLimit(int) const;

  private:
	Ui::AddTaskDialog *ui;
	QList<Score> fullScore;
	QList<int> timeLimit;
	QList<int> memoryLimit;

  private slots:
	void taskBoxIndexChanged();
	void fullScoreChanged();
	void timeLimitChanged();
	void memoryLimitChanged();
};
