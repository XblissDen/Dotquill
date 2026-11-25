/** Pixel-art guidance served to the model through the `guide` tool. */
export const GUIDE: Record<string, string> = {
  workflow: `# Dotquill workflow (read before drawing)
Coordinates: x → right, y ↓ down, (0,0) = top-left. Keep canvases small: 16×16, 24×24, 32×32, 48×48, 64×64.
Pixels are written as one character each: the palette legend maps characters to colors (0-9, a-z, A-Z, then symbols).
"." = transparent. "_" = leave unchanged (write_pixels only). No spaces inside rows.

Loop for every asset:
1. Plan: purpose and size, palette, light direction (default top-left), outline style, and what must read at 1×.
2. Silhouette: block the shape in one flat color. render_preview: is it recognizable at 1×? Fix the shape before anything else.
3. Base colors: fill each region with its mid tone.
4. Shading: 1–2 darker tones away from the light, 1 highlight toward it, from the same ramp (topic "shading").
5. Outline: one dark outline color or the darkest tone per area (topic "outlines"), then clean jaggies and doubles.
6. Details last: eyes, rivets, sparkles. Few, deliberate pixels beat noise.
7. render_preview after every major step and fix what you see. Finish with audit and fix stray pixels.
8. Animate (topic "animation") or export.

Tool tips:
- write_pixels is best for organic shapes (faces, hair, foliage): write a full sprite or a region as rows.
- draw ops are best for geometry, fills, recolors, symmetry and outlines. Ops run in order in one call.
- Front-facing symmetric art: draw the left half, then draw op mirror (axis "x").
- UI panels, buttons and bars: read topic "ui" (9-slices, button states, Godot export).
- Shade inside a shape without leaking: e.g. ellipse in the shadow color with onlyOn: [body color].
- write_pixels/draw accept preview:true to get the image back in the same call.
- draw takes frames: [..] (or allFrames) to apply the same ops to several frames in one call.
- Layers are optional; one layer is fine for small sprites. Layers are listed bottom → top.
- The palette is locked. Pick tones by the L value (lightness 0–100) in the legend.
- Keep the asset notes current (manage_asset action "notes"): intent, light direction, what the animation does.
- When done, tell the user the asset name. They watch it live in the viewer (open_viewer).`,

  sprites: `# Characters, items and objects
- Sizes: 16×16 (iconic, few details), 24×24 or 32×32 (standard characters), 48–64 (detailed). Smaller is easier to draw well.
- Leave 1 px empty around the sprite for the outline and for motion in animation.
- Silhouette first: the sprite must read as a flat black shape. Exaggerate the key features (weapon, hat, ears, tail).
- Chibi game proportions: head ≈ 1/3–1/2 of the height; eyes 1–2 px; hands and feet as 1–2 px blobs.
- Separate the sprite from backgrounds with a dark outline or a strong value contrast.
- Icons and items: center them; tools and weapons on a diagonal (bottom-left to top-right); 2–3 tones per material plus one highlight pixel; 1 px dark outline.
- Top-down RPG characters: 16×16 or 16×24 in 3/4 view, feet on the second-to-last row.
- Side-view platformer characters: keep the feet baseline identical in every frame.
- Readability beats detail: if a detail does not read at 1×, remove it.`,

  shading: `# Shading and color
- One light source for the whole set (default top-left). Shadows go on the side away from it and under overhangs.
- Ramps: 3–4 tones per material from dark to light. Good ramps shift hue: shadows cooler (toward blue or purple), highlights warmer (toward yellow), most saturation in the mid tones.
- Avoid pillow shading (darkening every edge evenly around the outline). It flattens form.
- Avoid banding (parallel strips of tones following the same contour in stairs). Vary the cluster sizes.
- Work in clusters of same-color pixels. Lone single pixels look like noise unless they are intentional highlights.
- Ambient occlusion: darkest tone where forms meet (under the chin, between legs, where an object touches the ground).
- Dithering (draw op "dither") is for large gradients (sky, metal); on small sprites prefer flat clusters.
- Value beats hue: check the 1× copy in render_preview; main forms must separate by lightness.
- Typical budget for a 32×32 character: 4–6 hues × 3 tones + outline ≈ 12–20 colors.`,

  outlines: `# Lines and outlines
- Pixel-perfect lines: no doubles (L-shaped corners where a 1 px line thickens). In a staircase, steps touch only diagonally.
- Straight slopes use constant segment lengths: 1:1, 2:1, 3:1, 1:2 … Avoid irregular runs like 3-1-2-1.
- Curves: segment lengths change gradually (4,3,2,1,1,2,3,4), never jump (4,1,4).
- Outline styles: (1) one dark color everywhere: classic, most readable, the safe default for game sprites ≤ 32 px; (2) the darkest tone of each material: softer; (3) selective outline (selout): lighter on the lit side.
- draw op "outline" adds an outer outline around all opaque pixels (corners:false gives a rounder 4-connected outline). Draw interior lines (an arm in front of the body) by hand.
- After an automatic outline, remove pixels that make doubles at concave corners.
- Moved or reshaped an outlined part (animation, flaring cape)? Use outline with refresh:true: it removes the old outer ring of that color and outlines again, closing gaps. Interior pixels of the same color are kept.
- Anti-aliasing: an in-between tone inside a jagged step on curves; never anti-alias the outer edge of a sprite used on varied backgrounds.`,

  animation: `# Animation
- Timing: idle 2–4 frames at 150–250 ms; walk 4–8 frames at 80–120 ms; run 6–8 at 60–90 ms; attack 3–6 frames: long anticipation, very short strike (40–60 ms), then a hold; hurt 2–3 frames.
- Workflow: finish frame 0 first, then frames → add with copyFrom 0 and change only what moves. Move parts with draw op "copy" (cut:true) or "shift"; shared changes go to several frames at once with draw frames: [..].
- Moving a region of an outlined sprite breaks the outline at the seams: finish each frame with outline refresh:true. Keep feet, planted weapons and other anchored parts out of moved regions.
- Keep volume: squash and stretch should roughly preserve area. Keep the canvas size and the feet baseline fixed to avoid jitter.
- Idle breathing: torso and head 1 px down on one frame and back; hair, capes and tails follow one frame later.
- 4-frame side-view walk: contact, passing (body 1 px up), contact (other leg forward), passing. Arms swing opposite to legs.
- Name ranges with tags (frames → tag): idle, walk, attack. Sheet exports keep tags (Aseprite JSON frameTags); export format "godot-spriteframes" turns each tag into a Godot animation with the frame durations (AnimatedSprite2D).
- render_preview shows all frames side by side; diff:true outlines in magenta every pixel that changed since the previous frame, so you can confirm that only the intended parts move. The viewer plays the animation; audit reports bounding-box changes (unexpected jumps mean jitter).`,

  tiles: `# Tiles and tilesets
- Sizes: 16×16 standard, 8×8 very retro, 32×32 detailed. One size for a whole tileset.
- Seamless: the left edge continues the right edge, the top continues the bottom. Check with render_preview tile:true (3×3 repeat). Seams or repeating "hot spots" mean it needs work.
- No unique, eye-catching features in repeating ground tiles: one big flower turns into an obvious grid. Spread small details evenly and keep contrast low so characters stay readable on top.
- Make 2–4 variants of common tiles (manage_asset duplicate, then change details) to break repetition.
- Light from the top-left, the same as characters.
- Side-view platform tiles: highlight on the walkable top edge, darker toward the bottom.
- Terrain edges: plan the full set (center, 4 edges, 4 outer corners, 4 inner corners). Frames of one asset can hold the set; export it as a sheet.`,

  palettes: `# Palettes
- Each asset has a locked palette (max 88 colors). Use one palette for a whole game or asset set so everything matches.
- Built-in presets: palette action "presets". Any Lospec palette by slug: { "lospec": "resurrect-64" } (also "apollo", "aap-64", "sweetie-16", …).
- Keep a set consistent with { "fromAsset": "other-asset" }.
- palette action "set" switches palettes: remap "nearest" maps pixels to the closest new color; remap "index" keeps indices (palette swap for recolors and team colors).
- The legend shows L (lightness 0–100) for each color. Pick ramp tones roughly 10–20 L apart.`,

  ui: `# UI: panels, buttons, bars, icons
- Pixel-art UI is raster too: draw it at the game's base resolution (e.g. 320×180, 480×270); the engine scales by whole numbers with Nearest filtering. Use the same pixel size as the sprites.
- Panels, windows, buttons and bars are 9-slices: draw a small source (16×16 to 32×32), then slices → set with nine margins (border widths). Corners keep their size; edges and center stretch or tile.
- Keep the stretchable parts plain: no gradient along the stretch direction and no unique details in the middle of an edge. Put ornaments in the corners.
- mode "tile" for patterned borders (rivets, stitches, bricks); "stretch" (default) for flat fills.
- Check every 9-slice with render_preview stretch at a few sizes (wide, tall, small), e.g. [96, 32] and [32, 64], and fix what breaks. Normal previews show the 9-slice guides as yellow dashed lines.
- Buttons: one asset, one frame per state (normal, hover, pressed, disabled) with single-frame tags named after the states; the 9-slice applies to every frame. Pressed: face 1 px lower and slightly darker; hover: a bit lighter; disabled: desaturated, low contrast.
- Readability: 1 px dark outline; light edge toward the light (top), dark edge at the bottom; keep ≥ 2 px inner padding for content.
- Bars (health, mana): a 9-slice frame plus a separate fill asset; keep the end caps inside the margins.
- Icons: 8×8 to 16×16, centered, 1 px outline, readable at 1×.
- Export: format "godot-stylebox" writes the PNG and a StyleBoxTexture .tres per frame (use outDir inside the Godot project for res:// paths). The sheet JSON carries the slices in Aseprite format for other engines.
- Text is not drawn here: leave room for a 5–8 px pixel font.`,
};

export const GUIDE_TOPICS = Object.keys(GUIDE);
