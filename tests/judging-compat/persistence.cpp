// Exercise the real legacy stream readers independently of the new Score ABI.
#include "base/settings.h"
#include "core/contest.h"
#include "core/contestant.h"
#include "core/task.h"
#include "core/testcase.h"
#include <QCoreApplication>
#include <QDataStream>
#include <QJsonArray>
#include <cstdio>
#include <stdexcept>

static void require(bool condition, const char *message) {
	if (!condition) throw std::runtime_error(message);
}

int main(int argc, char **argv) {
	QCoreApplication app(argc, argv);
	QByteArray bytes;
	{
		QDataStream stream(&bytes, QIODevice::WriteOnly);
		stream << int(75) << int(1200) << int(256)
		       << QStringList{"1.in", "1_lemon_SUbtaskDEPENDENCE_fLAg"} << QStringList{"1.out"} << int(9876);
	}
	QDataStream input(bytes);
	TestCase testCase;
	testCase.readFromStream(input);
	int sentinel = 0; input >> sentinel;
	require(testCase.getFullScore() == 75 && testCase.getTimeLimit() == 1200 && testCase.getMemoryLimit() == 256 && sentinel == 9876, "legacy TestCase stream alignment");
	require(testCase.getInputFiles() == QStringList{"1.in"}, "legacy input paths");

	bytes.clear();
	{
		QDataStream stream(&bytes, QIODevice::WriteOnly);
		stream << QString("alice") << QList<bool>{true} << QStringList{"a.cpp"} << QStringList{"compile message"}
		       << QList<QList<QStringList>>{{QStringList{"1.in", "2.in"}}}
		       << QList<QList<QStringList>>{{QStringList{"first", "second"}}}
		       << QList<QList<QList<int>>>{{{80, 40, -500001}}}
		       << QList<QList<QList<int>>>{{{12, 34}}}
		       << QList<QList<QList<int>>>{{{1024, 2048}}}
		       << quint32(2460000) << quint32(12345) << quint8(Qt::UTC)
		       << int(1) << int(CompileSuccessfully) << int(1) << int(1) << int(2)
		       << int(CorrectAnswer) << int(PartlyCorrect) << int(9876);
	}
	QDataStream oldResult(bytes);
	Contestant person;
	person.readFromStream(oldResult); oldResult >> sentinel;
	require(oldResult.status() == QDataStream::Ok && sentinel == 9876, "legacy Contestant stream alignment");
	require(person.getScore(0) == QList<QList<Score>>{{80, 40, -500001}} && person.getTaskScore(0) == 40, "legacy integer scores and dependency marker");
	require(person.getTimeUsed(0)[0][1] == 34 && person.getMemoryUsed(0)[0][1] == 2048 && person.getResult(0)[0][1] == PartlyCorrect, "legacy non-score fields");

	Settings settings;
	Contest contest;
	contest.setSettings(&settings);
	auto *task = new Task;
	auto *point = new TestCase;
	point->setFullScore(100);
	task->addTestCase(point); contest.addTask(task);
	QJsonObject json; contest.writeToJson(json);
	require(json["version"] == "1.0", "integer-only CDF remains compatible");
	point->setFullScore(0.125); contest.writeToJson(json);
	require(json["version"] == "1.1", "fractional maximum requires CDF 1.1");
	Contest restored; restored.setSettings(&settings);
	require(restored.readFromJson(json) == 0 && restored.getTotalScore() == 0.125, "fractional CDF round trip");
	point->setFullScore(100); contest.writeToJson(json);
	person.setScore(0, {{0.375, 0.5}});
	QJsonObject result; person.writeToJson(result);
	json["contestants"] = QJsonArray{result};
	Contest withResult; withResult.setSettings(&settings);
	require(withResult.readFromJson(json) == 0, "read fractional result");
	withResult.writeToJson(json);
	require(json["version"] == "1.1" && withResult.getContestant("alice")->getTotalScore() == 0.375, "fractional result requires CDF 1.1 even with integer maxima");
	puts("PASS legacy integer streams and fractional CDF versioning/round trips");
}
