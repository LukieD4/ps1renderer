# PSn00bSDK example CMake script
# (C) 2021 spicyjpeg - MPL licensed

cmake_minimum_required(VERSION 3.21)
project(
    PSn00bSDK-template
    LANGUAGES    C CXX ASM
    VERSION      1.0.0
    DESCRIPTION  "PSn00bSDK template"
    HOMEPAGE_URL "http://lameguy64.net/?page=psn00bsdk"
)

find_package(Python3 REQUIRED)

# ------------------------------------------------------------
# 1. OBJ -> C asset generation
# ------------------------------------------------------------
# NOTE: file(GLOB ...) runs at CMake CONFIGURE time, which is BEFORE
# py_convert_assets.py has ever produced anything on a clean checkout -
# so globbing assets_c/*.c as the OUTPUT here would see an empty list on
# first configure and the custom command would never be wired up
# correctly (no OUTPUT = nothing for other targets to depend on).
#
# Instead we glob the SOURCE .obj files (these already exist in the repo)
# and treat the whole assets_c/ directory as a single stamp file dependency
# via a marker, so Ninja/Make actually reruns the conversion whenever any
# .obj/.mtl changes, without requiring the generated .c files to exist yet
# at configure time.
file(GLOB_RECURSE SOURCE_OBJ_FILES "${CMAKE_SOURCE_DIR}/assets/*.obj")
file(GLOB_RECURSE SOURCE_MTL_FILES "${CMAKE_SOURCE_DIR}/assets/*.mtl")

set(ASSETS_STAMP "${CMAKE_BINARY_DIR}/assets_converted.stamp")

add_custom_command(
    OUTPUT "${ASSETS_STAMP}"
    COMMAND "${Python3_EXECUTABLE}" -u "${CMAKE_SOURCE_DIR}/py_convert_assets.py"
    COMMAND "${CMAKE_COMMAND}" -E touch "${ASSETS_STAMP}"
    DEPENDS ${SOURCE_OBJ_FILES} ${SOURCE_MTL_FILES} "${CMAKE_SOURCE_DIR}/py_convert_assets.py"
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
    COMMENT "Converting OBJ assets into C arrays"
)
add_custom_target(convert_assets
    DEPENDS "${ASSETS_STAMP}"
)

# ------------------------------------------------------------
# 2. PNG -> TIM texture conversion
# ------------------------------------------------------------
# Same reasoning as above - depend on source PNGs + the script, not a
# glob of assets_c output that may not exist yet. face.tim now lands
# directly in assets_c/ (flat, no textures/ subfolder - see
# py_convert_textures.py for why).
file(GLOB_RECURSE SOURCE_PNG_FILES "${CMAKE_SOURCE_DIR}/assets/*/textures/*.png")

set(FACE_TIM_PATH "${CMAKE_SOURCE_DIR}/assets_c/face.tim")

add_custom_command(
    OUTPUT "${FACE_TIM_PATH}"
    COMMAND "${Python3_EXECUTABLE}" -u "${CMAKE_SOURCE_DIR}/py_convert_textures.py"
    DEPENDS ${SOURCE_PNG_FILES} "${CMAKE_SOURCE_DIR}/py_convert_textures.py"
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
    COMMENT "Converting PNG textures into TIM files"
)
add_custom_target(convert_textures
    DEPENDS "${FACE_TIM_PATH}"
)

# ------------------------------------------------------------
# 2b. Combined "convert everything" target
# ------------------------------------------------------------
# Single entry point that runs both conversion passes in the correct
# order (assets before textures, per py_convert_textures.py's own
# "Run after py_convert_assets.py!" comment) - lets you type one target
# name instead of remembering which of the two to run, or in which order.
add_custom_target(convert_everything
    DEPENDS convert_assets convert_textures
)

# ------------------------------------------------------------
# 3. Build PS1 executable (main.c + tim_face.S)
# ------------------------------------------------------------
psn00bsdk_add_executable(template GPREL main.c tim_face.S)

# Make the assembler see the absolute TIM path
target_compile_definitions(template PRIVATE
    FACE_TIM_PATH="${FACE_TIM_PATH}"
)

# Ensure both conversion pipelines complete before building the executable
add_dependencies(template convert_everything)

# ------------------------------------------------------------
# 4. Build ISO
# ------------------------------------------------------------
psn00bsdk_add_cd_image(
    iso
    template
    iso.xml
    DEPENDS template system.cnf
)

# ------------------------------------------------------------
# 5. Run target
# ------------------------------------------------------------
add_custom_target(run
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/py_run_duckstation.py" "${CMAKE_BINARY_DIR}/template.cue"
    DEPENDS iso
    WORKING_DIRECTORY "${CMAKE_BINARY_DIR}"
)