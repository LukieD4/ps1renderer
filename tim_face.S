/*
 * Embeds the TIM texture into the ELF as a contiguous .rodata blob.
 *
 * CMake injects FACE_TIM_PATH as an absolute path, so .incbin can
 * reliably open the file regardless of the assembler's working directory.
 *
 * face_tim_start / face_tim_end form a byte range that main.c can treat
 * as a raw TIM file in memory.
 */

    .section .rodata
    .align 4

    .global face_tim_start
face_tim_start:
    .incbin FACE_TIM_PATH

    .global face_tim_end
face_tim_end:
