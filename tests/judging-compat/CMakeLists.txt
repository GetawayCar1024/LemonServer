foreach(engine IN ITEMS current reference)
    add_executable(judge-compat-${engine} driver.cpp)
    if(engine STREQUAL "reference")
        target_link_libraries(judge-compat-reference PRIVATE lemon-base spdlog::spdlog)
        target_include_directories(judge-compat-reference BEFORE PRIVATE ${LEMON_COMPAT_REFERENCE_DIR} ${LEMON_COMPAT_REFERENCE_DIR}/core)
        target_compile_definitions(judge-compat-${engine} PRIVATE LEMON_REFERENCE_ENGINE)
        target_sources(judge-compat-${engine} PRIVATE
            ${LEMON_COMPAT_REFERENCE_DIR}/core/contestant.cpp
            ${LEMON_COMPAT_REFERENCE_DIR}/core/contestant.h
            ${LEMON_COMPAT_REFERENCE_DIR}/core/task.cpp
            ${LEMON_COMPAT_REFERENCE_DIR}/core/task.h
            ${LEMON_COMPAT_REFERENCE_DIR}/core/testcase.cpp
            ${LEMON_COMPAT_REFERENCE_DIR}/core/taskjudger.h
            ${LEMON_COMPAT_REFERENCE_DIR}/casejudger.cpp
            ${LEMON_COMPAT_REFERENCE_DIR}/taskjudger.cpp
            ${LEMON_COMPAT_REFERENCE_DIR}/processrunner.cpp)
        if(WIN32)
            target_sources(judge-compat-${engine} PRIVATE ${LEMON_COMPAT_REFERENCE_DIR}/processrunner_win.cpp)
        else()
            target_sources(judge-compat-${engine} PRIVATE ${LEMON_COMPAT_REFERENCE_DIR}/processrunner_unix.cpp)
        endif()
        if(WIN32)
            target_link_libraries(judge-compat-reference PRIVATE userenv advapi32 psapi)
            target_sources(judge-compat-reference PRIVATE ${LEMON_COMPAT_REFERENCE_DIR}/core/windowssandbox.cpp)
        endif()
    else()
        target_link_libraries(judge-compat-current PRIVATE lemon-core lemon-base spdlog::spdlog)
    endif()
    if(NOT WIN32)
        target_sources(judge-compat-${engine} PRIVATE ${LEMON_WATCHER_QRC})
        add_dependencies(judge-compat-${engine} watcher_unix)
    endif()
endforeach()

add_executable(score-persistence-test persistence.cpp)
target_link_libraries(score-persistence-test PRIVATE lemon-core lemon-base spdlog::spdlog)
if(NOT WIN32)
    target_sources(score-persistence-test PRIVATE ${LEMON_WATCHER_QRC})
    add_dependencies(score-persistence-test watcher_unix)
endif()
