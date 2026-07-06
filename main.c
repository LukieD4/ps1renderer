// root/main.c

/*
 * PSn00bSDK - OBJ Model Renderer (GTE version)
 *
 * Current features:
 * - Filled triangle rendering
 * - OBJ importer support
 * - Runtime scaling
 * - XYZ rotation (GTE-driven)
 * - GTE perspective projection
 * - GTE backface culling (gte_nclip)
 * - GTE-rotated face normals for flat lighting
 * - GTE-rotated vertex normals for Gouraud lighting
 * - Textured polygon rendering (POLY_FT3)
 * - Painter's Algorithm depth sorting (CPU, no OT yet)
 * - Double buffering
 *
 */

// Toolchain paths (set these as env vars on your machine, not hardcoded
// here - PATH, PSN00BPS1_TOOLS, PSN00BSDK_LIBS). See py_convert_textures.py
// and py_convert_dirty_assets.py for the asset-side equivalents.

#include <stdio.h>
#include <sys/types.h>

#include <psxetc.h>
#include <psxgte.h>
#include <psxgpu.h>
#include <psxapi.h>   // BIOS API: InitPAD, StartPAD, ChangeClearPAD, etc.
#include <psxpad.h>   // PadButton enums (PAD_UP, PAD_DOWN, PAD_LEFT, PAD_RIGHT)
#include <inline_c.h> // GTE macros (gte_ldv0, gte_rtpt, gte_nclip, etc.)


// #include "assets_c/house.c"
#include "assets_c/ball.c" // textured
// #include "assets_c/3shapes.c"
// #include "assets_c/honda.c"

// Raw TIM bytes, baked into the ELF via tim_face.S's `.incbin`. Declared
// as uint32_t to match GetTimInfo()'s expected `const uint32_t *` param -
// the original uint8_t[] declaration compiled with a pointer-type warning
// since psxgpu.h declares GetTimInfo(const uint32_t *tim, ...). The actual
// byte layout is unaffected (TIM data is just raw bytes either way); this
// only changes what type the pointer claims to point to.
extern const uint32_t face_tim_start[];



// Screen consts (for model placement)
#define DISPLAY_W 320
#define DISPLAY_H 240

#define SCREEN_CX (DISPLAY_W / 2)
#define SCREEN_CY (DISPLAY_H / 2)



// Camera
#define CAMERA_DISTANCE 4096
#define FOCAL_LENGTH    256
int fov = FOCAL_LENGTH;
int fov_speed = 10;

// Maximum number of vertices we cache for transformed model.
// Bumped from 127 -> 512 for Option B vertex-splitting at seams: a split
// model's vertex count can exceed its raw OBJ 'v' count (each hard-edge
// seam duplicates a position per distinct normal/UV it's used with). Check
// the converter's printed "Split vertex count" against this on each
// model swap - if a model ever exceeds 512, bump this again.
#define MAX_MODEL_VERTS 512

// Maximum number of triangles we cache for sorting/lighting.
#define MAX_MODEL_TRIS 256


// FPS (not currently wired up - counter/timer exist but nothing
// increments or prints them yet; see debug_text()'s commented-out line)
int fps = 0;
int fps_counter = 0;
int fps_timer = 0;



// Double buffering
// Define display/draw environments for double buffering
DISPENV disp[2];
DRAWENV draw[2];
int db;



// Gamepad buffers (BIOS pad driver style)
static unsigned char padbuf[2][34];

// Previous frame's raw pad state, used for edge detection on toggle
// buttons (TRIANGLE/SQUARE) so a held button doesn't re-toggle every
// single frame (60x/sec) - only the released->pressed transition fires.
unsigned short prevPadRaw = 0xFFFF; // all-released, matches BIOS idle state



// Model state
// Runtime scale (divisor for fixed-point model coords)
int model_scale = 32;
const uint8_t SCALE_SPEED = 1;
const uint8_t ROT_SPEED = 22;

// XYZ rotation angles, fed straight into RotMatrix() as an SVECTOR.
// 12-bit fixed-point angle format (4096 = 360 degrees).
SVECTOR model_rot = { 0, 0, 0 };

// GTE rotation matrix, rebuilt once per frame from model_rot.
MATRIX world_matrix;

// Screen-space output from gte_stsxy3, one DVECTOR triple per triangle.
DVECTOR screenVerts[3];

// Projected Z values (one per vertex of current tri), used for the
// near-plane skip and as the depth key (gte_avsz3) - this is also exactly
// what a future Ordering Table step would consume directly.
uint32_t projectedZ[3];

// Rotated face normal cache (one per triangle, post-transform).
// Index-matches modelFaceNormals (and modelTris) 1:1 - both arrays
// come from the same .obj export, so tri i's normal lives at [i] here.
SVECTOR transformedNormals[MAX_MODEL_TRIS];

// Rotated VERTEX normal cache (one per unique vertex position,
// post-transform). Index-matches modelVertNormals/modelVerts 1:1.
// Built once per frame in update_matrix() alongside the face normals,
// then looked up per-triangle-corner in draw_model() for Gouraud shading.
SVECTOR transformedVertNormals[MAX_MODEL_VERTS];

// Average view-space Z per triangle. Filled in by sort_model(),
// used as the sort key for the Painter's Algorithm.
int triDepth[MAX_MODEL_TRIS];

// Draw order: holds triangle indices (into modelTris/transformedNormals),
// sorted back-to-front by triDepth. draw_model() walks this array instead
// of walking modelTris in raw file order.
unsigned int triDrawOrder[MAX_MODEL_TRIS];

// Resolved TPAGE/CLUT values for the loaded face texture, computed once in
// load_texture() from whatever VRAM coordinates the TIM file itself
// carries (set at img2tim conversion time via -org/-plt). draw_model()'s
// textured path reads these every frame via setTPage()/setUV3() rather
// than recomputing them - they don't change unless the texture is
// reloaded, so there's no reason to repeat the GetTimInfo() work per-frame.
TIM_IMAGE faceTexture;



void load_texture(void)
{
    // Parses the embedded TIM header (from face_tim_start[], baked in via
    // tim_face.S's .incbin) into faceTexture - this populates
    // faceTexture.prect/paddr (pixel data + its VRAM rect) and
    // faceTexture.crect/caddr (CLUT data + its VRAM rect) by reading the
    // TIM file's own embedded coordinates, i.e. whatever -org/-plt values
    // were passed to img2tim at conversion time. We don't hardcode VRAM
    // coordinates a second time here - the TIM file is the source of truth.
    GetTimInfo(face_tim_start, &faceTexture);

    // Upload pixel data to VRAM at the rect the TIM specifies.
    LoadImage(faceTexture.prect, faceTexture.paddr);

    // Upload CLUT data to VRAM at the rect the TIM specifies. 4-bit TIMs
    // always carry a CLUT (16 colors); this would be skipped for a 24-bit
    // direct-color TIM, but we're 4-bit here so crect/caddr are always set.
    if (faceTexture.crect != 0)
        LoadImage(faceTexture.crect, faceTexture.caddr);

    // Make sure both uploads have actually landed in VRAM before any
    // draw call tries to sample from them.
    DrawSync(0);
}



void init(void)
{
    // Reset GPU and install ISR subsystem
    ResetGraph(0);

    // Reset and enable the GTE. Must happen before any gte_* macro use.
    InitGeom();

    // Screen-space offset (where projected X=0,Y=0 lands on screen) and
    // projection plane distance. Replaces manual "SCREEN_CX + (vx*FOV)/z"
    // math that would otherwise be done by hand in draw_model().
    gte_SetGeomOffset(SCREEN_CX, SCREEN_CY);
    gte_SetGeomScreen(FOCAL_LENGTH);

    // Define display environments, first on top and second on bottom
    SetDefDispEnv(&disp[0], 0,   0, DISPLAY_W, DISPLAY_H);
    SetDefDispEnv(&disp[1], 0, 240, DISPLAY_W, DISPLAY_H);

    // Define drawing environments, first on bottom and second on top
    SetDefDrawEnv(&draw[0], 0, 240, DISPLAY_W, DISPLAY_H);
    SetDefDrawEnv(&draw[1], 0,   0, DISPLAY_W, DISPLAY_H);

    // Set and enable clear color (green background)
    setRGB0(&draw[0], 0, 96, 0);
    setRGB0(&draw[1], 0, 96, 0);
    draw[0].isbg = 1;
    draw[1].isbg = 1;

    // Clear double buffer counter
    db = 0;

    // Apply the GPU environments
    PutDispEnv(&disp[db]);
    PutDrawEnv(&draw[db]);

    // Load debug font
    FntLoad(960, 0);

    // Open up a debug font text stream of 200 characters
    FntOpen(0, 8, 320, 224, 0, 200);

    // Init pad (BIOS driver)
    InitPAD(padbuf[0], 34, padbuf[1], 34);
    StartPAD();

    // Don't clear pad data automatically; we read raw bytes ourselves
    ChangeClearPAD(0);

    // Upload the face texture to VRAM. Must happen after ResetGraph()
    // (which resets/clears VRAM) but can otherwise go anywhere in init();
    // placed last here just so pad/font setup isn't visually blocked by it.
    load_texture();
}


void display(void)
{
    // Flip buffer index
    db = !db;

    // Wait for all drawing to complete
    DrawSync(0);

    // Wait for vertical sync to cap the logic to 60fps (or 50 in PAL mode)
    VSync(0);

    // Switch pages
    PutDispEnv(&disp[db]);
    PutDrawEnv(&draw[db]);

    // Enable display output, ResetGraph() disables it by default
    SetDispMask(1);
}


uint8_t use_vertex_light = 1;

// Textured-polygon toggle - independent of use_vertex_light so you can
// A/B "textured" against either flat or Gouraud shading rather than the
// texture forcing one specific lighting mode. When on, draw_model() takes
// the POLY_FT3 path and ignores the flat/Gouraud branches entirely for
// color (brightness still modulates the sampled texture, see draw_model()).
uint8_t use_texture = 0;

// Read pad and update model scale/rotation
void update(void)
{
    // padbuf[0] = first controller
    // bytes 2-3 contain button bits (little endian, 0 = pressed)
    unsigned short raw =
        *(unsigned short *)(padbuf[0] + 2);

    // BIOS pad driver uses 0 = pressed, 1 = released.
    // PadButton enums (PAD_UP, etc.) are bit masks where 1 = that button.
    // So we test with ! (pressed when bit is 0).
    

    // Scale
    if (!(raw & PAD_UP)) model_scale -= SCALE_SPEED;
    if (!(raw & PAD_DOWN)) model_scale += SCALE_SPEED;
    if (model_scale < 1) model_scale = 1; // Clamp, avoids crash

    // XYZ rotation - 12-bit fixed-point angles (4096 = 360 degrees), so
    // the value space is circular, not bounded. A bitmask wrap (mod 4096,
    // since 4096 is a power of two) keeps rotation continuous through the
    // wraparound instead of snapping/popping at the boundary.
    if (!(raw & PAD_L1)) model_rot.vx -= ROT_SPEED;
    if (!(raw & PAD_R1)) model_rot.vx += ROT_SPEED;
    model_rot.vx &= 4095;

    if (!(raw & PAD_L2)) model_rot.vz -= ROT_SPEED;
    if (!(raw & PAD_R2)) model_rot.vz += ROT_SPEED;
    model_rot.vz &= 4095;

    if (!(raw & PAD_LEFT)) model_rot.vy -= ROT_SPEED;   // rotate left
    if (!(raw & PAD_RIGHT)) model_rot.vy += ROT_SPEED;   // rotate right
    model_rot.vy &= 4095;

    // FOV
    if (!(raw & PAD_CROSS)) fov += fov_speed;
    if (!(raw & PAD_CIRCLE)) fov -= fov_speed;
    if (fov > 65535) fov = 0;
    if (fov < -65535) fov = 65536;

    // Lighting mode toggle - only fire on the frame TRIANGLE goes from
    // released to pressed (bit was 1 last frame, is 0 this frame), not
    // on every frame it's held down.
    if (!(raw & PAD_TRIANGLE) && (prevPadRaw & PAD_TRIANGLE))
        use_vertex_light = use_vertex_light ^ 1;

    // Texture toggle - same edge-detected pattern as above.
    if (!(raw & PAD_SQUARE) && (prevPadRaw & PAD_SQUARE))
        use_texture = use_texture ^ 1;

    prevPadRaw = raw;
}


// Build this frame's rotation matrix and load it into the GTE.
// Replaces the old transform_model(): instead of pre-rotating every
// vertex and normal into a cached array up front, we just build the
// matrix once and let gte_rtps/gte_rtv0 do the per-vertex/per-normal work
// on demand inside draw_model(). This also sets the translation vector
// to the camera distance, so gte_rtps gives us view-space coords directly.
void update_matrix(void)
{
    RotMatrix(&model_rot, &world_matrix);

    // Live FOV: keeps the GTE's projection distance in sync with the
    // fov variable, which update() changes via PAD_CROSS/PAD_CIRCLE.
    gte_SetGeomScreen(FOCAL_LENGTH + fov);

    // Push the model back along Z by CAMERA_DISTANCE.
    world_matrix.t[0] = 0;
    world_matrix.t[1] = 0;
    world_matrix.t[2] = CAMERA_DISTANCE;

    gte_SetRotMatrix(&world_matrix);
    gte_SetTransMatrix(&world_matrix);

    // Rotate face normals using the same matrix. SVECTOR normals don't
    // need translation, so this writes into transformedNormals using
    // gte_rtv0 (rotate-only) rather than gte_rtps (rotate+translate+project).
    for (unsigned int i = 0; i < modelTriCount && i < MAX_MODEL_TRIS; i++)
    {
        gte_ldv0(&modelFaceNormals[i]);
        gte_rtv0();
        gte_stsv(&transformedNormals[i]);
    }

    if (use_vertex_light)
    {
        // Rotate per-vertex normals (modelVertNormals, one per split
        // vertex from the OBJ's vn data - see py_convert_dirty_assets.py).
        // Same rotate-only GTE call as above, just walking modelVertCount
        // instead of modelTriCount since this is one normal per unique
        // vertex slot rather than one per triangle.
        for (unsigned int i = 0; i < modelVertCount && i < MAX_MODEL_VERTS; i++)
        {
            gte_ldv0(&modelVertNormals[i]);
            gte_rtv0();
            gte_stsv(&transformedVertNormals[i]);
        }
    }
}


// Painter's Algorithm: compute each triangle's view-space depth and
// produce a back-to-front draw order. No Ordering Table yet (that's a
// future, hardware-assisted version of this same idea) - this is the
// plain CPU sort so triangles overlap correctly without one.
//
// Depth is derived by running each triangle's vertices through the GTE
// (gte_rtpt + gte_avsz3) rather than reading from a pre-rotated cache,
// since the GTE now rotates on demand instead of into a buffer up front.
void sort_model(void)
{
    for (unsigned int i = 0; i < modelTriCount && i < MAX_MODEL_TRIS; i++)
    {
        MODEL_TRI *tri = &modelTris[i];

        gte_ldv3(
            &modelVerts[tri->v0],
            &modelVerts[tri->v1],
            &modelVerts[tri->v2]
        );
        gte_rtpt();

        // gte_avsz3 gives the averaged, scaled Z of the three loaded
        // vertices in the OTZ register; pull it out with gte_stotz.
        gte_avsz3();
        gte_stotz(&triDepth[i]);

        triDrawOrder[i] = i;
    }

    // Simple insertion sort, descending by depth (farthest/largest Z
    // first, so painting proceeds back-to-front). Insertion sort is fine
    // here: triangle order barely changes frame-to-frame during rotation,
    // so each frame is close to an O(n) pass rather than O(n^2).
    unsigned int triCount = modelTriCount < MAX_MODEL_TRIS ? modelTriCount : MAX_MODEL_TRIS;

    for (unsigned int i = 1; i < triCount; i++)
    {
        unsigned int currentTri = triDrawOrder[i];
        int currentDepth = triDepth[currentTri];

        int j = i - 1;
        while (j >= 0 && triDepth[triDrawOrder[j]] < currentDepth)
        {
            triDrawOrder[j + 1] = triDrawOrder[j];
            j--;
        }
        triDrawOrder[j + 1] = currentTri;
    }
}


// Draw filled triangles for the transformed model.
// Walks triDrawOrder (built by sort_model) instead of modelTris directly,
// so triangles paint back-to-front - Painter's Algorithm.
//
// Rotation + projection + backface cull are all done per-triangle via
// the GTE rather than from a pre-transformed vertex/normal cache.
void draw_model(void)
{
    static POLY_F3 polyF;
    static POLY_G3 polyG;
    static POLY_FT3 polyFT;

    unsigned int triCount = modelTriCount < MAX_MODEL_TRIS ? modelTriCount : MAX_MODEL_TRIS;

    for (unsigned int order = 0; order < triCount; order++)
    {
        unsigned int i = triDrawOrder[order];

        MODEL_TRI *tri = &modelTris[i];

        // Load the three model-space vertices and run them through
        // rotate + translate + perspective (gte_rtpt = the "triple"
        // version of gte_rtps, does all 3 verts in one call).
        gte_ldv3(
            &modelVerts[tri->v0],
            &modelVerts[tri->v1],
            &modelVerts[tri->v2]
        );
        gte_rtpt();

        // gte_nclip computes the cross product of the screen-space
        // triangle:
        //   MAC0 = SX0*SY1 + SX1*SY2 + SX2*SY0 - SX0*SY2 - SX1*SY0 - SX2*SY1
        // same winding test as a manual cross-product backface cull.
        // gte_stopz reads MAC0 (COP2 register $24) back into a C variable.
        gte_nclip();

        int32_t cross;
        gte_stopz(&cross);

        if (cross <= 0)
            continue;

        // Pull projected screen XY for all 3 vertices in one go.
        gte_stsxy3(&screenVerts[0], &screenVerts[1], &screenVerts[2]);

        // Near-plane reject: gte_rtpt already divides by Z internally,
        // so rather than checking raw Z here we rely on the SZ (screen Z)
        // values pulled via gte_stsz3 for the "too close, skip" check.
        uint32_t sz0, sz1, sz2;
        gte_stsz3(&sz0, &sz1, &sz2);

        if (sz0 < 64 || sz1 < 64 || sz2 < 64)
            continue;

        if (use_texture)
        {
            // Textured path: samples modelUVs[] (byte-scaled 0-255 PS1 GPU
            // coords, written by the converter from the OBJ's vt data) and
            // binds the face texture's TPAGE/CLUT, resolved once in
            // load_texture() from the TIM file's own embedded VRAM coords.
            //
            // Uses the flat (one-normal-per-triangle) brightness calc
            // rather than per-vertex Gouraud - this keeps the textured
            // path independent of use_vertex_light for now. A
            // textured+Gouraud (POLY_GT3) combination is a possible
            // future variant but isn't wired up here.
            setPolyFT3(&polyFT);

            SVECTOR *n = &transformedNormals[i];

            int brightness = n->vz >> 2;
            if (brightness < 0)
                brightness = -brightness;
            if (brightness > 255)
                brightness = 255;
            brightness += 32;
            if (brightness > 255)
                brightness = 255;

            // RGB here MODULATES the texture's own sampled color (GPU
            // multiplies texel color by this RGB) rather than replacing
            // it - same brightness value as the flat path, just applied
            // as a tint instead of a literal fill color.
            setRGB0(&polyFT, brightness, brightness, brightness);

            setXY3(
                &polyFT,
                screenVerts[0].vx, screenVerts[0].vy,
                screenVerts[1].vx, screenVerts[1].vy,
                screenVerts[2].vx, screenVerts[2].vy
            );

            // tri->uv0/uv1/uv2 index into modelUVs[][2] (converter-emitted,
            // split-vertex space - same index space as tri->v0/v1/v2).
            setUV3(
                &polyFT,
                modelUVs[tri->uv0][0], modelUVs[tri->uv0][1],
                modelUVs[tri->uv1][0], modelUVs[tri->uv1][1],
                modelUVs[tri->uv2][0], modelUVs[tri->uv2][1]
            );

            // TPAGE/CLUT resolved once at texture-load time, not
            // recomputed per-triangle - faceTexture.mode is the
            // color-depth bits GetTimInfo() already decoded from the TIM
            // header, so this reuses that instead of hardcoding bpp/abr
            // a second time here.
            setTPage(&polyFT, faceTexture.mode & 0x3, 0, faceTexture.prect->x, faceTexture.prect->y);
            setClut(&polyFT, faceTexture.crect->x, faceTexture.crect->y);

            DrawPrim((uint32_t *)&polyFT);
        }
        else if (use_vertex_light)
        {
            // Gouraud path: one brightness per vertex, looked up from
            // transformedVertNormals via this triangle's own vertex
            // indices (tri->v0/v1/v2 - same indices used to load
            // positions above). The GPU interpolates between these 3
            // colors across the triangle face in hardware.
            setPolyG3(&polyG);

            SVECTOR *nv0 = &transformedVertNormals[tri->v0];
            SVECTOR *nv1 = &transformedVertNormals[tri->v1];
            SVECTOR *nv2 = &transformedVertNormals[tri->v2];

            int b0 = nv0->vz >> 2;
            int b1 = nv1->vz >> 2;
            int b2 = nv2->vz >> 2;

            if (b0 < 0) b0 = -b0;
            if (b1 < 0) b1 = -b1;
            if (b2 < 0) b2 = -b2;

            b0 += 32; if (b0 > 255) b0 = 255;
            b1 += 32; if (b1 > 255) b1 = 255;
            b2 += 32; if (b2 > 255) b2 = 255;

            setRGB0(&polyG, b0, b0, b0);
            setRGB1(&polyG, b1, b1, b1);
            setRGB2(&polyG, b2, b2, b2);

            setXY3(
                &polyG,
                screenVerts[0].vx, screenVerts[0].vy,
                screenVerts[1].vx, screenVerts[1].vy,
                screenVerts[2].vx, screenVerts[2].vy
            );

            DrawPrim((uint32_t *)&polyG);
        }
        else
        {
            // Flat path: one color per triangle, from the precomputed,
            // GTE-rotated face normal built in update_matrix().
            setPolyF3(&polyF);

            SVECTOR *n = &transformedNormals[i];

            int brightness = n->vz >> 2;
            if (brightness < 0)
                brightness = -brightness;
            if (brightness > 255)
                brightness = 255;
            brightness += 32;
            if (brightness > 255)
                brightness = 255;

            setRGB0(&polyF, brightness, brightness, brightness);

            setXY3(
                &polyF,
                screenVerts[0].vx, screenVerts[0].vy,
                screenVerts[1].vx, screenVerts[1].vy,
                screenVerts[2].vx, screenVerts[2].vy
            );

            DrawPrim((uint32_t *)&polyF);
        }
    }
}


// Print debug text to the screen
void debug_text(int counter)
{
    FntPrint(-1, "OBJ MODEL TEST (GTE)\n");
    FntPrint(-1, "FRAME=%d\n", counter);

    FntPrint(-1, "SCALE=%d\n", model_scale);
    // NOTE: this prints FOCAL_LENGTH+fov as if it's the live projection
    // distance, but see the comment above update() - fov currently isn't
    // fed back into gte_SetGeomScreen(), so this number moves while the
    // actual FOV does not. Either wire fov into the GTE each frame or
    // drop it from this readout until that's done.
    FntPrint(-1, "FOV=%d\n", FOCAL_LENGTH+fov);
    FntPrint(-1, "ROTX=%d\n", model_rot.vx);
    FntPrint(-1, "ROTY=%d\n", model_rot.vy);
    FntPrint(-1, "ROTZ=%d\n", model_rot.vz);
    FntPrint(-1, "VERTEXLIGHTING=%d\n", use_vertex_light);
    FntPrint(-1, "TEXTURED=%d\n", use_texture);
    // FPS not wired up yet - fps_counter/fps_timer are declared but
    // nothing increments them, so this stays commented out rather than
    // printing a value that's permanently 0.
    // FntPrint(-1, "FPS=%d\n", fps);
}


// Main function, program entrypoint
int main(int argc, const char *argv[])
{
    int counter = 0;

    init();

    while (1)
    {
        update();

        // Build this frame's rotation matrix and load it into the GTE
        // (replaces the old transform_model() vertex/normal pre-pass)
        update_matrix();

        // Depth-sort triangles back-to-front (Painter's Algorithm)
        sort_model();

        // Draw model (rotation + projection + backface cull all via GTE)
        draw_model();

        debug_text(counter);

        // Draw text LAST so it paints on top of the model's primitives
        // instead of being drawn first and then covered by them - text
        // and primitives both just append to the same GPU command
        // sequence for this frame, so whatever's issued last ends up on top.
        FntFlush(-1);

        display();

        counter++;
    }

    return 0;
}