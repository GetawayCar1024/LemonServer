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

#include <atomic>
#include <csignal>

#ifdef Q_OS_WIN32
#include <windows.h>
#else
#include <QSocketNotifier>
#include <sys/socket.h>
#include <unistd.h>
#endif
#ifdef Q_OS_LINUX
#include <execinfo.h>
#endif

#define LEMON_MODULE_NAME "ServerMain"

// ---- shutting down cleanly: SIGTERM / SIGINT (systemd stop / restart, Ctrl+C) or closing the console window
// save every contest instead of losing the results judged since the last save.
static std::atomic<bool> shutdownDone{false};
static ContestManager *runningManager = nullptr;

// In the main thread. Quitting also leaves the event loop of a running judge; cancel it first so that
// whatever is unfinished keeps its previous results.
static void shutdown() {
	LOG("Shutting down");
	if (runningManager && runningManager->isJudging())
		runningManager->cancelJudge(runningManager->judgingContest());
	QCoreApplication::quit();
}

#ifdef Q_OS_WIN32
static BOOL WINAPI consoleHandler(DWORD) {
	QMetaObject::invokeMethod(QCoreApplication::instance(), [] { shutdown(); }, Qt::QueuedConnection);
	// the process is ended when this returns: give the main thread a few seconds to save
	for (int i = 0; i < 45 && ! shutdownDone; i++)
		Sleep(100);
	return TRUE;
}
#else
static int signalPipe[2] = {-1, -1};
static void quitSignalHandler(int) {
	const char c = 1;
	[[maybe_unused]] const auto n = ::write(signalPipe[1], &c, 1);
}
#endif

#ifdef Q_OS_LINUX
// A crash leaves a backtrace in the log (journalctl -u lemonserver), then the process ends as usual.
static void crashHandler(int sig) {
	void *frames[64];
	const int n = backtrace(frames, 64);
	const char header[] = "LemonServer crashed, backtrace:\n";
	[[maybe_unused]] const auto w = ::write(STDERR_FILENO, header, sizeof(header) - 1);
	backtrace_symbols_fd(frames, n, STDERR_FILENO);
	std::signal(sig, SIG_DFL);
	std::raise(sig);
}
#endif

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

	runningManager = &manager;
#ifdef Q_OS_WIN32
	SetConsoleCtrlHandler(consoleHandler, TRUE);
#else
	if (::socketpair(AF_UNIX, SOCK_STREAM, 0, signalPipe) == 0) {
		auto *notifier = new QSocketNotifier(signalPipe[0], QSocketNotifier::Read, &app);
		QObject::connect(notifier, &QSocketNotifier::activated, &app, [] {
			char c;
			[[maybe_unused]] const auto n = ::read(signalPipe[0], &c, 1);
			shutdown();
		});
		struct sigaction action {};
		action.sa_handler = quitSignalHandler;
		sigemptyset(&action.sa_mask);
		action.sa_flags = SA_RESTART;
		sigaction(SIGTERM, &action, nullptr);
		sigaction(SIGINT, &action, nullptr);
	}
#endif
#ifdef Q_OS_LINUX
	for (int sig : {SIGSEGV, SIGABRT, SIGBUS, SIGFPE, SIGILL})
		std::signal(sig, crashHandler);
#endif
	const int ret = app.exec();
	manager.closeAll();
	settings.saveSettings();
	runningManager = nullptr;
	shutdownDone = true;
	return ret;
}
