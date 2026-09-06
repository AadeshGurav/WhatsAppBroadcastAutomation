cmake_minimum_required(VERSION 3.22.1)
project("senderrr_node")

# libnode.so and its headers are build artifacts of scripts/build-libnode.sh,
# not checked-in source. Fail loudly and with the fix, rather than emitting a
# wall of "node.h: No such file or directory" (CLAUDE.md — errors never pass
# silently).
set(NODE_HEADERS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/nodeheaders")
set(NODE_LIB "${CMAKE_CURRENT_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so")

if(NOT EXISTS "${NODE_LIB}" OR NOT EXISTS "${NODE_HEADERS_DIR}/node/node.h")
    message(FATAL_ERROR
        "libnode.so or its headers are missing for ABI '${ANDROID_ABI}'.\n"
        "Build the Node runtime first:\n"
        "    bash scripts/build-libnode.sh\n"
        "Expected library: ${NODE_LIB}")
endif()

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION "${NODE_LIB}")

add_library(senderrr_node SHARED node_bridge.cpp)

target_include_directories(senderrr_node PRIVATE "${NODE_HEADERS_DIR}/node")
target_compile_features(senderrr_node PRIVATE cxx_std_20)
target_link_libraries(senderrr_node PRIVATE node android log)
