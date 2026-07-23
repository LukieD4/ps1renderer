/*
 * stage_state.js
 *
 * Central editor state, mirroring palette-maker's "PaletteManager" class
 * pattern: one class instance holds all mutable editor state, and every
 * mutation goes through a method on this class so app.js's updateUI()
 * has a single, predictable source of truth to re-render from.
 *
 * Units note: instance/camera pos/rot/scale stored here are in VIEWPORT
 * space, i.e. the same Blender-equivalent, un-remapped, unscaled units the
 * artist sees in the 3D viewport (1 unit == 1 Blender/OBJ unit). The
 * PS1-space remap and the *1024 scale to integer stage.json units only
 * happen at export time, in stage_export.js. Keeping raw viewport units
 * here means the viewport, OrbitControls, and TransformControls all just
 * work in a single consistent space without back-and-forth conversions
 * during editing.
 */

/**
 * Registry of the hardcoded, editor-native object kinds that can be
 * inserted into the Instances tree WITHOUT any model asset backing them
 * - game-logic markers (spawn points, trigger volumes, ...) rather than
 * renderable geometry. One entry per kind:
 *
 *   label:  display name (row labels, insert menu, properties header)
 *   hint:   one-liner shown in the insert menu
 *   color:  CSS color for the tree row dot / matches the viewport
 *           helper's color (viewer.js keeps its own copy as a Three.js
 *           hex - update both if you change one)
 *   props:  ordered schema the Properties panel renders editors from:
 *           { key, label, type: 'bool' | 'int' | 'number' | 'string',
 *             default } - plus `uniqueId: '<namespace>'` on fields that
 *             must hold an auto-assigned unique integer.
 *
 * UNIQUE ID NAMESPACES. A prop marked `uniqueId: 'spawn'` draws from the
 * spawn counter, `uniqueId: 'sound'` from the sound counter, and so on.
 * Each namespace is an independent dense integer sequence, minted on
 * creation and RE-minted on duplicate/paste so a copy is never born
 * colliding with its source.
 *
 * Spawn and Summon deliberately SHARE the 'spawn' namespace - they are both
 * "somewhere an actor appears" and game logic addresses them from one pool.
 * Sound has its own, because a sound emitter and a spawn point are
 * unrelated things that would only collide by accident if pooled.
 * (This was `uniqueSpawnId: true` when spawns were the only case; it became
 * a named namespace the moment a second kind needed one, rather than
 * growing a parallel uniqueSoundId flag and a third copy after that.)
 *
 * NOTE: these are deliberately NOT exported into stage.json yet - the
 * PS1 runtime has no loader for them (all "tbd"). They persist in the
 * .StageGen project file (format v3) only, so authoring can start now
 * and the exporter can pick them up whenever main.c grows support.
 */
export const ENTITY_KINDS = {
  trigger: {
    // Volume that DOES something when the player enters it. The kind is
    // deliberately open-ended - a trigger is the generic "something happens
    // here" marker, and the list of somethings will grow - so the behaviour
    // is a single-select `action` rather than a pile of tickboxes, the same
    // shape Sound's Play Mode and Light's Light Type use. Per-action fields
    // are showIf-gated so an author only sees what the chosen action needs.
    //
    // DEFAULT IS 'none' ON PURPOSE. A freshly placed trigger should be
    // inert: it marks a volume and does nothing until told otherwise.
    // Defaulting to a real action would mean dropping a trigger to sketch
    // out a region silently wires up a scene switch.
    label: 'Trigger',
    hint: 'Volume that performs an action when entered',
    color: '#ff8c42',
    props: [
      { key: 'action', label: 'Action', type: 'select', default: 'none',
        options: [
          { value: 'none',        label: 'Nothing' },
          { value: 'switchScene', label: 'Switch Scene' },
        ] },
      // Free-text name for this trigger, resolved by nothing today. Kept
      // visible for every action: it is how a trigger is identified in the
      // debug overlay and how a future generic-event system will address
      // it, so it is useful even on an action:none marker.
      { key: 'event', label: 'Event Name', type: 'string', default: '' },
      // Switch Scene: destination stage FOLDER NAME (the assets/stage/<name>
      // directory, which is what stageRegistry[] is keyed by). Free text,
      // resolved late at runtime - same philosophy as model names and sound
      // samples, and it means authoring a door doesn't depend on stage
      // ordering, which changes whenever a folder is added.
      { key: 'targetStage', label: 'Target Stage (folder name)', type: 'string', default: '',
        showIf: (props) => props.action === 'switchScene' },
      // Which Spawn in the destination the player arrives at. This is the
      // reason spawnIds are addressable: a door should deposit the player at
      // its own doorway on the far side, not at the destination's front
      // entrance. An id that doesn't exist there falls back to the lowest
      // one at runtime rather than dumping the player at world zero.
      { key: 'targetSpawnId', label: 'Arrive at Spawn ID', type: 'int', default: 0,
        showIf: (props) => props.action === 'switchScene' },
      // Sound played the moment the door fires, in THIS stage, as the fade
      // begins - a door creak, a footstep on gravel. References a Sound
      // entity by its soundId; -1 is "(None)".
      //
      // LIVE DROPDOWN, not a static option list: optionsFrom is re-evaluated
      // every time the panel renders, so adding, renaming or deleting a
      // Sound is reflected immediately without touching the trigger.
      //
      // THE SOUND MUST BE IN THIS STAGE. There is no matching "after you
      // arrive" field, and that is deliberate rather than an omission: the
      // source stage's samples are freed by sfx_stage_unload() during the
      // load, so a sound from here physically cannot play once the player
      // has arrived somewhere else. A destination-side arrival sound is
      // simply a fire-once Sound entity in that stage, which already works.
      //
      // Bounded by the fade length: the trigger fires, then teardown keys
      // every voice off ~16 frames later, so a sample longer than the fade
      // gets cut off. Lengthen TRANSITION_FADE_SPEED in main.c for more room.
      { key: 'onEnterSoundId', label: 'Upon Enter SFX', type: 'select', default: -1,
        numericValue: true,
        showIf: (props) => props.action === 'switchScene',
        optionsFrom: (state) => [
          { value: -1, label: '(None)' },
          ...state.listTriggerableSounds().map((s) => ({
            value: s.soundId,
            label: s.label,
          })),
        ] },
      // HOW the trigger activates, as opposed to what it does - so it sits
      // at the top level alongside `once` rather than under any one action.
      //
      // ON  : the player must be inside the volume AND press CROSS. The
      //       volume becomes a prompt - "there is a door here" - and
      //       entering it commits to nothing.
      // OFF : fires the moment the player walks in (the original behaviour).
      //
      // DEFAULT ON, deliberately: walking into a volume and being teleported
      // without asking is startling, and a door you press to open reads as a
      // decision rather than an accident. Automatic entry is still the right
      // answer for things the player shouldn't be able to decline - a
      // cutscene boundary, a point of no return - which is what OFF is for.
      //
      // NOTE this changes behaviour for triggers authored BEFORE the field
      // existed: they had no choice but to fire on entry, and will now want
      // CROSS. Untick this to restore the old feel on any of them.
      { key: 'userInteract', label: 'User Interact (press X)', type: 'bool', default: true },
      // Fire a single time vs. every entry. Meaningful for every action, so
      // it stays visible regardless.
      { key: 'once', label: 'Fire Once', type: 'bool', default: true },
    ],
  },
  postprocess: {
    // Volume that changes HOW THE FRAME IS RENDERED while the player is
    // inside it. The PS1 has no programmable shaders, so every effect here is
    // built from the fixed-function operations the GPU does have: full-screen
    // semi-transparent quads (the same mechanism main.c's fog layers already
    // use), CLUT row swaps, and VRAM-to-VRAM framebuffer copies.
    //
    // ONE VOLUME, SEVERAL TOGGLEABLE EFFECTS - not one effect per volume.
    // The deciding reason is hardware, not ergonomics: Blur and Ghost BOTH
    // need the framebuffer copied into scratch VRAM, and sharing one volume
    // means that copy happens once and both consume it. Split across two
    // volumes, you would either pay for the copy twice or need cross-volume
    // coordination to avoid it. (The region is also the thing being authored
    // - "this room feels like this" - rather than the individual effect.)
    //
    // OVERLAPPING VOLUMES BLEND. Continuous parameters (tint colour and
    // strength, blur, ghost) are weighted by each volume's own falloff
    // weight and summed. `paletteRow` CANNOT blend - averaging row 2 and
    // row 5 into 3.5 is meaningless - so it takes the value of the
    // highest-weighted volume instead. Two rules, deliberately: the
    // alternative is a palette that flickers between rows in overlap zones.
    label: 'Post-Process Volume',
    hint: 'Region that changes how the frame is rendered',
    color: '#5de0c8',
    props: [
      // ---- Boundary behaviour ----
      // HARD pops the effect on and off at the volume's face. EASED ramps it
      // in over `falloff` units, which is what stops a volume reading as a
      // light switch rather than atmosphere.
      { key: 'transition', label: 'Transition', type: 'select', default: 'eased',
        options: [
          { value: 'eased', label: 'Eased (ramp in)' },
          { value: 'hard',  label: 'Hard (on/off)' },
        ] },
      { key: 'falloff', label: 'Falloff Distance', type: 'number', default: 2,
        showIf: (p) => p.transition !== 'hard' },

      // MASTER INTENSITY for the whole volume, as a percentage. Multiplies
      // with the falloff weight rather than replacing it: falloff answers
      // "how far into this volume am I", intensity answers "how strong is
      // this volume at full depth". One dial to take a whole region up or
      // down without retuning tint layers, blur and ghost separately.
      //
      // Above 100 is allowed and useful - it lets a volume push past what
      // its individual amounts author, which is the quickest way to find the
      // right level before dialling the parts back in.
      { key: 'intensity', label: 'Intensity %', type: 'int', default: 100 },

      // ---- Colour tint ----
      // A full-screen blend quad. `tintMode` picks the GPU's semi-transparency
      // mode (the ABR bits), which is where the character of the effect comes
      // from far more than the colour does:
      //   Blend 50%   - glass, haze, general wash
      //   Additive    - fire, light bloom, heat
      //   Subtractive - shadow, grime, dread. The one people forget.
      //   Additive 1/4- subtle bloom that doesn't blow out
      { key: 'tintEnabled', label: 'Colour Tint', type: 'bool', default: false },
      // withRgbFields renders three 0-255 int boxes beside the picker, both
      // editing THIS SAME hex value - two representations of one prop, not
      // two props. A swatch is fine for choosing a mood and useless for
      // hitting an exact value, and PS1 work is full of exact values.
      { key: 'tintColor', label: 'Tint Colour', type: 'color', default: '#804060',
        withRgbFields: true,
        showIf: (p) => p.tintEnabled },
      { key: 'tintMode', label: 'Blend Mode', type: 'select', default: 'blend50',
        showIf: (p) => p.tintEnabled,
        options: [
          { value: 'blend50',     label: 'Blend 50% (B/2 + F/2)' },
          { value: 'additive',    label: 'Additive (B + F)' },
          { value: 'subtractive', label: 'Subtractive (B - F)' },
          { value: 'quarter',     label: 'Additive 1/4 (B + F/4)' },
        ] },
      // Strength is a LAYER COUNT, not an opacity: the GPU's blend modes are
      // fixed ratios, so "more" means drawing the quad again. Each layer is a
      // full-screen fill, which is the real cost - hence the low ceiling.
      { key: 'tintStrength', label: 'Strength (layers)', type: 'int', default: 1,
        showIf: (p) => p.tintEnabled },

      // ---- Blur ----
      // Framebuffer copied to scratch VRAM, then drawn back offset by a pixel
      // or two, semi-transparent, a few times. Shares its scratch copy with
      // Ghost below.
      { key: 'blurEnabled', label: 'Blur', type: 'bool', default: false },
      { key: 'blurAmount', label: 'Blur Amount', type: 'number', default: 0.5,
        showIf: (p) => p.blurEnabled },

      // ---- Ghost / trails ----
      // The PREVIOUS frame drawn back over the current one. Temporal, unlike
      // Blur's spatial offset, but the same scratch buffer and the same quad.
      { key: 'ghostEnabled', label: 'Ghost / Trails', type: 'bool', default: false },
      { key: 'ghostAmount', label: 'Ghost Amount', type: 'number', default: 0.5,
        showIf: (p) => p.ghostEnabled },

      // ---- Palette shift ----
      // Pushes a global CLUT row offset, recolouring every textured surface
      // at once. Free at runtime - no per-pixel cost whatsoever - but it only
      // does anything if the textures actually have extra palette rows
      // authored (see palette-maker).
      { key: 'paletteEnabled', label: 'Palette Shift', type: 'bool', default: false },
      { key: 'paletteRow', label: 'Palette Row', type: 'int', default: 1,
        showIf: (p) => p.paletteEnabled },
    ],
  },
  spawn: {
    label: 'Spawn',
    hint: 'Player/actor spawn point (unique ID)',
    color: '#5dd06a',
    props: [
      { key: 'spawnId', label: 'Spawn ID', type: 'int', default: 0, uniqueId: 'spawn' },
    ],
  },
  summon: {
    label: 'Summon',
    hint: 'NPC spawn with behavior parameters',
    color: '#b06ee0',
    props: [
      { key: 'spawnId', label: 'Spawn ID', type: 'int', default: 0, uniqueId: 'spawn' },
      { key: 'isFriendly', label: 'Is Friendly', type: 'bool', default: false },
      { key: 'patrolRadius', label: 'Patrol Radius', type: 'number', default: 3 },
      { key: 'health', label: 'Health', type: 'int', default: 100 },
      { key: 'canSeeThroughWalls', label: 'Sees Through Walls', type: 'bool', default: false },
    ],
  },
  particle: {
    label: 'Particle',
    hint: 'Effect emitter point',
    color: '#ffd23c',
    props: [
      { key: 'effect', label: 'Effect Name', type: 'string', default: '' },
      { key: 'loop', label: 'Looping', type: 'bool', default: true },
    ],
  },
  billboard: {
    label: 'Billboard',
    hint: 'Camera-facing flat sprite plane',
    color: '#3ec6dc',
    props: [
      { key: 'trackCamera', label: 'Track Camera', type: 'bool', default: true },
      { key: 'pivotAngle', label: 'Pivot Angle (deg)', type: 'number', default: 0 },
      { key: 'seeThroughWalls', label: 'Draw Through Walls', type: 'bool', default: false },
    ],
  },
  sound: {
    // FIRST entity kind the PS1 runtime actually loads: stage_export.js
    // graduates these into stage.json's "sounds" array (unlike every
    // other kind above, which is still project-file-only - see the
    // NOTE on ENTITY_KINDS). Runtime is sfx.c: play modes (loop / once /
    // random interval), optional directional audio (distance falloff
    // inside `radius` + stereo pan, updated per frame from the camera),
    // and mute-after-played (finished sound is forced silent and never
    // retriggers - it stays resident so a future trigger can re-arm it).
    label: 'Sound',
    hint: 'Ambient / one-shot audio emitter',
    color: '#e05d8a',
    props: [
      // Stable per-emitter handle, auto-assigned from the 'sound' namespace.
      // This is what other entities REFERENCE - today a Switch Scene
      // trigger's "Upon Enter SFX", tomorrow anything else that needs to
      // fire a specific emitter.
      //
      // An id rather than the sample name on purpose: a sample name isn't
      // unique (two emitters may deliberately share one upload at different
      // positions - the runtime dedupes the upload but keeps separate
      // voices), and renaming the sample would silently break every
      // reference to it. The id survives renames, reordering and re-export.
      { key: 'soundId', label: 'Sound ID', type: 'int', default: 0, uniqueId: 'sound' },
      // Matched against assets/sound/**/<NAME>.vag by 8.3 uppercase
      // convention at convert time ("wind" -> \WIND.VAG;1). A typo'd or
      // missing sample degrades to silence at runtime and is counted on
      // the debug overlay's SFX UNRESOLVED readout - same free-text,
      // resolve-late philosophy as stage object model names.
      { key: 'sample',   label: 'Sample Name (e.g. WIND, not WIND.VAG)',    type: 'string', default: '' },
      { key: 'volume',   label: 'Volume (0-1)',   type: 'number', default: 0.5 },
      // Mutually exclusive playback behaviors as ONE selector (a set of
      // tickboxes would allow contradictions like loop+once):
      //   loop     - continuous: hardware-looped when the VAG carries loop
      //              flags, otherwise sfx.c re-keys it from the top each
      //              playthrough (software loop) - so Loop ALWAYS loops,
      //              however the sample was encoded
      //   once     - plays a single time at start
      //   interval - re-fires after a random delay in [intervalMin,
      //              intervalMax] seconds (bird caws, distant dog barks)
      //   music    - THIS STAGE'S MUSIC TRACK: the sample name maps to
      //              assets/sound/music/<NAME>.VAB + <NAME>.SEQ (not a
      //              .vag), loaded by music.c at boot for the entered
      //              stage. Position/directional/etc. don't apply - a
      //              music entity is a stage-level marker that happens
      //              to live in the entity tree. First one wins if a
      //              stage authors several.
      { key: 'mode', label: 'Play Mode', type: 'select', default: 'loop',
        options: [
          { value: 'loop',     label: 'Loop' },
          { value: 'once',     label: 'Play Once' },
          { value: 'interval', label: 'Random Interval' },
          { value: 'music',    label: 'Music' },
        ] },
      // Music only: when live stage transitioning lands, cross-fade this
      // track in while the previous stage's music fades out (vs. a hard
      // cut). Baked into STAGE_SOUND now so stages author it ahead of
      // that system existing.
      { key: 'fadeOnStageEnter', label: 'Fade entering new stage', type: 'bool', default: true,
        showIf: (props) => props.mode === 'music' },
      // Seconds before the FIRST play (0 = immediate): loop/once start
      // after the delay; interval schedules its first random fire after
      // it. Hidden for music - the runtime ignores it there today.
      { key: 'delay', label: 'Delay (s)', type: 'number', default: 0,
        showIf: (props) => props.mode !== 'music' },
      // Bounds of the random silence between plays, in seconds. Only
      // meaningful - and only SHOWN (showIf, see renderEntityProps) -
      // in Random Interval mode.
      { key: 'intervalMin', label: 'Interval Min (s)', type: 'number', default: 2,
        showIf: (props) => props.mode === 'interval' },
      { key: 'intervalMax', label: 'Interval Max (s)', type: 'number', default: 8,
        showIf: (props) => props.mode === 'interval' },
      // Distance falloff (inside `radius`) + stereo pan, updated per
      // frame from the camera. Off = constant volume everywhere.
      // Hidden for music (a track has no world position).
      { key: 'directional', label: 'Directional Audio', type: 'bool', default: false,
        showIf: (props) => props.mode !== 'music' },
      // Falloff radius in viewport units for directional sounds;
      // 0 = no distance falloff (pan still applies when directional).
      { key: 'radius',   label: 'Radius (0=global)', type: 'number', default: 0,
        showIf: (props) => props.mode !== 'music' },
      // After the sound has completed one playthrough, force it silent
      // and stop retriggering (loop mode never "finishes", so it
      // ignores this). Sample + voice stay resident for later re-arming.
      // Hidden for music.
      { key: 'muteAfterPlay', label: 'Mute After Played', type: 'bool', default: false,
        showIf: (props) => props.mode !== 'music' },
      { key: 'autoplay', label: 'Autoplay',       type: 'bool',   default: true },
    ],
  },
  light: {
    // Scene light marker. EXPORTED to stage.json (the second kind to
    // graduate after Sound): py_convert_stages.py bakes lights into
    // STAGE_LIGHT[] and main.c's load_stage_lights() consumes DIRECTIONAL
    // (up to 3) + AMBIENT into the GTE's light/colour/back registers.
    // Spherical/spot are carried through the data but await the offline
    // vertex-baking pass before they light anything. Lighting is
    // expensive on PS1 - the GTE natively affords ~3 directional vectors
    // plus one ambient (back) color; spherical/spot are CPU
    // approximations - so `lightType` is a deliberate single-select (like
    // Sound's Play Mode) rather than stackable toggles, and per-type
    // fields are showIf-gated so authors only see what a given type uses.
    label: 'Light',
    hint: 'Scene light (spherical / directional / spot / ambient / debug)',
    color: '#ffe066',
    props: [
      // The type selector. Changing it re-renders the panel (renderEntity
      // Props on a select commit), so the type-specific fields below
      // appear/disappear immediately - same mechanism as Sound's mode.
      { key: 'lightType', label: 'Light Type', type: 'select', default: 'spherical',
        options: [
          { value: 'spherical',   label: 'Spherical Light' },
          { value: 'directional', label: 'Directional Light' },
          { value: 'spot',        label: 'Spot Light' },
          { value: 'ambient',     label: 'Ambient Light' },
          { value: 'debug',       label: 'Debug Light (legacy headlamp)' },
        ] },
      // Disabled: authoring kill switch for THIS light, shown for every
      // type. The light is still EXPORTED to stage.json - it stays in the
      // data and stays AUTHORITATIVE (a disabled directional does not
      // resurrect any default; there is none) - the runtime just skips
      // applying it, and the PS1 viewport preview does the same. Unlike
      // intensity 0 (off but L2-raiseable in DEBUG), a disabled light is
      // immune to the DEBUG intensity editor too: off means off.
      { key: 'disabled', label: 'Disabled', type: 'bool', default: false },
      // Static vs dynamic (spherical/spot only): STATIC lights are destined
      // for the offline vertex bake - evaluated once at convert time into
      // static geometry's vertex colours, zero runtime cost. DYNAMIC lights
      // are computed live per object every frame (they compete for the
      // GTE's free light slots). Until the bake exists the runtime lights
      // BOTH kinds via the live per-object path, so the flag is authored
      // now and stages won't need re-touching when the bake lands.
      // Directional/ambient are GTE-native and always live - hidden there.
      { key: 'mobility', label: 'Mobility', type: 'select', default: 'static',
        showIf: (props) => props.lightType === 'spherical' || props.lightType === 'spot',
        options: [
          { value: 'static',  label: 'Static (bakeable)' },
          { value: 'dynamic', label: 'Dynamic (live)' },
        ] },
      // Color + intensity apply to every type. The viewport tints the
      // marker core with `color` for live feedback; intensity is a plain
      // 0-1 human float py_convert_stages.py scales to fixed point
      // (256 == 1.0), mirroring how Sound's 0-1 volume bakes to the
      // SPU's 0..0x3fff. NOTE: for directionals the runtime's colour
      // scale saturates just past 1.0 - values above ~1.0 clamp, so keep
      // authored intensity in 0-1.
      { key: 'color',     label: 'Color',        type: 'color',  default: '#ffffff' },
      { key: 'intensity', label: 'Intensity (0-1)', type: 'number', default: 1.0 },
      // Spherical + spot: distance falloff radius in viewport units
      // (*1024 at export when this graduates). 0 = no distance falloff.
      // Directional (a sun) and ambient (global) have no position, so it
      // is hidden for them.
      { key: 'range', label: 'Range (0=infinite)', type: 'number', default: 5,
        showIf: (props) => props.lightType === 'spherical' || props.lightType === 'spot' },
      // Spot only: cone half-angle (degrees) + edge softness. Direction is
      // the entity's own -Z, set with the rotation gizmo (the viewport
      // draws a cone + forward pointer), so there is no separate direction
      // field - rotation IS the aim, same convention as Spawn's pointer.
      { key: 'coneAngle', label: 'Cone Angle (deg)', type: 'number', default: 30,
        showIf: (props) => props.lightType === 'spot' },
      { key: 'penumbra', label: 'Edge Softness (0-1)', type: 'number', default: 0.2,
        showIf: (props) => props.lightType === 'spot' },
    ],
  },
};

// ==========================================================================
// STAGE FOG
// ==========================================================================
//
// Fog is a STAGE-LEVEL property, not an entity kind - the same shape as the
// stage camera. main.c's own note (at the `fog_enabled` block) spells out
// the contract this implements:
//
//   "WHEN STAGE-GEN AUTHORS FOG: add enable/near/far/colour to STAGE_DEF,
//    set these globals in load_stage_lights(), and leave the L1+L2 editor
//    writing the same globals as a live override - exactly the pattern the
//    light intensities already use (authored value + live offset)."
//
// So everything here is an AUTHORED DEFAULT the runtime loads at stage load
// and the DEBUG-mode L1+L2 editor may then override live. Nothing here is a
// hard runtime constant.
//
// WHAT IS AUTHORED vs WHAT STAYS COMPILE-TIME
// -------------------------------------------
// Authored (per stage, exported): enabled, near, far, color, layers, cull,
// drift. The first four are main.c's named list; layers/cull/drift are the
// other three runtime globals the pad editor toggles (fog_layers,
// fog_cull_enabled, fog_drift_enabled), and they follow the identical
// "authored value + live override" pattern, so authoring them costs nothing
// and stops every stage booting with the hardcoded 3/off/off.
//
// NOT authored (stays a #define in main.c, mirrored here only for preview
// and validation): FOG_GRAD_TOP/BOTTOM, FOG_DRIFT_SPEED/AMOUNT, and every
// rail (FOG_DQA_RAIL, FOG_SPAN_FLOOR, FOG_NEAR_MIN/FAR_MAX). Those describe
// the GTE's arithmetic limits, not a look - promoting them to stage data
// would let an author write a stage that cannot be rendered.
//
// UNITS. near/far are authored in VIEWPORT units (1 unit == 1 Blender/OBJ
// unit) like every other distance in this editor, and *1024 at export -
// same convention as positions, sound radius and light range. main.c's
// defaults are given in engine units, so they divide by 1024 here:
// fog_near 800 -> 0.781, fog_far 6000 -> 5.859. Both round-trip back to
// EXACTLY 800 / 6000 through Math.round(v * 1024), so a stage that never
// touches these exports byte-identical fog to the compiled-in defaults.
const FOG_UPSCALE = 1024; // mirrors stage_export.js's UPSCALE

/**
 * main.c's fog rails, in ENGINE units (the same numbers the #defines hold).
 * Mirrored rather than re-derived so a change on either side is a visible
 * one-line diff on both.
 */
export const FOG_LIMITS = {
  NEAR_MIN: 64,       // FOG_NEAR_MIN - below this the perspective divide saturates
  FAR_MAX: 32000,     // FOG_FAR_MAX  - far*65536 must stay inside int32 in DQB staging
  DQA_RAIL: 16000,    // FOG_DQA_RAIL - keeps q*DQA inside MAC0's int32 accumulator
  MAX_LAYERS: 6,      // FOG_MAX_LAYERS
  // h = FOCAL_LENGTH + fov. fov is live-tunable in DEBUG mode, so validation
  // here uses main.c's BOOT value (fov initialises to FOCAL_LENGTH), which is
  // the projection an authored stage actually loads with.
  FOCAL_LENGTH: 256,
  DEFAULT_H: 512,
  // Vertical gradient on the fog quads (FOG_GRAD_TOP / FOG_GRAD_BOTTOM),
  // signed offsets applied to the fog colour then clamped 0..255. Preview
  // only - not authored (see the block comment above).
  GRAD_TOP: -10,
  GRAD_BOTTOM: 10,
  // Density drift (FOG_DRIFT_SPEED / FOG_DRIFT_AMOUNT). Drift is ONE-SIDED:
  // it only ever pushes far OUTWARD, never inward, because widening the span
  // can only REDUCE |DQA| - so drift can never walk a rail-safe stage into a
  // railed one behind the author's back.
  DRIFT_SPEED: 180,   // phase units/frame out of 131072 == 360 degrees
  DRIFT_AMOUNT: 384,  // peak span widening, 4096 == 100% (~9%)
};

/** FOG_SPAN_FLOOR(far): span must scale with far or DQB (16777216*far/span)
 *  overflows int32 and the ramp INVERTS. Engine units, both sides. */
function fogSpanFloor(farEngine) {
  const scaled = Math.floor(farEngine / 96);
  return scaled > 64 ? scaled : 64;
}

/**
 * Port of main.c's fog_clamp_range(), operating in ENGINE units and
 * returning a new { near, far } rather than mutating globals.
 *
 * Kept arithmetically identical to the C - including the integer
 * truncations, which are load-bearing: `FOG_DQA_RAIL / 256` is 62 in C, not
 * 62.5, and k is built from that truncated value. Using the exact quotient
 * here would let the tool bless a range the console then rails on.
 *
 * THE CONSTRAINT IS ON FAR, NOT ON SPAN (main.c's derivation): from
 * |DQA| = 256*near*far/(h*span) and |DQA| <= RAIL, with k = RAIL*h/256,
 * far >= near + near^2/(k - near). Every larger far is also fine, so this is
 * a closed form, not a loop.
 */
export function clampFogEngineRange(nearEngine, farEngine, h = FOG_LIMITS.DEFAULT_H) {
  let hh = Math.trunc(h);
  if (hh < 8) hh = 8;

  let k = Math.trunc(FOG_LIMITS.DQA_RAIL / 256) * hh;
  if (k < 1) k = 1;

  let near = Math.trunc(nearEngine);
  let far = Math.trunc(farEngine);

  if (near < FOG_LIMITS.NEAR_MIN) near = FOG_LIMITS.NEAR_MIN;
  if (far > FOG_LIMITS.FAR_MAX) far = FOG_LIMITS.FAR_MAX;

  // Deepest near this projection can serve at all, then re-floor.
  const FM = FOG_LIMITS.FAR_MAX;
  let nearMax = FM - Math.trunc((FM * FM) / (k + FM)) - 1;
  if (nearMax < FOG_LIMITS.NEAR_MIN) nearMax = FOG_LIMITS.NEAR_MIN;
  if (near > nearMax) near = nearMax;

  // Minimum far for that near: the DQA rail bound, then the DQB span floor
  // on top. Two correction passes, exactly as the C does - the floor depends
  // on far, but it only ever moves far by ~1%, so it settles immediately.
  let farMin;
  if (k <= near + 1) farMin = FM;
  else farMin = near + Math.trunc((near * near) / (k - near)) + 1;

  let floorFar = near + fogSpanFloor(farMin);
  if (floorFar > farMin) farMin = floorFar;
  floorFar = near + fogSpanFloor(farMin);
  if (floorFar > farMin) farMin = floorFar;

  if (farMin > FM) farMin = FM;
  if (far < farMin) far = farMin;
  if (far > FM) far = FM;

  return { near, far };
}

/**
 * Same clamp, expressed in VIEWPORT units (what the Properties panel and
 * the viewport preview both work in). Round-trips through the exporter's
 * own Math.round(v * 1024) so what the panel shows is what ships.
 */
export function clampFogViewportRange(nearVp, farVp, h) {
  const clamped = clampFogEngineRange(
    Math.round((nearVp || 0) * FOG_UPSCALE),
    Math.round((farVp || 0) * FOG_UPSCALE),
    h
  );
  return {
    near: clamped.near / FOG_UPSCALE,
    far: clamped.far / FOG_UPSCALE,
  };
}

/**
 * A fresh stage's fog, inherited verbatim from main.c's globals:
 *   fog_enabled       = 0      -> enabled false
 *   fog_near          = 800    -> 0.781 viewport units (exports back to 800)
 *   fog_far           = 6000   -> 5.859 viewport units (exports back to 6000)
 *   FOG_COL_R/G/B     = 128    -> #808080
 *   fog_layers        = 3
 *   fog_cull_enabled  = 0      -> cull false
 *   fog_drift_enabled = 0      -> drift false
 *
 * THE COLOUR IS NOT A FREE CHOICE, and the panel says so. main.c uses it for
 * three things that must never disagree - the GTE far colour, the OT fog
 * quads, and the SCREEN CLEAR colour - and mid-grey specifically is the
 * neutral multiplier for PS1 texture modulation (texel * tint / 128), which
 * is why the depth cue contributes nothing to textured surfaces and the
 * quads exist at all. Moving it off #808080 changes how textured geometry
 * fogs, not just what shade it fogs to.
 */
export const FOG_DEFAULTS = {
  enabled: false,
  near: 800 / FOG_UPSCALE,   // 0.78125
  far: 6000 / FOG_UPSCALE,   // 5.859375
  color: '#808080',
  layers: 3,
  cull: false,
  drift: false,
};

// ---------------------------------------------------------------------------
// Per-instance ANIMATION params (see viewer.js's getModelAnimations()).
//
// These only DO anything for instances whose model is a skinned .glb carrying
// animation clips - a static model ignores them. The editor still stores the
// block on every instance uniformly (like collide) so the serialize/undo/paste
// paths never have to special-case "does this model animate"; the export layer
// is where it's dropped for non-animated / clip-less instances.
//
// Field meanings mirror the runtime's ANIM_STATE (animation.h):
//   clip     - authored default clip NAME, or null for "None" (play nothing).
//              A name, not an index, so re-exporting the .glb with reordered
//              clips doesn't silently repoint every instance (anim_find_clip
//              resolves the name at load).
//   loop     - true = loop, false = play-once-then-hold (ANIM_STATE.loop).
//   speed    - playback rate, 1.0 == authored speed (ANIM_STATE.speed, which
//              the runtime stores as 4096==1.0x; kept as a plain float here and
//              in the JSON, same as scale, for the converter to upscale later).
//   autoplay - true = start playing on spawn, false = sit paused on frame 0
//              (ANIM_STATE.playing).
export const ANIM_DEFAULTS = { clip: null, loop: true, speed: 1, autoplay: true };

/**
 * Coerce any partial/absent anim payload into a complete, well-typed anim
 * block. Used by every instance-construction path (create, duplicate, paste,
 * project load, undo restore) so an instance authored before this field
 * existed - or a hand-edited file - loads with sane defaults rather than
 * `undefined` holes. `!== false` on the booleans means a missing key reads as
 * its default-on value, matching how `collide` is handled elsewhere.
 */
export function normalizeAnim(src) {
  const a = src || {};
  return {
    clip: (typeof a.clip === 'string' && a.clip.length > 0) ? a.clip : null,
    loop: a.loop !== false,
    speed: Number.isFinite(a.speed) && a.speed > 0 ? a.speed : 1,
    autoplay: a.autoplay !== false,
  };
}

export class StageState {
  constructor() {
    // modelName -> { objText, mtlText, materialsMap: Map<matName, decodedTim|null>, dirHandle }
    this.models = new Map();

    // Array of { id, model, palette, name, parentId, pos:{x,y,z}, rot:{x,y,z}, scale:{x,y,z} }
    //   name:     display-only rename override (null = default "model #id"
    //             label). Never used by export - purely for the editor UI.
    //   parentId: id of the folder this instance sits in, or null for the
    //             tree's root level.
    this.instances = [];

    // Display-only grouping folders for the Instances tree:
    // { id, name, parentId, collapsed }. Folders draw ids from the SAME
    // this.nextId counter as instances so a parentId can never be
    // ambiguous between the two kinds. They exist purely to organize the
    // editor's instance list (and are saved in the project file so the
    // organization survives reload) - stage_export.js flattens them away
    // entirely, since the PS1 runtime has no concept of them.
    this.folders = [];

    // Editor-native entities (see ENTITY_KINDS above): array of
    // { id, kind, name, parentId, pos, rot, scale, props }. Same id
    // counter and same tree-parenting rules as instances; props is a
    // flat object matching the kind's schema. Not exported to
    // stage.json (yet) - see ENTITY_KINDS' note.
    this.entities = [];

    // AUTHORED COLLISION BOXES, one array for the whole stage; each entry
    // names the model instance it belongs to:
    //   { id, parentInstanceId, name, colliderId, enabled, center, size }
    //
    // CHILDREN OF AN INSTANCE, not free-standing volumes. `center` is a
    // LOCAL offset from the owning instance's origin and `size` is a full
    // size in that instance's local space, so moving, rotating or scaling
    // the house carries its collision with it and duplicating the house
    // duplicates its boxes. stage_export.js bakes them into world space at
    // export time, which is why main.c does no composition at load.
    //
    // Center/Size rather than min/max deliberately - it is what the gizmo
    // manipulates and what Unity's BoxCollider presents, so the numbers in
    // the panel match the handles in the viewport.
    //
    // WHY A FLAT ARRAY rather than colliders living on the instance object:
    // every one of the nine instance-persistence sites spreads the instance
    // shallowly ({ ...inst } / field-by-field copies), so a nested array
    // would be shared by reference between an instance and its undo
    // snapshot - editing a box after an edit would silently rewrite
    // history. A sibling array with a parent id sidesteps that entirely and
    // matches how folders and entities already relate to the tree.
    this.colliders = [];

    // Collider IDs are their own dense sequence (see the UNIQUE ID
    // NAMESPACES note on ENTITY_KINDS - spawns and sounds each have one).
    // This is what makes a box ADDRESSABLE: the runtime keeps a live
    // enabled flag per collider, so a future trigger action can switch a
    // specific box on or off by id - a door that becomes passable, a
    // barrier that drops. Auto-generated fallback boxes are NOT in this
    // namespace (they export as -1); authoring a box is what earns it an id.
    this.nextColliderId = 0;

    // Next spawn ID handed to a freshly created spawn/summon entity.
    // Spawn IDs are their own sequence (dense small integers the game
    // logic will reference), separate from this.nextId's editor ids.
    this.nextSpawnId = 0;

    // Sound emitters get their own dense id sequence, separate from spawns
    // (see the UNIQUE ID NAMESPACES note on ENTITY_KINDS). This is what a
    // Switch Scene trigger's "Upon Enter SFX" stores, so the reference
    // survives renaming the sample, reordering the tree, or two emitters
    // sharing one sample - none of which a sample-name reference would.
    this.nextSoundId = 0;

    // Default camera: sits back on +Z-ish looking toward the origin from
    // above, pitched down. Since the viewport is Blender-equivalent space
    // (Forward=-Z, Up=Y), a camera at positive Z pointing toward -Z (i.e.
    // toward the objects clustered near the origin) with a downward pitch
    // gives a reasonable "looking at the stage from a 3/4 angle" starting
    // view without requiring the artist to reposition it before doing
    // anything useful.
    this.camera = {
      pos: { x: 0, y: 2, z: 8 },
      rot: { x: -20, y: 0, z: 0 },
    };

    // Stage fog - a stage-level block like `camera` above, NOT an entity
    // (fog has no position; there is exactly one per stage). See FOG_DEFAULTS
    // for what each field inherits from main.c and why the colour is not a
    // free aesthetic choice.
    this.fog = { ...FOG_DEFAULTS };

    this.selectedInstanceId = null;
    // At most ONE of selectedInstanceId / selectedFolderId is non-null at
    // a time - selecting a folder deselects the instance and vice versa
    // (app.js enforces this at every selection site). Folder selection
    // exists so asset placement / New Folder can target the selected folder
    // and so the Delete key has a folder target.
    this.selectedFolderId = null;
    this.nextId = 1;

    // Default directional "sun" - the lighting counterpart to the default
    // camera above. A fresh stage always starts with ONE directional light
    // so authored lighting matches what actually ships: the runtime's
    // load_stage_lights() only steers off authored directionals, otherwise
    // it falls back to its hardcoded sun. Pre-placing this makes that sun
    // visible and editable instead of an invisible default the author can't
    // see. rot.x = -45 (pitched down, aiming from above-and-front) makes its
    // exported direction reproduce that fallback exactly ({0,-2896,-2896}),
    // so a brand-new stage looks identical whether or not this is touched.
    // Loading a project REPLACES entities (app.js), so this is never
    // duplicated onto a saved stage - it only seeds new ones.
    const sun = this.addEntity('light');
    if (sun) {
      sun.name = 'Sun';
      sun.props.lightType = 'directional';
      sun.rot.x = -45;
    }
  }

  /**
   * Register a loaded model's data (called after fs_assets + mtl_resolver
   * have finished loading & decoding a model's .glb + .tim files).
   */
  addModel(name, data) {
    this.models.set(name, data);
  }

  /**
   * Create a new instance of `modelName` with default (or provided)
   * transform, push it into the instances array, and return it.
   */
  addInstance(modelName, initialTransform = {}, parentId = null) {
    const instance = {
      id: this.nextId++,
      model: modelName,
      palette: 0,
      // Solid to the player at runtime. DEFAULTS TRUE: level geometry is
      // overwhelmingly meant to be stood on and bumped into, so the common
      // case should need no action and the exception (foliage, decals,
      // ceiling detail) is what gets ticked off. See COLLISION_ACTION_PLAN.md.
      //
      // Every other place an instance is constructed - duplicate, paste,
      // project load, undo/redo - reads this with `?? true` or `!== false`
      // rather than a bare copy, so an instance authored before this field
      // existed loads solid instead of loading undefined.
      collide: true,
      name: null,
      parentId,
      pos: { x: 0, y: 0, z: 0, ...(initialTransform.pos || {}) },
      rot: { x: 0, y: 0, z: 0, ...(initialTransform.rot || {}) },
      scale: { x: 1, y: 1, z: 1, ...(initialTransform.scale || {}) },
      // Animation defaults (clip=None, so a freshly placed animated model just
      // sits in bind pose until the author picks a default clip). Harmless on
      // static models - the export layer drops it for anything clip-less.
      anim: normalizeAnim(),
    };
    this.instances.push(instance);
    return instance;
  }

  removeInstance(id) {
    const idx = this.instances.findIndex((inst) => inst.id === id);
    if (idx !== -1) {
      this.instances.splice(idx, 1);
    }
    // Cascade: a collider whose owning instance is gone has no local space
    // to be expressed in, so it would export at a meaningless world
    // position. Deleting them here rather than filtering at export keeps
    // "what the tree shows" and "what exists" the same thing.
    this.colliders = this.colliders.filter((c) => c.parentInstanceId !== id);
    if (this.selectedInstanceId === id) {
      this.selectedInstanceId = null;
    }
  }

  /**
   * Clone an existing instance with a new id, inheriting the source's
   * EXACT transform - position, rotation, and scale. (An earlier version
   * offset the clone by +1 on X/Z to make it visibly distinct, but exact
   * inheritance is more useful in practice: the typical flow is
   * duplicate-then-move, often via the surface-snap drag, and a
   * pre-applied offset just meant undoing a placement nobody asked for.
   * The clone is selected on creation, so it's never ambiguous which of
   * the two coincident instances a subsequent drag will move.)
   */
  duplicateInstance(id) {
    const original = this.getInstance(id);
    if (!original) return null;

    const clone = {
      id: this.nextId++,
      model: original.model,
      palette: original.palette,
      collide: original.collide !== false,
      // Keep the custom name verbatim (Roblox Studio does the same on
      // duplicate) - the clone is selected on creation so the two
      // identically-named rows are never ambiguous, and appending "(2)"
      // style suffixes would fight the typical duplicate-rename flow.
      name: original.name,
      parentId: original.parentId,
      pos: { ...original.pos },
      rot: { ...original.rot },
      scale: { ...original.scale },
      // A duplicate of an animated prop should animate identically - carry the
      // whole anim block across (normalizeAnim also backfills a pre-anim source).
      anim: normalizeAnim(original.anim),
    };
    this.instances.push(clone);

    // Carry the collision across. Duplicating a building and getting a
    // solid-looking copy you can walk through would be a nasty surprise,
    // and re-running Auto Box on every copy is exactly the manual work
    // this feature exists to do once. Each clone box mints a FRESH
    // colliderId (addCollider does that) so a trigger toggling the
    // original's box does not toggle the copy's.
    for (const src of this.collidersFor(id)) {
      this.addCollider(clone.id, {
        name: src.name,
        enabled: src.enabled,
        center: { ...src.center },
        size: { ...src.size },
      });
    }

    return clone;
  }

  // ------------------------------------------------------------------
  // Collision boxes (children of a model instance)
  // ------------------------------------------------------------------

  /**
   * Add one collider box to `instanceId`. Defaults to a unit box at the
   * instance's own origin - the "I'll place this myself" case; Auto Box
   * below supplies real bounds instead.
   */
  addCollider(instanceId, init = {}) {
    const collider = {
      id: this.nextId++,
      parentInstanceId: instanceId,
      name: init.name ?? null,
      colliderId: this.nextColliderId++,
      // Solid on creation. This is the INITIAL state only - the runtime
      // flag is live, so a trigger can flip it later without the authored
      // value changing.
      enabled: init.enabled !== false,
      center: { x: 0, y: 0, z: 0, ...(init.center || {}) },
      size: { x: 1, y: 1, z: 1, ...(init.size || {}) },
    };
    this.colliders.push(collider);
    return collider;
  }

  getCollider(id) {
    return this.colliders.find((c) => c.id === id) || null;
  }

  /** Every collider belonging to `instanceId`, in creation order. */
  collidersFor(instanceId) {
    return this.colliders.filter((c) => c.parentInstanceId === instanceId);
  }

  removeCollider(id) {
    const idx = this.colliders.findIndex((c) => c.id === id);
    if (idx !== -1) this.colliders.splice(idx, 1);
    if (this.selectedInstanceId === id) this.selectedInstanceId = null;
  }

  /**
   * Clone a collider onto the same instance, with a FRESH colliderId - a
   * copy that shared its source's id would make a future trigger toggle
   * both, which is never what duplicating a box means.
   */
  duplicateCollider(id) {
    const original = this.getCollider(id);
    if (!original) return null;

    const clone = {
      id: this.nextId++,
      parentInstanceId: original.parentInstanceId,
      name: original.name,
      colliderId: this.nextColliderId++,
      enabled: original.enabled !== false,
      center: { ...original.center },
      size: { ...original.size },
    };
    this.colliders.push(clone);
    return clone;
  }

  /**
   * AUTO BOX. Seed one collider per mesh in the model, fitted to that
   * mesh's own local bounds, named after it.
   *
   * `meshBounds` comes from the viewer (it owns the loaded glTF), as an
   * array of { name, center, size } in the model's local space - one entry
   * per mesh, which is the same granularity py_convert_assets.py bakes its
   * per-primitive bounds at. house.glb therefore seeds a box for the
   * building and a box for its grass plane.
   *
   * A STARTING POINT, NOT AN ANSWER. The grass box will be lawn-sized and
   * flat, and the building's box has no doorway - the intended workflow is
   * to delete what you don't want and drag the rest into shape. That is the
   * whole reason this is authored data now rather than derived every frame.
   *
   * Existing colliders on the instance are REPLACED, so pressing the button
   * twice is idempotent rather than accumulating duplicates.
   */
  autoBoxInstance(instanceId, meshBounds) {
    if (!Array.isArray(meshBounds) || meshBounds.length === 0) return [];

    this.colliders = this.colliders.filter((c) => c.parentInstanceId !== instanceId);

    const made = [];
    for (const b of meshBounds) {
      made.push(this.addCollider(instanceId, {
        name: b.name || null,
        center: b.center,
        size: b.size,
      }));
    }
    return made;
  }

  /**
   * Highest colliderId currently in use, or -1. Used after a project load
   * to re-seat nextColliderId so freshly added boxes can't collide with
   * loaded ones - the same repair pattern spawn/sound ids already use.
   */
  maxColliderId() {
    let max = -1;
    for (const c of this.colliders) {
      if (Number.isFinite(c.colliderId) && c.colliderId > max) max = c.colliderId;
    }
    return max;
  }

  // ------------------------------------------------------------------
  // Folders (display-only grouping for the Instances tree)
  // ------------------------------------------------------------------

  addFolder(parentId = null) {
    const folder = {
      id: this.nextId++,
      name: 'Folder',
      parentId,
      collapsed: false,
    };
    this.folders.push(folder);
    return folder;
  }

  getFolder(id) {
    return this.folders.find((f) => f.id === id) || null;
  }

  /**
   * All folder ids inside `folderId`'s subtree, INCLUDING folderId
   * itself. Iterative breadth-first walk (the loop appends children of
   * ids already collected) so arbitrarily deep nesting never recurses.
   */
  collectFolderIds(folderId) {
    const ids = [folderId];
    for (let i = 0; i < ids.length; i++) {
      for (const folder of this.folders) {
        if (folder.parentId === ids[i]) ids.push(folder.id);
      }
    }
    return ids;
  }

  /** Every instance living anywhere inside `folderId`'s subtree. */
  getFolderInstances(folderId) {
    const folderIds = new Set(this.collectFolderIds(folderId));
    return this.instances.filter((inst) => folderIds.has(inst.parentId));
  }

  /** Total instances + entities inside `folderId`'s subtree (row count
   * badge / delete-confirm sizing, where both kinds matter equally). */
  getFolderContentsCount(folderId) {
    const folderIds = new Set(this.collectFolderIds(folderId));
    return (
      this.instances.filter((inst) => folderIds.has(inst.parentId)).length +
      this.entities.filter((ent) => folderIds.has(ent.parentId)).length
    );
  }

  /**
   * True if `folderId` is inside `ancestorId`'s subtree (including being
   * the same folder). Used by the tree's drag-drop to refuse dropping a
   * folder into itself or one of its own descendants, which would orphan
   * the whole subtree from the root walk.
   */
  isFolderInside(folderId, ancestorId) {
    return this.collectFolderIds(ancestorId).includes(folderId);
  }

  /**
   * Delete a folder AND everything inside it (subfolders, instances,
   * entities), mirroring how Roblox Studio treats folder deletion as
   * subtree deletion. Returns the removed instance AND entity ids so
   * the caller can also remove their viewport representations (both
   * kinds live in the viewer's same tracked-object map).
   */
  removeFolder(id) {
    const folderIds = new Set(this.collectFolderIds(id));

    const removedIds = [];
    this.instances = this.instances.filter((inst) => {
      if (folderIds.has(inst.parentId)) {
        removedIds.push(inst.id);
        return false;
      }
      return true;
    });
    this.entities = this.entities.filter((ent) => {
      if (folderIds.has(ent.parentId)) {
        removedIds.push(ent.id);
        return false;
      }
      return true;
    });

    this.folders = this.folders.filter((f) => !folderIds.has(f.id));

    // Same cascade as removeInstance(): the colliders of every instance
    // that just went with the folder. Done from removedIds rather than by
    // re-walking the tree, because those instances are already gone from
    // this.instances by now.
    const removedSet = new Set(removedIds);
    this.colliders = this.colliders.filter((c) => !removedSet.has(c.parentInstanceId));

    if (removedIds.includes(this.selectedInstanceId)) {
      this.selectedInstanceId = null;
    }
    if (folderIds.has(this.selectedFolderId)) {
      this.selectedFolderId = null;
    }

    return removedIds;
  }

  // ------------------------------------------------------------------
  // Editor entities (Triggers / Spawns / Summons / Particles / Billboards)
  // ------------------------------------------------------------------

  /**
   * Create an entity of `kind` (an ENTITY_KINDS key) with that kind's
   * default props. Spawn-like kinds get the next unique spawn ID.
   */
  addEntity(kind, parentId = null) {
    const def = ENTITY_KINDS[kind];
    if (!def) return null;

    const props = {};
    for (const propDef of def.props) {
      props[propDef.key] = propDef.uniqueId ? this.mintUniqueId(propDef.uniqueId) : propDef.default;
    }

    const entity = {
      id: this.nextId++,
      kind,
      name: null,
      parentId,
      pos: { x: 0, y: 0, z: 0 },
      rot: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      props,
    };
    this.entities.push(entity);
    return entity;
  }

  getEntity(id) {
    return this.entities.find((ent) => ent.id === id) || null;
  }

  removeEntity(id) {
    const idx = this.entities.findIndex((ent) => ent.id === id);
    if (idx !== -1) this.entities.splice(idx, 1);
    if (this.selectedInstanceId === id) this.selectedInstanceId = null;
  }

  /**
   * Clone an entity (Ctrl+D parity with instances). Props copy verbatim
   * EXCEPT unique spawn IDs, which are freshly allocated - two spawns
   * sharing an ID is exactly the invalid state uniqueness exists to
   * prevent, so a duplicate must never be born already in violation.
   */
  duplicateEntity(id) {
    const original = this.getEntity(id);
    if (!original) return null;

    const def = ENTITY_KINDS[original.kind];
    const props = { ...original.props };
    for (const propDef of def.props) {
      if (propDef.uniqueId) props[propDef.key] = this.mintUniqueId(propDef.uniqueId);
    }

    const clone = {
      id: this.nextId++,
      kind: original.kind,
      name: original.name,
      parentId: original.parentId,
      pos: { ...original.pos },
      rot: { ...original.rot },
      scale: { ...original.scale },
      props,
    };
    this.entities.push(clone);
    return clone;
  }

  /**
   * Serialize a node (instance OR entity) by id into a plain,
   * id-free data object suitable for the clipboard - copy/paste's
   * counterpart to duplicate. Deliberately drops id/parentId (paste mints
   * fresh ones) and deep-copies transform/props so the buffer never
   * aliases live state. Returns null if the id resolves to neither.
   */
  serializeNode(id) {
    const inst = this.getInstance(id);
    if (inst) {
      return {
        nodeType: 'instance',
        model: inst.model,
        palette: inst.palette,
        collide: inst.collide !== false,
        name: inst.name,
        pos: { ...inst.pos },
        rot: { ...inst.rot },
        scale: { ...inst.scale },
        anim: normalizeAnim(inst.anim),
        // Colliders ride along INSIDE the instance payload rather than as
        // separate clipboard entries: they have no meaning without an owner,
        // so copying a house and pasting it must produce a house that is
        // solid the same way. colliderId is deliberately NOT copied - paste
        // mints fresh ones, same rule as duplicate.
        colliders: this.collidersFor(id).map((c) => ({
          name: c.name,
          enabled: c.enabled !== false,
          center: { ...c.center },
          size: { ...c.size },
        })),
      };
    }

    const col = this.getCollider(id);
    if (col) {
      return {
        nodeType: 'collider',
        name: col.name,
        enabled: col.enabled !== false,
        center: { ...col.center },
        size: { ...col.size },
      };
    }
    const ent = this.getEntity(id);
    if (ent) {
      return {
        nodeType: 'entity',
        kind: ent.kind,
        name: ent.name,
        pos: { ...ent.pos },
        rot: { ...ent.rot },
        scale: { ...ent.scale },
        props: { ...ent.props },
      };
    }
    return null;
  }

  /**
   * Create a fresh instance/entity from a serializeNode() payload (the
   * paste half of copy/paste). Mints a new id (and a fresh unique spawn ID
   * for spawn-like entities, exactly like duplicateEntity, so a pasted
   * spawn is never born colliding with its source). Unknown/invalid
   * payloads return null. Returns { node, type } for the caller to render.
   */
  createNodeFromData(data, parentId = null) {
    if (!data || typeof data !== 'object') return null;

    if (data.nodeType === 'instance') {
      const instance = {
        id: this.nextId++,
        model: data.model,
        palette: data.palette ?? 0,
        collide: data.collide !== false,
        name: data.name ?? null,
        parentId,
        pos: { x: 0, y: 0, z: 0, ...(data.pos || {}) },
        rot: { x: 0, y: 0, z: 0, ...(data.rot || {}) },
        scale: { x: 1, y: 1, z: 1, ...(data.scale || {}) },
        anim: normalizeAnim(data.anim),
      };
      this.instances.push(instance);

      // Re-create the pasted instance's collision, with fresh colliderIds.
      for (const c of (data.colliders || [])) {
        this.addCollider(instance.id, {
          name: c.name,
          enabled: c.enabled,
          center: c.center,
          size: c.size,
        });
      }

      return { node: instance, type: 'instance' };
    }

    // A collider pasted on its own needs an owner. Paste targets the
    // selected instance; with nothing suitable selected there is no local
    // space to express it in, so the paste is refused rather than guessed.
    if (data.nodeType === 'collider') {
      const ownerId = this.getInstance(parentId) ? parentId : this.selectedInstanceId;
      if (!this.getInstance(ownerId)) return null;
      const collider = this.addCollider(ownerId, {
        name: data.name,
        enabled: data.enabled,
        center: data.center,
        size: data.size,
      });
      return { node: collider, type: 'collider' };
    }

    if (data.nodeType === 'entity') {
      const def = ENTITY_KINDS[data.kind];
      if (!def) return null;
      // Start from the kind's defaults, overlay the copied props, then
      // re-mint any unique spawn IDs so the paste can't duplicate one.
      const props = {};
      for (const propDef of def.props) props[propDef.key] = propDef.default;
      Object.assign(props, data.props || {});
      for (const propDef of def.props) {
        if (propDef.uniqueId) props[propDef.key] = this.mintUniqueId(propDef.uniqueId);
      }
      const entity = {
        id: this.nextId++,
        kind: data.kind,
        name: data.name ?? null,
        parentId,
        pos: { x: 0, y: 0, z: 0, ...(data.pos || {}) },
        rot: { x: 0, y: 0, z: 0, ...(data.rot || {}) },
        scale: { x: 1, y: 1, z: 1, ...(data.scale || {}) },
        props,
      };
      this.entities.push(entity);
      return { node: entity, type: 'entity' };
    }

    return null;
  }

  /**
   * True if another spawn-like entity (any kind with a spawnId prop)
   * already uses `spawnId`. Used to warn on manual ID edits - soft
   * validation, same philosophy as palette rows: warn, don't block.
   */
  isSpawnIdTaken(spawnId, excludeEntityId) {
    return this.isUniqueIdTaken('spawnId', spawnId, excludeEntityId);
  }

  /**
   * Mint the next id in `namespace`. Each namespace is its own dense
   * sequence - see the UNIQUE ID NAMESPACES note on ENTITY_KINDS for why
   * sounds don't share the spawn pool.
   *
   * An unknown namespace falls back to the spawn counter rather than
   * throwing: a schema typo should produce a slightly odd id, not a broken
   * editor that can't place the entity at all.
   */
  mintUniqueId(namespace) {
    if (namespace === 'sound') return this.nextSoundId++;
    return this.nextSpawnId++;
  }

  /**
   * True if another entity already uses `value` in the prop named `key`.
   * Keyed by PROP NAME rather than namespace, which is what makes spawn and
   * summon share one pool automatically (both store 'spawnId') while sounds
   * get their own (they store 'soundId') - no namespace table to keep in
   * sync with the schema.
   *
   * Soft validation only: callers warn, they don't block. The author may be
   * mid-renumber, and a temporarily duplicated id is a normal intermediate
   * state rather than a mistake to refuse.
   */
  isUniqueIdTaken(key, value, excludeEntityId) {
    return this.entities.some(
      (ent) => ent.id !== excludeEntityId && ent.props[key] === value
    );
  }

  /**
   * Re-mint any unique id that is missing or duplicated, and re-seat the
   * counters above whatever survives. Called after loading a project file.
   *
   * WHY THIS IS NEEDED, and it is not hypothetical: a project saved before
   * a uniqueId prop existed has no value for it, so the schema-default merge
   * on load hands EVERY affected entity the same default (0). Sound IDs
   * arrived in format v5, so every Sound in a v1-v4 file would load as
   * soundId 0 - and a trigger referencing "sound 0" would then resolve to
   * whichever emitter happened to come first, silently and wrongly.
   *
   * Deduping as well as filling gaps also repairs a hand-edited project file
   * and any historical duplicate the soft (warn-only) validation allowed
   * through, which is the whole point of validating softly.
   *
   * ORDER IS PRESERVED: entities keep their existing ids where those are
   * valid and unique, so a file that was already correct is left completely
   * untouched and no existing reference is invalidated.
   */
  repairUniqueIds() {
    // key -> namespace, gathered from the schemas so this never needs
    // updating when a kind adds a unique id.
    const keys = new Map();
    for (const def of Object.values(ENTITY_KINDS)) {
      for (const propDef of def.props) {
        if (propDef.uniqueId) keys.set(propDef.key, propDef.uniqueId);
      }
    }

    for (const [key, namespace] of keys) {
      const owners = this.entities.filter((ent) => key in ent.props);
      const seen = new Set();

      // Pass 1: keep every value that is a finite integer AND not already
      // claimed by an earlier entity.
      for (const ent of owners) {
        const v = ent.props[key];
        if (Number.isFinite(v) && !seen.has(v)) seen.add(v);
      }

      // Re-seat the counter BEFORE minting replacements, so new ids can't
      // collide with the kept ones.
      const highest = seen.size > 0 ? Math.max(...seen) : -1;
      if (namespace === 'sound') this.nextSoundId = Math.max(this.nextSoundId, highest + 1);
      else this.nextSpawnId = Math.max(this.nextSpawnId, highest + 1);

      // Pass 2: anything invalid or duplicated gets a fresh id.
      const claimed = new Set();
      for (const ent of owners) {
        const v = ent.props[key];
        if (Number.isFinite(v) && !claimed.has(v)) {
          claimed.add(v);
          continue;
        }
        ent.props[key] = this.mintUniqueId(namespace);
        claimed.add(ent.props[key]);
      }
    }
  }

  /**
   * Every non-music Sound entity, in tree order, as { id, label } - the
   * source for a Switch Scene trigger's "Upon Enter SFX" dropdown.
   *
   * MUSIC IS EXCLUDED because a music entity is a stage-level marker for a
   * VAB/SEQ pair handled by music.c, not an sfx voice - there is nothing
   * for a trigger to key on. Emitters with no sample name are excluded too:
   * they export as nothing, so referencing one would be a guaranteed
   * silence with no way to tell from the dropdown.
   */
  listTriggerableSounds() {
    return this.entities
      .filter(
        (ent) =>
          ent.kind === 'sound' &&
          ent.props.mode !== 'music' &&
          (ent.props.sample || '').trim() !== ''
      )
      .map((ent) => ({
        soundId: ent.props.soundId ?? 0,
        // Prefer the author's own rename, fall back to the sample name -
        // whichever they'd recognise. The id is appended either way so two
        // emitters of the same sample stay distinguishable in the list.
        label: `${ent.name || ent.props.sample.trim()} (#${ent.props.soundId ?? 0})`,
      }));
  }

  getInstance(id) {
    return this.instances.find((inst) => inst.id === id) || null;
  }

  /**
   * Set a single field on an instance OR entity via a dotted path, e.g.
   * 'pos.x'. Used by app.js's per-field <input> change handlers - the
   * transform fields in the Properties panel are shared between model
   * instances and editor entities, so this resolves either.
   */
  setInstanceField(id, path, value) {
    const instance = this.getInstance(id) || this.getEntity(id);
    if (!instance) return;

    const [group, axis] = path.split('.');
    if (axis) {
      instance[group][axis] = value;
    } else {
      instance[group] = value;
    }
  }

  /**
   * Determine the maximum valid palette row index for an instance, based
   * on the MAXIMUM clutHeight across all of its model's resolved
   * (non-null) materials.
   *
   * Max - not min - because of how the PS1 runtime actually consumes the
   * row (main.c, draw_object_into_ot): the object's palette row is
   * clamped PER TEXTURE against that texture's own paletteCount before
   * the setClut() call -
   *
   *     unsigned int row = objectPalette;
   *     if (row >= tex->paletteCount) row = tex->paletteCount - 1;
   *
   * so a multi-material model like house (House0.tim: 4 CLUT rows,
   * Grass0.tim: 1 row) legitimately supports rows 0-3: House0 swaps
   * through its four palettes while Grass0 safely clamps to its only
   * row. This tool's own viewport preview clamps identically
   * (tim_reader's getRGBATextureForRow), so preview, runtime, and this
   * validation now all agree. The previous MIN-based bound flagged
   * house's rows 1-3 as "out of range" even though both the preview and
   * the runtime handle them exactly as intended - a row is only truly
   * out of range when NO texture on the model has it (row >= max),
   * because then every texture just clamps and the row does nothing.
   *
   * If no materials resolved successfully (all null), fall back to 1
   * (i.e. only row 0 is valid) as a conservative default - there is no
   * real bound to check against in that scenario.
   */
  getMaxPaletteForInstance(id) {
    const instance = this.getInstance(id);
    if (!instance) return 1;

    const modelData = this.models.get(instance.model);
    if (!modelData || !modelData.materialsMap) return 1;

    let maxClutHeight = null;
    for (const decoded of modelData.materialsMap.values()) {
      if (decoded === null) continue;
      if (maxClutHeight === null || decoded.clutHeight > maxClutHeight) {
        maxClutHeight = decoded.clutHeight;
      }
    }

    return maxClutHeight === null ? 1 : maxClutHeight;
  }

  /**
   * Returns an array of { instanceId, message } warnings for any instance
   * whose assigned palette row is >= the max valid row for its model.
   */
  validatePaletteAssignments() {
    const warnings = [];
    for (const instance of this.instances) {
      const maxPalette = this.getMaxPaletteForInstance(instance.id);
      if (instance.palette >= maxPalette) {
        warnings.push({
          instanceId: instance.id,
          message: `Instance #${instance.id} (${instance.model}): palette row ${instance.palette} is out of range (max valid row is ${maxPalette - 1}).`,
        });
      }
    }
    return warnings;
  }

  /**
   * Soft validation for the fog block - warn, never block, the same policy
   * palette rows and spawn IDs use.
   *
   * Only reports what the author would not otherwise see. The near/far clamp
   * is applied on commit (app.js) so the panel can never HOLD a degenerate
   * range, which means a warning here is about a value that is legal but
   * likely unintended, not about one that would break the renderer.
   */
  validateFog() {
    const warnings = [];
    const fog = this.fog;
    if (!fog || !fog.enabled) return warnings;

    if (fog.layers <= 0) {
      warnings.push(
        'Fog: Quad Layers is 0, so TEXTURED geometry will not fog at all. The GTE depth cue only tints texels ' +
        '(texel * tint / 128) - at the neutral #808080 fog colour that tint is a no-op, so every bit of textured ' +
        'fogging comes from the quads. Untextured geometry still fogs normally.'
      );
    }

    if (fog.cull && fog.layers < 3) {
      warnings.push(
        `Fog: Hidden-Geometry Cull is on with only ${fog.layers} quad layer(s). Residual at the cull plane is ` +
        `0.5^layers of a texel's difference from the fog colour (${(100 * Math.pow(0.5, fog.layers)).toFixed(1)}% here), ` +
        'so textured geometry may visibly pop as it crosses Far. Raise layers, or leave cull off on a textured stage.'
      );
    }

    const col = (fog.color || '').toLowerCase();
    if (col !== '#808080') {
      warnings.push(
        `Fog: colour is ${fog.color}, not the neutral #808080. main.c derives the SCREEN CLEAR colour from the same ` +
        'constant, so FOG_COL_R/G/B in main.c must be changed to match or geometry will fade to one shade against a ' +
        'background of another. A non-neutral colour also makes the depth cue start modulating textured surfaces ' +
        '(brighter than 128 = brightening toward 2x texel, darker = darkening).'
      );
    }

    return warnings;
  }
}
