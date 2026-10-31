/*
 * SPDX-FileCopyrightText: 2026 LemonServer contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

#pragma once

#include <QByteArray>
#include <QJsonObject>
#include <QProcessEnvironment>
#include <QString>
#include <QStringList>

class Compiler;

// Compiling checkers / interactors / generators on the server with the bundled
// Testlib for Lemons (assets/Testlib-for-Lemons, embedded as :/testlib/).
namespace TestlibTools {
	QByteArray testlibHeader();
	QStringList templateNames();             // e.g. "checkers/wcmp.cpp"
	QByteArray templateSource(const QString &name);

	struct CompileRequest {
		QString source;           // absolute path of the source file
		QString output;           // absolute path of the executable to produce
		QString compilerPath;
		QStringList arguments;    // extra arguments (optimisation, standard, ...)
		QProcessEnvironment environment;
		int timeoutMs = 60000;
		bool bundledTestlib = true;
	};

	struct CompileResult {
		bool ok = false;
		bool timedOut = false;
		bool started = true;
		int exitCode = -1;
		double seconds = 0;
		QString output;
	};

	// Thread-safe: runs the compiler synchronously in the calling thread.
	CompileResult compile(const CompileRequest &request);

	// The environment LemonLime uses when running a compiler (compiler variables prepended to the system ones).
	QProcessEnvironment compilerEnvironment(const Compiler *compiler);
	QStringList defaultArguments(const QString &suffix);
} // namespace TestlibTools
