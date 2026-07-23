// animation.c - skeletal animation runtime. See animation.h for the contract
// and ANIMATION_ACTION_PLAN.md for the design. All math is integer/fixed
// point; rotations use ONE==4096, translations the 1024 model-coordinate scale.

#include <string.h>          // strcmp (clip lookup by name)
#include "animation.h"

// One 60Hz reference tick == 1/60s, matching main.c's DT_ONE. A clip authored
// at fps frames/sec advances one frame every (DT_ONE*60 / fps) ticks; the
// constant below is DT_ONE*60, the ticks-per-second in this unit.
#define ANIM_TICKS_PER_SEC 15360   // DT_ONE(256) * 60

// ------------------------------------------------------------------
// Small fixed-point helpers
// ------------------------------------------------------------------

// Integer square root (32-bit). Used only to renormalise a blended quaternion
// a handful of times per bone per frame - not perf critical.
static unsigned int isqrt32(unsigned int x)
{
    unsigned int res = 0;
    unsigned int bit = 1u << 30;
    while (bit > x) bit >>= 2;
    while (bit)
    {
        if (x >= res + bit) { x -= res + bit; res = (res >> 1) + bit; }
        else                { res >>= 1; }
        bit >>= 2;
    }
    return res;
}

// Unit quaternion (components at ONE==4096) -> 3x3 rotation into m->m, also at
// ONE==4096. Standard q->matrix; every product is kept in 4096 scale with a
// >>12 after each multiply so the result lands back in that scale.
static void quat_to_matrix(int qx, int qy, int qz, int qw, MATRIX *m)
{
    int xx = (qx * qx) >> 12, yy = (qy * qy) >> 12, zz = (qz * qz) >> 12;
    int xy = (qx * qy) >> 12, xz = (qx * qz) >> 12, yz = (qy * qz) >> 12;
    int wx = (qw * qx) >> 12, wy = (qw * qy) >> 12, wz = (qw * qz) >> 12;

    m->m[0][0] = (short)(4096 - 2 * (yy + zz));
    m->m[0][1] = (short)(2 * (xy - wz));
    m->m[0][2] = (short)(2 * (xz + wy));
    m->m[1][0] = (short)(2 * (xy + wz));
    m->m[1][1] = (short)(4096 - 2 * (xx + zz));
    m->m[1][2] = (short)(2 * (yz - wx));
    m->m[2][0] = (short)(2 * (xz - wy));
    m->m[2][1] = (short)(2 * (yz + wx));
    m->m[2][2] = (short)(4096 - 2 * (xx + yy));
}

// Shortest-arc nlerp of two quaternions (each 4 contiguous shorts, x,y,z,w)
// at frac (0..4096 == weight of b), renormalised to ONE==4096. Visually
// indistinguishable from slerp at these rates and far cheaper. Used both for
// keyframe interpolation (a/b = &BONE_KEY.qx) and cross-fade blends
// (a/b = BONE_LOCAL.q). Safe if the output aliases either input.
static void quat_nlerp4(const short *a, const short *b, int frac,
                        int *ox, int *oy, int *oz, int *ow)
{
    int ax = a[0], ay = a[1], az = a[2], aw = a[3];
    int bx = b[0], by = b[1], bz = b[2], bw = b[3];

    // Take the shorter arc: flip b if the quats point opposite ways.
    if (ax * bx + ay * by + az * bz + aw * bw < 0)
    {
        bx = -bx; by = -by; bz = -bz; bw = -bw;
    }

    int inv = 4096 - frac;
    int x = (ax * inv + bx * frac) >> 12;
    int y = (ay * inv + by * frac) >> 12;
    int z = (az * inv + bz * frac) >> 12;
    int w = (aw * inv + bw * frac) >> 12;

    // Renormalise: len = sqrt(x^2+y^2+z^2+w^2) is |q|*4096; scale back to 4096.
    unsigned int ss = (unsigned int)(x * x + y * y + z * z + w * w);
    int len = (int)isqrt32(ss);
    if (len < 1) len = 1;
    *ox = (x << 12) / len;
    *oy = (y << 12) / len;
    *oz = (z << 12) / len;
    *ow = (w << 12) / len;
}

// out = a * b, full affine compose (rotation 3x3 at 4096, translation at the
// 1024 vertex scale). out.t = a.m * b.t + a.t. Matches the hand-rolled compose
// in main.c's update_object_world_and_compose(). Safe if out aliases neither
// input (callers pass distinct storage).
static void compose(const MATRIX *a, const MATRIX *b, MATRIX *out)
{
    for (int r = 0; r < 3; r++)
        for (int c = 0; c < 3; c++)
            out->m[r][c] = (short)(
                ((int)a->m[r][0] * b->m[0][c] +
                 (int)a->m[r][1] * b->m[1][c] +
                 (int)a->m[r][2] * b->m[2][c]) >> 12);

    for (int r = 0; r < 3; r++)
        out->t[r] =
            (((int)a->m[r][0] * b->t[0] +
              (int)a->m[r][1] * b->t[1] +
              (int)a->m[r][2] * b->t[2]) >> 12) + a->t[r];
}

// Evaluate a clip at timeTicks into per-bone LOCAL poses (nlerp'd quaternion +
// lerp'd translation), WITHOUT composing the hierarchy. Cross-fade blends at
// this level. loop selects wrap vs clamp-at-end.
static void eval_local(const ANIM_CLIP *clip, int timeTicks, int loop,
                       int boneCount, BONE_LOCAL *out)
{
    int fc = clip->frameCount;
    if (fc < 1) return;
    int tpf = ANIM_TICKS_PER_SEC / clip->fps;
    if (tpf < 1) tpf = 1;
    int frame = timeTicks / tpf;
    int frac  = ((timeTicks % tpf) * 4096) / tpf;

    int f0, f1;
    if (loop)               { frame %= fc; f0 = frame; f1 = (frame + 1) % fc; }
    else if (frame >= fc-1) { f0 = f1 = fc - 1; frac = 0; }
    else                    { f0 = frame; f1 = frame + 1; }

    for (int b = 0; b < boneCount; b++)
    {
        const BONE_KEY *k0 = &clip->keys[b * fc + f0];
        const BONE_KEY *k1 = &clip->keys[b * fc + f1];
        int qx, qy, qz, qw;
        quat_nlerp4(&k0->qx, &k1->qx, frac, &qx, &qy, &qz, &qw);
        out[b].q[0] = (short)qx; out[b].q[1] = (short)qy;
        out[b].q[2] = (short)qz; out[b].q[3] = (short)qw;
        out[b].t[0] = k0->tx + (((k1->tx - k0->tx) * frac) >> 12);
        out[b].t[1] = k0->ty + (((k1->ty - k0->ty) * frac) >> 12);
        out[b].t[2] = k0->tz + (((k1->tz - k0->tz) * frac) >> 12);
    }
}

// out = blend of a and b, wB = weight of b (0..4096). Rotation via shortest-arc
// nlerp, translation linear. In-place safe (out may alias a or b).
static void blend_local(const BONE_LOCAL *a, const BONE_LOCAL *b, int wB,
                        int boneCount, BONE_LOCAL *out)
{
    int wA = 4096 - wB;
    for (int i = 0; i < boneCount; i++)
    {
        int qx, qy, qz, qw;
        quat_nlerp4(a[i].q, b[i].q, wB, &qx, &qy, &qz, &qw);
        out[i].q[0] = (short)qx; out[i].q[1] = (short)qy;
        out[i].q[2] = (short)qz; out[i].q[3] = (short)qw;
        out[i].t[0] = (a[i].t[0] * wA + b[i].t[0] * wB) >> 12;
        out[i].t[1] = (a[i].t[1] * wA + b[i].t[1] * wB) >> 12;
        out[i].t[2] = (a[i].t[2] * wA + b[i].t[2] * wB) >> 12;
    }
}

// Compose per-bone local poses down the (parents-first) hierarchy and fold in
// each bone's inverse bind, producing the model-space skin matrices.
static void compose_pose(const MODEL_DEF *m, const BONE_LOCAL *local,
                         int boneCount, MATRIX *boneMtx)
{
    static MATRIX global[ANIM_MAX_BONES];
    for (int b = 0; b < boneCount; b++)
    {
        MATRIX L;
        quat_to_matrix(local[b].q[0], local[b].q[1], local[b].q[2], local[b].q[3], &L);
        L.t[0] = local[b].t[0]; L.t[1] = local[b].t[1]; L.t[2] = local[b].t[2];

        short parent = m->bones[b].parent;
        if (parent < 0) global[b] = L;
        else            compose(&global[parent], &L, &global[b]);

        compose(&global[b], &m->bones[b].invBind, &boneMtx[b]);
    }
}

// Current LOCAL pose for st, accounting for an in-progress cross-fade (blends
// the live clip pose back toward the fade snapshot by the remaining weight).
static void eval_current_local(const ANIM_STATE *st, int boneCount, BONE_LOCAL *out)
{
    const MODEL_DEF *m = st->model;
    eval_local(&m->clips[st->clip], st->timeTicks, st->loop, boneCount, out);
    if (st->fadeRemaining > 0 && st->fadeTicks > 0)
    {
        // weight of the OLD pose (fadeFrom): 4096 at the switch, 0 at fade end.
        int wFrom = (st->fadeRemaining << 12) / st->fadeTicks;
        blend_local(out, st->fadeFrom, wFrom, boneCount, out);
    }
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

void anim_init(ANIM_STATE *st, const MODEL_DEF *model, int clip)
{
    st->model         = model;
    st->timeTicks     = 0;
    st->speed         = 4096;
    st->playing       = 1;
    st->fadeTicks     = 0;
    st->fadeRemaining = 0;
    // Only bind a clip if the model actually carries a rig with that clip.
    if (model && model->bones && model->clipCount > 0 &&
        clip >= 0 && (unsigned int)clip < model->clipCount)
    {
        st->clip = clip;
        st->loop = model->clips[clip].loop;   // seed from the clip; overridable
    }
    else
    {
        st->clip = -1;
        st->loop = 1;
    }
}

void anim_set_clip(ANIM_STATE *st, int clip)
{
    const MODEL_DEF *m = st->model;
    if (!m || !m->bones || m->clipCount == 0) return;
    if (clip < 0 || (unsigned int)clip >= m->clipCount) return;
    st->clip = clip;
    st->timeTicks = 0;
}

int anim_find_clip(const MODEL_DEF *model, const char *name)
{
    if (!model || !model->bones || !name) return -1;
    for (unsigned int i = 0; i < model->clipCount; i++)
        if (model->clips[i].name && strcmp(model->clips[i].name, name) == 0)
            return (int)i;
    return -1;
}

void anim_advance(ANIM_STATE *st, int dtTicks)
{
    if (!st->playing || st->clip < 0) return;

    // Progress any cross-fade first (independent of the clip clock).
    if (st->fadeRemaining > 0)
    {
        st->fadeRemaining -= dtTicks;
        if (st->fadeRemaining < 0) st->fadeRemaining = 0;
    }

    const ANIM_CLIP *clip = &st->model->clips[st->clip];
    int tpf = ANIM_TICKS_PER_SEC / clip->fps;   // ticks per clip frame
    if (tpf < 1) tpf = 1;
    int durTicks = clip->frameCount * tpf;       // one full loop, in ticks

    // Scale delta by playback speed (4096 == 1.0x).
    st->timeTicks += (dtTicks * st->speed) >> 12;

    // Keep timeTicks BOUNDED. On the R3000 `int`/`long` are 32-bit, so an
    // unbounded clock would overflow the frame math within hours of play; the
    // downstream frame index is also computed with plain 32-bit ops on the
    // strength of this. Looping clips wrap; one-shots clamp at the final frame.
    if (st->loop)
    {
        if (durTicks > 0)
        {
            st->timeTicks %= durTicks;
            if (st->timeTicks < 0) st->timeTicks += durTicks;
        }
    }
    else
    {
        if (st->timeTicks < 0)        st->timeTicks = 0;
        if (st->timeTicks > durTicks) st->timeTicks = durTicks;
    }
}

void anim_evaluate(const ANIM_STATE *st, MATRIX *boneMtx)
{
    const MODEL_DEF *m = st->model;
    if (!m || !m->bones || st->clip < 0) return;

    int boneCount = m->boneCount;
    if (boneCount > ANIM_MAX_BONES) boneCount = ANIM_MAX_BONES;

    // Current local pose (cross-fade folded in), then compose to skin matrices.
    static BONE_LOCAL cur[ANIM_MAX_BONES];
    eval_current_local(st, boneCount, cur);
    compose_pose(m, cur, boneCount, boneMtx);
}

void anim_crossfade(ANIM_STATE *st, int clip, int fadeTicks)
{
    const MODEL_DEF *m = st->model;
    if (!m || !m->bones || m->clipCount == 0) return;
    if (clip < 0 || (unsigned int)clip >= m->clipCount) return;
    if (clip == st->clip && st->fadeRemaining == 0) return;   // already there

    int boneCount = m->boneCount;
    if (boneCount > ANIM_MAX_BONES) boneCount = ANIM_MAX_BONES;

    if (fadeTicks > 0 && st->clip >= 0)
    {
        // Snapshot the pose we're leaving (blended, if a fade was in progress)
        // and blend from it into the new clip over fadeTicks.
        eval_current_local(st, boneCount, st->fadeFrom);
        st->fadeTicks     = fadeTicks;
        st->fadeRemaining = fadeTicks;
    }
    else
    {
        st->fadeRemaining = 0;   // hard cut
    }

    st->clip      = clip;
    st->timeTicks = 0;
    st->loop      = m->clips[clip].loop;
}

void anim_skin_vertices(const MODEL_DEF *model, const MATRIX *boneMtx, SVECTOR *out)
{
    unsigned int vertCount = model->vertCount;
    const SVECTOR   *verts = model->verts;
    const VERT_SKIN *skin  = model->vertSkin;

    for (unsigned int i = 0; i < vertCount; i++)
    {
        int vx = verts[i].vx, vy = verts[i].vy, vz = verts[i].vz;

        const MATRIX *S0 = &boneMtx[skin[i].bone0];
        int x0 = ((S0->m[0][0]*vx + S0->m[0][1]*vy + S0->m[0][2]*vz) >> 12) + S0->t[0];
        int y0 = ((S0->m[1][0]*vx + S0->m[1][1]*vy + S0->m[1][2]*vz) >> 12) + S0->t[1];
        int z0 = ((S0->m[2][0]*vx + S0->m[2][1]*vy + S0->m[2][2]*vz) >> 12) + S0->t[2];

        int w0 = skin[i].w0;
        if (w0 >= 255)
        {
            out[i].vx = (short)x0;
            out[i].vy = (short)y0;
            out[i].vz = (short)z0;
            continue;
        }

        // 2-bone linear blend, done in MODEL SPACE (before projection) so the
        // blend is correct under perspective.
        const MATRIX *S1 = &boneMtx[skin[i].bone1];
        int x1 = ((S1->m[0][0]*vx + S1->m[0][1]*vy + S1->m[0][2]*vz) >> 12) + S1->t[0];
        int y1 = ((S1->m[1][0]*vx + S1->m[1][1]*vy + S1->m[1][2]*vz) >> 12) + S1->t[1];
        int z1 = ((S1->m[2][0]*vx + S1->m[2][1]*vy + S1->m[2][2]*vz) >> 12) + S1->t[2];

        int w1 = 255 - w0;
        out[i].vx = (short)((x0 * w0 + x1 * w1) / 255);
        out[i].vy = (short)((y0 * w0 + y1 * w1) / 255);
        out[i].vz = (short)((z0 * w0 + z1 * w1) / 255);
    }
}

// Rotate a bind normal (nx,ny,nz) by the ROTATION part of skin matrix S,
// keeping the 1024 normal scale. Translation is deliberately ignored - a
// normal is a direction.
#define ROT_N(S,ax) ( ((S)->m[ax][0]*nx + (S)->m[ax][1]*ny + (S)->m[ax][2]*nz) >> 12 )

// Renormalise (x,y,z) back to length 1024 and store into an SVECTOR. Lighting
// (gte_ncs) scales by normal length, so keeping unit-ish length keeps shading
// even after a 2-bone blend shortens the vector.
static void store_unit_normal(int x, int y, int z, SVECTOR *out)
{
    int len = (int)isqrt32((unsigned int)(x * x + y * y + z * z));
    if (len < 1) len = 1;
    out->vx = (short)((x * 1024) / len);
    out->vy = (short)((y * 1024) / len);
    out->vz = (short)((z * 1024) / len);
}

void anim_skin_normals(const MODEL_DEF *model, const MATRIX *boneMtx,
                       SVECTOR *outVertN, SVECTOR *outFaceN)
{
    const VERT_SKIN *skin = model->vertSkin;

    // Per-vertex normals: rotate by the vertex's bone(s), 2-bone blend.
    // PERF: a single bone's rotation is length-preserving (orthonormal up to
    // fixed-point drift), so the 1-bone case - the large majority of vertices -
    // skips the integer sqrt entirely and stores the rotated normal directly.
    // Only the 2-bone BLEND, which genuinely shortens the vector, renormalises.
    unsigned int vertCount = model->vertCount;
    const SVECTOR *vn = model->vertNormals;
    for (unsigned int i = 0; i < vertCount; i++)
    {
        int nx = vn[i].vx, ny = vn[i].vy, nz = vn[i].vz;
        const MATRIX *S0 = &boneMtx[skin[i].bone0];
        int rx = ROT_N(S0, 0), ry = ROT_N(S0, 1), rz = ROT_N(S0, 2);
        int w0 = skin[i].w0;
        if (w0 >= 255)
        {
            outVertN[i].vx = (short)rx; outVertN[i].vy = (short)ry; outVertN[i].vz = (short)rz;
            continue;
        }
        const MATRIX *S1 = &boneMtx[skin[i].bone1];
        int x1 = ROT_N(S1, 0), y1 = ROT_N(S1, 1), z1 = ROT_N(S1, 2);
        int w1 = 255 - w0;
        store_unit_normal((rx * w0 + x1 * w1) / 255,
                          (ry * w0 + y1 * w1) / 255,
                          (rz * w0 + z1 * w1) / 255, &outVertN[i]);
    }

    // Per-face normals: faces carry no skin, so rotate by the triangle's first
    // vertex's dominant bone (a single rotation - length-preserving, no sqrt).
    unsigned int triCount = model->triCount;
    const SVECTOR   *fn   = model->faceNormals;
    const MODEL_TRI *tris = model->tris;
    for (unsigned int i = 0; i < triCount; i++)
    {
        int nx = fn[i].vx, ny = fn[i].vy, nz = fn[i].vz;
        const MATRIX *S = &boneMtx[skin[tris[i].v0].bone0];
        outFaceN[i].vx = (short)ROT_N(S, 0);
        outFaceN[i].vy = (short)ROT_N(S, 1);
        outFaceN[i].vz = (short)ROT_N(S, 2);
    }
}

#undef ROT_N
