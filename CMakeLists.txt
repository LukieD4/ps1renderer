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
file(GLOB_RECURSE SOURCE_OBJ_FILES "${CMAKE_SOURCE_DIR}/assets/object/*.obj")
file(GLOB_RECURSE SOURCE_MTL_FILES "${CMAKE_SOURCE_DIR}/assets/object/*.mtl")

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
# of how many textures are discovered under assets/object/*/textures/:
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

file(GLOB_RECURSE SOURCE_PNG_FILES "${CMAKE_SOURCE_DIR}/assets/object/*/textures/*.png")

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
# 1c. stage.json -> C stage data
# ------------------------------------------------------------
# Same stamp-file reasoning as convert_assets above (py_convert_stages.py's
# outputs - stage_common.h, stage_registry.c, per-stage stage_<name>.c,
# stages_all.h - aren't known at CMake configure time on a clean
# checkout). Stage objects only reference model names as plain strings,
# resolved at RUNTIME by main.c (see find_model_index_by_name()), so this
# doesn't strictly need to run after convert_assets to produce correct
# output - kept as a separate stage anyway (not folded into convert_assets)
# so a stage-only edit doesn't force re-parsing every .obj in assets/object/.
file(GLOB_RECURSE SOURCE_STAGE_FILES "${CMAKE_SOURCE_DIR}/assets/stage/*/stage.json")

set(STAGES_STAMP "${CMAKE_BINARY_DIR}/stages_converted.stamp")

add_custom_command(
    OUTPUT "${STAGES_STAMP}"
    COMMAND "${Python3_EXECUTABLE}" -u "${CMAKE_SOURCE_DIR}/py_convert_stages.py"
    COMMAND "${CMAKE_COMMAND}" -E touch "${STAGES_STAMP}"
    DEPENDS ${SOURCE_STAGE_FILES} "${CMAKE_SOURCE_DIR}/py_convert_stages.py"
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
    COMMENT "Converting stage.json files into C stage data"
)
add_custom_target(convert_stages
    DEPENDS "${STAGES_STAMP}"
)

# ------------------------------------------------------------
# 2b. Combined "convert everything" target
# ------------------------------------------------------------
# Single entry point that runs every conversion pass in the correct
# order (assets before textures, per py_convert_textures.py's own
# "Run after py_convert_assets.py!" comment; stages can run independently
# of both but is included here too) - lets you type one target name
# instead of remembering which of the three to run, or in which order.
add_custom_target(convert_everything
    DEPENDS convert_assets convert_textures convert_stages
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
    sound.c
    sfx.c
    music.c
    "${TEX_BLOB_S}"
    "${TEX_BLOB_TABLE}"
)

# sound.c pulls in the SPU and CD-ROM libraries. The default template only
# referenced psxgpu/psxgte/psxetc/psxapi/psxpad (linked implicitly); psxspu and
# psxcd must be linked explicitly now that we upload samples and read the VAG
# off the disc.
target_link_libraries(template PRIVATE psxspu psxcd)

# Ensure both conversion pipelines complete before building the executable
add_dependencies(template convert_everything)

# ------------------------------------------------------------
# 3b. assets/sound/*.vag -> iso.xml (sound file entries)
# ------------------------------------------------------------
# py_convert_sounds.py expands iso.xml.template's placeholder into one
# <file> entry per discovered assets/sound/**/*.vag and writes iso.xml -
# so a new sample lands on the disc by just existing (EDIT THE TEMPLATE,
# not iso.xml). This must run at CONFIGURE time, not build time:
# psn00bsdk_add_cd_image() reads/configures iso.xml when CMake runs, so a
# build-time regeneration would always be one configure behind.
#
# CONFIGURE_DEPENDS on the glob makes Ninja/Make re-run CMake (and thus
# this script) automatically whenever a .vag is added or removed; editing
# the template or the script also retriggers via CMAKE_CONFIGURE_DEPENDS.
file(GLOB_RECURSE SOURCE_VAG_FILES CONFIGURE_DEPENDS
    "${CMAKE_SOURCE_DIR}/assets/sound/*.vag" "${CMAKE_SOURCE_DIR}/assets/sound/*.VAG"
    "${CMAKE_SOURCE_DIR}/assets/sound/music/*.vab" "${CMAKE_SOURCE_DIR}/assets/sound/music/*.VAB"
    "${CMAKE_SOURCE_DIR}/assets/sound/music/*.seq" "${CMAKE_SOURCE_DIR}/assets/sound/music/*.SEQ"
)
list(REMOVE_DUPLICATES SOURCE_VAG_FILES) # case-insensitive filesystems match both patterns

set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS
    "${CMAKE_SOURCE_DIR}/iso.xml.template"
    "${CMAKE_SOURCE_DIR}/py_convert_sounds.py"
)

execute_process(
    COMMAND "${Python3_EXECUTABLE}" -u "${CMAKE_SOURCE_DIR}/py_convert_sounds.py"
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
    RESULT_VARIABLE CONVERT_SOUNDS_RESULT
)
if(NOT CONVERT_SOUNDS_RESULT EQUAL 0)
    message(FATAL_ERROR "py_convert_sounds.py failed (bad/duplicate .vag name under assets/sound/?) - see output above")
endif()

# ------------------------------------------------------------
# 4. Build ISO
# ------------------------------------------------------------
psn00bsdk_add_cd_image(
    iso
    template
    iso.xml
    DEPENDS template system.cnf
        ${SOURCE_VAG_FILES} # .vag samples AND music .vab/.seq pairs (see the glob above)
)

# ------------------------------------------------------------
# 5. Run target
# ------------------------------------------------------------
add_custom_target(run
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_SOURCE_DIR}/py_run_duckstation.py" "${CMAKE_BINARY_DIR}/template.cue"
    DEPENDS iso
    WORKING_DIRECTORY "${CMAKE_BINARY_DIR}"
)