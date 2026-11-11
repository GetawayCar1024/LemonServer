/* SPDX-License-Identifier: GPL-3.0-or-later */
#include "publicresults.h"
#include "jsonapi.h"
#include "base/LemonType.hpp"
#include <QJsonArray>
#include <algorithm>

namespace {
QString html(const QString &text) { return text.toHtmlEscaped(); }
QString number(const QJsonValue &value) { return value.isDouble() && value.toDouble() >= 0 ? scoreText(value.toDouble()) : QString(); }
QString csv(QString value) {
    const auto trimmed = value.trimmed();
    if ((!trimmed.isEmpty() && QString("=+-@").contains(trimmed.front())) || value.startsWith('\t') || value.startsWith('\r')) value.prepend('\'');
    value.replace('"', "\"\"");
    return '"' + value + '"';
}
}

QString publicResultsDocument(const QJsonObject &contest, const QString &format) {
    QList<QJsonObject> rows;
    for (const auto &value : contest["contestants"].toArray()) rows.append(value.toObject());
    std::sort(rows.begin(), rows.end(), [](const auto &a, const auto &b) {
        const double left = a["totalScore"].toDouble(-1), right = b["totalScore"].toDouble(-1);
        if (left != right) return left > right;
        if (a["totalUsedTime"].toDouble() != b["totalUsedTime"].toDouble()) return a["totalUsedTime"].toDouble() < b["totalUsedTime"].toDouble();
        return a["name"].toString() < b["name"].toString();
    });
    const auto tasks = contest["tasks"].toArray();
    QStringList headings{"排名", "选手"};
    for (const auto &task : tasks) headings.append(task.toObject()["problemTitle"].toString());
    headings.append({"总分", "用时 (s)", "评测时间"});
    QString output;
    if (format == "csv") {
        QStringList cells; for (const auto &heading : headings) cells.append(csv(heading));
        output = cells.join(',') + "\r\n";
    } else {
        output = "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><title>" + html(contest["title"].toString()) + "</title><style>body{font-family:system-ui,sans-serif;margin:24px}table{border-collapse:collapse;margin:12px 0}th,td{border:1px solid #ccc;padding:6px 10px;text-align:left}th{background:#eee}details{margin:14px 0}td{white-space:pre-wrap}</style></head><body><h1>" + html(contest["title"].toString()) + "</h1><table><thead><tr>";
        for (const auto &heading : headings) output += "<th>" + html(heading) + "</th>";
        output += "</tr></thead><tbody>";
    }
    int rank = 0;
    double previous = -2;
    for (int i = 0; i < rows.size(); i++) {
        const auto &row = rows[i]; const auto score = row["totalScore"].toDouble(-1);
        if (score != previous) rank = i + 1;
        previous = score;
        QStringList cells{score >= 0 ? QString::number(rank) : QString(), row["name"].toString()};
        for (const auto &task : row["tasks"].toArray()) cells.append(number(task.toObject()["score"]));
        cells.append(number(row["totalScore"]));
        cells.append(score >= 0 ? QString::number(row["totalUsedTime"].toDouble() / 1000, 'f', 3) : QString());
        cells.append(row["judgingTime"].toString());
        if (format == "csv") { QStringList quoted; for (const auto &cell : cells) quoted.append(csv(cell)); output += quoted.join(',') + "\r\n"; }
        else { output += "<tr>"; for (const auto &cell : cells) output += "<td>" + html(cell) + "</td>"; output += "</tr>"; }
    }
    if (format == "csv") return output;
    output += "</tbody></table>";
    if (format == "html") for (const auto &row : rows) {
        output += "<details><summary>" + html(row["name"].toString()) + "</summary>";
        const auto details = row["details"].toArray();
        for (int i = 0; i < details.size(); i++) {
            const auto detail = details[i].toObject(), task = tasks[i].toObject();
            output += "<h3>" + html(task["problemTitle"].toString()) + "</h3>";
            if (!detail["judged"].toBool()) { output += "<p>未评测</p>"; continue; }
            if (task["taskType"].toInt() != 1 && detail["compileState"].toInt() != 0) { output += "<p>" + html(LemonServerJson::compileStateName(detail["compileState"].toInt())) + "</p>"; continue; }
            output += "<table><tr><th>测试点</th><th>输入</th><th>结果</th><th>用时 (s)</th><th>内存 (MiB)</th><th>得分</th></tr>";
            const auto groups = detail["inputFiles"].toArray();
            for (int j = 0; j < groups.size(); j++) {
                const auto files = groups[j].toArray(), scores = detail["score"].toArray()[j].toArray();
                double minimum = 1e100; for (int k = 0; k < files.size(); k++) minimum = std::min(minimum, scores[k].toDouble());
                for (int k = 0; k < files.size(); k++) {
                    output += "<tr>";
                    if (!k) output += "<td rowspan=\"" + QString::number(files.size()) + "\">" + QString::number(j + 1) + "</td>";
                    const auto state = detail["result"].toArray()[j].toArray()[k].toInt();
                    const auto message = detail["message"].toArray()[j].toArray()[k].toString();
                    output += "<td>" + html(files[k].toString()) + "</td><td>" + html(LemonServerJson::resultStateName(state)) + (message.isEmpty() ? QString() : "<br>" + html(message)) + "</td>";
                    output += "<td>" + QString::number(detail["timeUsed"].toArray()[j].toArray()[k].toDouble() / 1000, 'f', 3) + "</td>";
                    output += "<td>" + QString::number(detail["memoryUsed"].toArray()[j].toArray()[k].toDouble() / 1048576, 'f', 3) + "</td>";
                    if (!k) output += "<td rowspan=\"" + QString::number(files.size()) + "\">" + scoreText(minimum) + " / " + number(task["testCases"].toArray()[j].toObject()["fullScore"]) + "</td>";
                    output += "</tr>";
                }
            }
            output += "</table>";
        }
        output += "</details>";
    }
    return output + "</body></html>";
}
