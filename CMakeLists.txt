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
# 1. Asset conversion pipeline (OBJ + TIM + stage.json -> generated/)
# ------------------------------------------------------------
# ONE atomic custom command runs all three conversion scripts in their
# required order (assets -> textures -> stages). This replaces the old
# three-separate-targets scheme, which had a fatal flaw: Ninja ran the
# three targets IN PARALLEL, but py_convert_assets.py WIPES generated/
# on startup - so whenever assets re-ran, it could delete the texture
# blob and stage files that the other two steps had just written (or
# that Ninja had already stat'ed as "up to date"), leaving generated/
# half-populated by the time main.c compiled. Running the scripts by
# hand in order never hit this, which is why manual runs were flawless.
#
# Folding them into one command makes the race impossible by
# construction: the wipe and every regeneration happen inside a single
# build edge, so generated/ is always either fully old or fully new.
# The lost incrementality is negligible - the wipe already meant any
# assets re-run forced the other two to re-run anyway.
#
# NOTE: file(GLOB ...) runs at CMake CONFIGURE time, which is BEFORE
# the scripts have ever produced anything on a clean checkout - so we
# glob SOURCE files (which already exist in the repo), not generated
# output. CONFIGURE_DEPENDS makes Ninja re-run CMake automatically when
# a source file is ADDED or REMOVED (same mechanism as the .vag glob in
# section 3b) - without it, a newly added .obj/.tim/stage.json was
# invisible until a manual reconfigure, so conversions silently didn't
# re-run and main.c hit missing symbols.
#
# Textures: the script consumes hand-authored .tim files (see
# py_convert_textures.py's header) - the old glob watched *.png only,
# so re-exporting a .tim never retriggered conversion. Both are watched
# now (.png kept since PaletteGen's source art lives alongside).
file(GLOB_RECURSE SOURCE_OBJ_FILES   CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/assets/object/*.obj")
file(GLOB_RECURSE SOURCE_MTL_FILES   CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/assets/object/*.mtl")
file(GLOB_RECURSE SOURCE_TIM_FILES   CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/assets/object/*/textures/*.tim")
file(GLOB_RECURSE SOURCE_PNG_FILES   CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/assets/object/*/textures/*.png")
file(GLOB_RECURSE SOURCE_STAGE_FILES CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/assets/stage/*/stage.json")

# Deletion/rename safety net: Ninja only re-runs a custom command when a
# DEPENDS file is NEWER, so merely REMOVING a source file (model deleted/
# renamed) would leave the stamp "up to date" and stale .c files in
# generated/. Writing the current source list to a manifest (only when
# its content actually changes, via copy_if_different, so mtime is
# preserved otherwise) and depending on it closes that hole: any
# add/remove reconfigures (CONFIGURE_DEPENDS), changes the manifest, and
# dirties the pipeline.
set(CONVERT_MANIFEST "${CMAKE_BINARY_DIR}/convert_sources_manifest.txt")
string(JOIN "\n" CONVERT_MANIFEST_CONTENT
    ${SOURCE_OBJ_FILES} ${SOURCE_MTL_FILES}
    ${SOURCE_TIM_FILES} ${SOURCE_PNG_FILES}
    ${SOURCE_STAGE_FILES}
)
file(WRITE "${CONVERT_MANIFEST}.tmp" "${CONVERT_MANIFEST_CONTENT}\n")
execute_process(COMMAND "${CMAKE_COMMAND}" -E copy_if_different
    "${CONVERT_MANIFEST}.tmp" "${CONVERT_MANIFEST}"
)

# py_convert_textures.py emits FOUR fixed-path artifacts regardless of
# how many textures are discovered:
#   - generated/textures.bin      the concatenated TIM blob
#   - generated/tex_blob.S        fixed .incbin of textures.bin
#   - generated/tex_blob_table.c  offset/length/paletteCount table
#   - generated/tex_blob_table.h  TEX_BLOB_ENTRY struct + externs,
#                                  #included by main.c - must be an
#                                  OUTPUT below so a clean checkout has
#                                  a dependency edge saying it exists
#                                  before main.c compiles.
# They double as canaries: py_convert_assets.py's wipe deletes them, so
# if the pipeline ever dies mid-run, the missing OUTPUTs force a re-run
# on the next build instead of silently building against half a
# generated/ dir.
set(TEX_BLOB_BIN     "${CMAKE_SOURCE_DIR}/generated/textures.bin")
set(TEX_BLOB_S       "${CMAKE_SOURCE_DIR}/generated/tex_blob.S")
set(TEX_BLOB_TABLE   "${CMAKE_SOURCE_DIR}/generated/tex_blob_table.c")
set(TEX_BLOB_TABLE_H "${CMAKE_SOURCE_DIR}/generated/tex_blob_table.h")

set(CONVERT_STAMP "${CMAKE_BINARY_DIR}/conversion_pipeline.stamp")

add_custom_command(
    OUTPUT "${CONVERT_STAMP}"
        "${TEX_BLOB_BIN}" "${TEX_BLOB_S}" "${TEX_BLOB_TABLE}" "${TEX_BLOB_TABLE_H}"
    COMMAND "${Python3_EXECUTABLE}" -u "${CMAKE_SOURCE_DIR}/py_convert_assets.py"
    COMMAND "${Python3_EXECUTABLE}" -u "${CMAKE_SOURCE_DIR}/py_convert_textures.py"
    COMMAND "${Python3_EXECUTABLE}" -u "${CMAKE_SOURCE_DIR}/py_convert_stages.py"
    COMMAND "${CMAKE_COMMAND}" -E touch "${CONVERT_STAMP}"
    DEPENDS
        ${SOURCE_OBJ_FILES} ${SOURCE_MTL_FILES}
        ${SOURCE_TIM_FILES} ${SOURCE_PNG_FILES}
        ${SOURCE_STAGE_FILES}
        "${CONVERT_MANIFEST}"
        "${CMAKE_SOURCE_DIR}/py_convert_assets.py"
        "${CMAKE_SOURCE_DIR}/py_convert_textures.py"
        "${CMAKE_SOURCE_DIR}/py_convert_stages.py"
    WORKING_DIRECTORY "${CMAKE_SOURCE_DIR}"
    COMMENT "Converting assets (OBJ -> C, TIM -> blob, stage.json -> C)"
)

# convert_everything is the entry point; the old per-step names are kept
# as aliases for muscle memory - they all run the same atomic pipeline.
add_custom_target(convert_everything DEPENDS "${CONVERT_STAMP}")
add_custom_target(convert_assets     DEPENDS "${CONVERT_STAMP}")
add_custom_target(convert_textures   DEPENDS "${CONVERT_STAMP}")
add_custom_target(convert_stages     DEPENDS "${CONVERT_STAMP}")

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