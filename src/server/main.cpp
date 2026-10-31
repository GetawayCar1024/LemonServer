/*
 * SPDX-FileCopyrightText: 2026 LemonServer contributors
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 */

// LemonServer: a fork of LemonLime without the Qt Widgets UI. LemonLime's judging core (src/base,
// src/core) is used as is; the user interface is a web page served by an embedded HTTP server.

#include "contestmanager.h"
#include "jsonapi.h"
#include "lemonserver.h"
#include "serverconfig.h"

#include "base/LemonBase.hpp"
#include "base/LemonLog.hpp"
#include "base/LemonTranslator.hpp"
#include "base/settings.h"

#include "spdlog/sinks/daily_file_sink.h"
#include "spdlog/sinks/stdout_color_sinks.h"

#include <QCommandLineParser>
#include <QCoreApplication>
#include <QDir>
#include <QHostAddress>
#include <QLocale>
#include <QNetworkInterface>
#include <QStandardPaths>
#include <chrono>
#include <cstdio>

#ifdef Q_OS_WIN32
#include <windows.h>
#endif

#define LEMON_MODULE_NAME "ServerMain"

static void initLogger() {
	auto console_sink = std::make_shared<spdlog::sinks::stdout_color_sink_mt>();
	console_sink->set_level(spdlog::level::info);
	QDir logDir(QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation) + QDir::separator() +
	            "logs");
	logDir.mkpath(".");
	auto file_sink = std::make_shared<spdlog::sinks::daily_file_sink_mt>(
	    (logDir.path() + QDir::separator() + "lemonserver-log.txt").toStdString(), 0, 0, false, 30);
	file_sink->set_level(spdlog::level::trace);
	Lemon::base::logger =
	    std::make_shared<spdlog::logger>(spdlog::logger("lemonserver", {console_sink, file_sink}));
	spdlog::flush_every(std::chrono::seconds(5));
}

int main(int argc, char *argv[]) {
#ifdef Q_OS_WIN32
	// A server must never block on a message box: no "cannot find xxx.dll" / crash dialogs for the
	// programs it starts (contestants' programs, checkers, compilers). Child processes inherit this.
	SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
#endif
	QCoreApplication app(argc, argv);
	QCoreApplication::setApplicationName("LemonServer");
	QCoreApplication::setApplicationVersion(LEMONSERVER_VERSION);

	QCommandLineParser parser;
	parser.setApplicationDescription("LemonServer - a web judging server for OI contests, forked from LemonLime.");
	parser.addHelpOption();
	parser.addVersionOption();
	QCommandLineOption hostOption({"H", "host"}, "Address to listen on (default 0.0.0.0).", "address", "0.0.0.0");
	QCommandLineOption portOption({"p", "port"}, "Port to listen on (default 8080).", "port", "8080");
	QCommandLineOption configOption({"c", "config"}, "Path of the server configuration file.", "file");
	QCommandLineOption webRootOption("web-root", "Serve the web UI from this folder instead of the built-in copy.",
	                                 "dir");
	QCommandLineOption resetTokenOption("reset-token", "Reset the access token to the default (123456) and exit.");
	QCommandLineOption desktopSettingsOption(
	    "use-desktop-settings",
	    "Share judging settings and compilers with the desktop LemonLime of this user instead of "
	    "keeping them in settings.ini next to the configuration file.");
	parser.addOptions(
	    {hostOption, portOption, configOption, webRootOption, resetTokenOption, desktopSettingsOption});
	parser.process(app);

	initLogger();

	const QString configPath =
	    parser.isSet(configOption)
	        ? QDir(parser.value(configOption)).absolutePath()
	        : QStandardPaths::writableLocation(QStandardPaths::AppConfigLocation) + "/server.json";
	ServerConfig config(configPath);
	if (! config.load()) {
		fprintf(stderr, "Cannot read configuration file %s\n", qPrintable(configPath));
		return 1;
	}
	if (parser.isSet(resetTokenOption)) {
		config.setToken(ServerConfig::defaultToken);
		config.save();
		printf("Access token has been reset to %s\n", ServerConfig::defaultToken);
		return 0;
	}

	// LemonLime's own Settings class keeps compilers, limits and language. By default the server stores
	// them in its own INI file so that it does not interfere with a desktop installation.
	bool freshSettings = false;
	if (! parser.isSet(desktopSettingsOption)) {
		const QString iniPath = QFileInfo(configPath).absoluteDir().filePath("settings.ini");
		freshSettings = ! QFileInfo::exists(iniPath);
		Settings::setSettingsFile(iniPath);
	}
	Settings settings;
	settings.loadSettings();
	if (freshSettings && settings.getCompilerList().isEmpty()) {
		for (const auto &v : LemonServer::detectCompilers()) {
			QString error;
			if (auto *c = LemonServerJson::compilerFromJson(v.toObject(), &error))
				settings.addCompiler(c);
		}
		settings.saveSettings();
	}
	Lemon::common::LemonLimeTranslator = std::make_unique<Lemon::common::LemonTranslator>();
	const auto languages = Lemon::common::LemonLimeTranslator->GetAvailableLanguages();
	if (! languages.contains(settings.getUiLanguage())) {
		const auto osLanguage = QLocale::system().name();
		if (languages.contains(osLanguage))
			settings.setUiLanguage(osLanguage);
		else if (! languages.isEmpty())
			settings.setUiLanguage(languages.first());
	}
	Lemon::common::LemonLimeTranslator->InstallTranslation(settings.getUiLanguage());

	if (! config.contestRoot().isEmpty()) {
		QDir().mkpath(config.contestRoot());
		QDir::setCurrent(config.contestRoot());
	}

	ContestManager manager(&settings, &config);
	LemonServer server(&settings, &config, &manager,
	                   parser.isSet(webRootOption) ? QDir(parser.value(webRootOption)).absolutePath() : QString());

	bool portOk = false;
	const quint16 port = parser.value(portOption).toUShort(&portOk);
	const QHostAddress address(parser.value(hostOption));
	QString error;
	if (! portOk || address.isNull() || ! server.listen(address, port, &error)) {
		fprintf(stderr, "Cannot listen on %s:%s %s\n", qPrintable(parser.value(hostOption)),
		        qPrintable(parser.value(portOption)), qPrintable(error));
		return 1;
	}

	printf("LemonServer %s (based on LemonLime %s)\n", LEMONSERVER_VERSION, LEMON_VERSION_STRING);
	printf("  Config file : %s\n", qPrintable(QDir::toNativeSeparators(configPath)));
	printf("  Settings    : %s\n", Settings::getSettingsFile().isEmpty()
	                                   ? "(shared with the desktop LemonLime)"
	                                   : qPrintable(QDir::toNativeSeparators(Settings::getSettingsFile())));
	printf("  Contests    : %s\n", config.contestRoot().isEmpty()
	                                   ? "(not configured yet, set it in the web page)"
	                                   : qPrintable(QDir::toNativeSeparators(config.contestRoot())));
	printf("  Listening   : http://%s:%u/\n", qPrintable(parser.value(hostOption)), port);
	if (address == QHostAddress::AnyIPv4 || address == QHostAddress::Any) {
		for (const auto &a : QNetworkInterface::allAddresses())
			if (a.protocol() == QAbstractSocket::IPv4Protocol && ! a.isLoopback())
				printf("                http://%s:%u/\n", qPrintable(a.toString()), port);
	}
	if (config.tokenIsDefault())
		printf("  The access token is still the default one (123456). Please change it in the web page.\n");
	fflush(stdout);

	const int ret = app.exec();
	manager.close();
	settings.saveSettings();
	return ret;
}
