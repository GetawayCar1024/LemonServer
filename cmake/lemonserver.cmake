# ==================================================================================
# LemonServer: headless LemonLime (judging core) with an embedded HTTP server and web UI
# ==================================================================================

find_package(${LEMON_QT_LIBNAME} ${LEMON_QT_MIN_VERSION} COMPONENTS Network HttpServer REQUIRED)
# QZipReader / QZipWriter come from the private QtCore API (target ${LEMON_QT_LIBNAME}::CorePrivate).
# Qt 6.9 and later only define private targets when they are asked for.
if(${LEMON_QT_LIBNAME}_VERSION VERSION_GREATER_EQUAL 6.9)
    find_package(${LEMON_QT_LIBNAME} COMPONENTS CorePrivate REQUIRED)
endif()

set(LEMON_BASEDIR_SERVER ${CMAKE_SOURCE_DIR}/src/server)
file(GLOB LEMON_SERVER_SOURCES CONFIGURE_DEPENDS
    ${LEMON_BASEDIR_SERVER}/*.cpp
    ${LEMON_BASEDIR_SERVER}/*.h
    )

add_executable(LemonServer
    ${LEMON_SERVER_SOURCES}
    ${LEMON_SHARED_COMPONENT_SOURCES}
    ${CMAKE_SOURCE_DIR}/web/web.qrc
    ${LEMON_EMBED_TRANSLATION_QRC}
    ${LEMON_WATCHER_QRC}
    ${QM_FILES}
    )

if(NOT WIN32)
    add_dependencies(LemonServer watcher_unix)
endif()

# Testlib for Lemons (git submodule) is embedded so that checkers can be compiled on the server.
set(LEMON_TESTLIB_DIR ${CMAKE_SOURCE_DIR}/assets/Testlib-for-Lemons)
if(NOT EXISTS ${LEMON_TESTLIB_DIR}/testlib.h)
    message(FATAL_ERROR "assets/Testlib-for-Lemons is missing, run: git submodule update --init assets/Testlib-for-Lemons")
endif()
file(GLOB LEMON_TESTLIB_TEMPLATES RELATIVE ${LEMON_TESTLIB_DIR}
    ${LEMON_TESTLIB_DIR}/checkers/*.cpp
    ${LEMON_TESTLIB_DIR}/interactors/*.cpp
    ${LEMON_TESTLIB_DIR}/validators/*.cpp
    ${LEMON_TESTLIB_DIR}/generators/*.cpp
    )
set(LEMON_TESTLIB_RESOURCES testlib.h ${LEMON_TESTLIB_TEMPLATES})
list(TRANSFORM LEMON_TESTLIB_RESOURCES PREPEND ${LEMON_TESTLIB_DIR}/)
qt_add_resources(LemonServer "testlib"
    PREFIX "/testlib"
    BASE ${LEMON_TESTLIB_DIR}
    FILES ${LEMON_TESTLIB_RESOURCES}
    )

target_include_directories(LemonServer PUBLIC ${CMAKE_SOURCE_DIR}/src)
target_precompile_headers(LemonServer PUBLIC ${CMAKE_SOURCE_DIR}/src/pch.h)

target_compile_definitions(LemonServer PRIVATE LEMONSERVER_VERSION="${LEMONSERVER_VERSION}")
target_link_libraries(LemonServer PRIVATE
    ${LEMON_QT_LIBS}
    ${LEMON_QT_LIBNAME}::Network
    ${LEMON_QT_LIBNAME}::HttpServer
    ${LEMON_QT_LIBNAME}::CorePrivate
    lemon-core
    lemon-base
    SingleApplication::SingleApplication
    spdlog::spdlog
    )

if(UNIX AND NOT APPLE)
    include(GNUInstallDirs)
    install(TARGETS LemonServer RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
elseif(WIN32)
    install(TARGETS LemonServer RUNTIME DESTINATION .)
endif()
