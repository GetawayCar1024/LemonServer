/*
 * SPDX-FileCopyrightText: 2026 LemonServer contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#include "testlibtools.h"

#include "base/compiler.h"

#include <QDir>
#include <QDirIterator>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QProcess>
#include <QStringDecoder>
#include <QTemporaryDir>

namespace TestlibTools {

	QByteArray testlibHeader() {
		QFile f(":/testlib/testlib.h");
		return f.open(QFile::ReadOnly) ? f.readAll() : QByteArray();
	}

	QStringList templateNames() {
		QStringList names;
		for (const char *dir : {"checkers", "interactors", "validators", "generators"}) {
			QDirIterator it(QString(":/testlib/") + dir, {"*.cpp"}, QDir::Files);
			while (it.hasNext()) {
				it.next();
				names.append(QString(dir) + "/" + it.fileName());
			}
		}
		names.sort();
		return names;
	}

	QByteArray templateSource(const QString &name) {
		if (name.contains("..") || ! templateNames().contains(name))
			return {};
		QFile f(":/testlib/" + name);
		return f.open(QFile::ReadOnly) ? f.readAll() : QByteArray();
	}

	QProcessEnvironment compilerEnvironment(const Compiler *compiler) {
		// Same merging as TaskJudger::traditionalTaskPrepare()
		QProcessEnvironment environment = compiler ? compiler->getEnvironment() : QProcessEnvironment();
		const auto system = QProcessEnvironment::systemEnvironment();
		for (const auto &variable : system.keys()) {
			if (environment.contains(variable))
#ifdef Q_OS_WIN32
				environment.insert(variable, environment.value(variable) + ";" + system.value(variable));
#else
				environment.insert(variable, environment.value(variable) + ":" + system.value(variable));
#endif
			else
				environment.insert(variable, system.value(variable));
		}
		return environment;
	}

	QStringList defaultArguments(const QString &suffix) {
		const QString s = suffix.toLower();
		if (s == "c")
			return {"-O2", "-std=c11", "-lm"};
		return {"-O2", "-std=c++17"};
	}

	static QString decode(const QByteArray &data) {
		auto decoder = QStringDecoder(QStringDecoder::Utf8);
		QString text = decoder(data);
		return decoder.hasError() ? QString::fromLocal8Bit(data) : text;
	}

	CompileResult compile(const CompileRequest &request) {
		CompileResult result;
		QTemporaryDir temp;
		if (! temp.isValid()) {
			result.started = false;
			result.output = "Cannot create a temporary directory";
			return result;
		}
		// Compile a copy next to the bundled testlib.h so that `#include "testlib.h"` picks it up first;
		// the original folder stays on the include path for other local headers.
		const QFileInfo src(request.source);
		const QString copy = QDir(temp.path()).filePath(src.fileName());
		if (! QFile::copy(src.absoluteFilePath(), copy)) {
			result.started = false;
			result.output = "Cannot read " + src.fileName();
			return result;
		}
		if (request.bundledTestlib) {
			QFile header(QDir(temp.path()).filePath("testlib.h"));
			if (header.open(QFile::WriteOnly))
				header.write(testlibHeader());
		}
		const QString tempOutput = QDir(temp.path()).filePath(QFileInfo(request.output).fileName());

		QStringList args = request.arguments;
		args << "-o" << tempOutput << copy << "-I" << src.absolutePath();
		// testlib.h predates GCC 15's template body checks; older compilers silently ignore this flag
		args << "-Wno-template-body";
#ifdef Q_OS_WIN32
		// Link statically so the checker runs without the compiler's DLLs (libstdc++-6.dll, ...) on PATH.
		args << "-static" << "-Wl,--stack=268435456";
#endif

		QProcess process;
		process.setProcessChannelMode(QProcess::MergedChannels);
		process.setProcessEnvironment(request.environment);
		process.setWorkingDirectory(temp.path());
		QElapsedTimer timer;
		timer.start();
		process.start(request.compilerPath, args);
		if (! process.waitForStarted(10000)) {
			result.started = false;
			result.output = "Cannot start compiler: " + request.compilerPath + "\n" + process.errorString();
			return result;
		}
		if (! process.waitForFinished(request.timeoutMs)) {
			process.kill();
			process.waitForFinished(3000);
			result.timedOut = true;
		}
		result.seconds = timer.elapsed() / 1000.0;
		result.output = decode(process.readAll());
		result.exitCode = process.exitCode();
		QString commandLine = QFileInfo(request.compilerPath).fileName() + " " + args.join(' ');
		commandLine.replace(temp.path() + "/", "");
		result.output = "$ " + commandLine + "\n" + result.output;
		if (result.timedOut || process.exitStatus() != QProcess::NormalExit || result.exitCode != 0)
			return result;
		if (! QFileInfo::exists(tempOutput)) {
			result.output += "\nThe compiler did not produce " + QFileInfo(tempOutput).fileName();
			return result;
		}
		QDir().mkpath(QFileInfo(request.output).absolutePath());
		QFile::remove(request.output);
		if (! QFile::copy(tempOutput, request.output)) {
			result.output += "\nCannot write " + request.output;
			return result;
		}
		QFile(request.output).setPermissions(QFile(request.output).permissions() | QFileDevice::ExeOwner |
		                                     QFileDevice::ExeUser | QFileDevice::ExeGroup);
		result.ok = true;
		return result;
	}

} // namespace TestlibTools
