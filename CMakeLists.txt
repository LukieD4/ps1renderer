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
# so globbing generated/*.c as the OUTPUT here would see an empty list on
# first configure and the custom command would never be wired up
# correctly (no OUTPUT = nothing for other targets to depend on).
#
# Instead we glob the SOURCE .obj files (these already exist in the repo)
# and treat the whole generated/ directory as a single stamp file dependency
# via a marker, so Ninja/Make actually reruns the conversion whenever any
# .obj/.mtl changes, without requiring the generated .c files to exist yet
# at configure time.
file(GLOB_RECURSE SOURCE_OBJ_FILES "${CMAKE_SOURCE_DIR}/assets/*.obj")
file(GLOB_RECURSE SOURCE_MTL_FILES "${CMAKE_SOURCE_DIR}/assets/*.mtl")

set(ASSETS_STAMP "${CMAKE_BINARY_DIR}/generatedonverted.stamp")

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
# 2. PNG -> texture blob conversion
# ------------------------------------------------------------
# Same reasoning as above - depend on source PNGs + the script, not a
# glob of generated output that may not exist yet.
#
# py_convert_textures.py now emits FOUR fixed-path artifacts regardless
# of how many textures are discovered under assets/*/textures/:
#   - generated/textures.bin      the concatenated TIM blob
#   - generated/tex_blob.S        fixed .incbin of textures.bin (never
#                                  changes shape as textures are added)
#   - generated/tex_blob_table.c  offset/length/paletteCount table, keyed
#                                  by material name, read by main.c
#   - generated/tex_blob_table.h  the TEX_BLOB_ENTRY struct + externs,
#                                  shared by tex_blob_table.c AND main.c
#                                  (which #includes it directly) - must be
#                                  listed as an OUTPUT below too, or a
#                                  clean checkout has no dependency edge
#                                  telling CMake it must exist before
#                                  main.c compiles.
#
# Because these paths are fixed (unlike the old single-texture
# FACE_TIM_PATH scheme where the path itself depended on which model was
# active), we can list them directly as OUTPUT here - no per-texture
# CMake changes are needed when TEXTURES grows.
set(TEX_BLOB_BIN     "${CMAKE_SOURCE_DIR}/generated/textures.bin")
set(TEX_BLOB_S       "${CMAKE_SOURCE_DIR}/generated/tex_blob.S")
set(TEX_BLOB_TABLE   "${CMAKE_SOURCE_DIR}/generated/tex_blob_table.c")
set(TEX_BLOB_TABLE_H "${CMAKE_SOURCE_DIR}/generated/tex_blob_table.h")

file(GLOB_RECURSE SOURCE_PNG_FILES "${CMAKE_SOURCE_DIR}/assets/*/textures/*.png")

add_custom_command(
    OUTPUT "${TEX_BLOB_BIN}" "${TEX_BLOB_S}" "${TEX_BLOB_TABLE}" "${TEX_BLOB_TABLE_H}"
    COMMAND "${Python3_EXECUTABLE}" -u "${CMAKE_SOURCE_DIR}/py_convert_textures.py"
    DEPENDS ${SOURCE_PNG_FILES} "${CMAKE_SOURCE_DIR}/py_convert_textures.py"
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
    COMMENT "Converting PNG textures into a concatenated TIM blob"
)
add_custom_target(convert_textures
    DEPENDS "${TEX_BLOB_BIN}" "${TEX_BLOB_S}" "${TEX_BLOB_TABLE}" "${TEX_BLOB_TABLE_H}"
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
# 3. Build PS1 executable (main.c + generated blob table + blob .S)
# ------------------------------------------------------------
# tex_blob.S replaces the old hand-maintained tim_face.S - it's now fully
# generated (see py_convert_textures.py), so it's added as a source here
# the same way any other generated .c file would be, not tracked as a
# committed hand-written file. tex_blob_table.c likewise.
psn00bsdk_add_executable(template GPREL
    main.c
    "${TEX_BLOB_S}"
    "${TEX_BLOB_TABLE}"
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