"""Procedural Blender asset pipeline for High Water.

Builds every Level 1 prop, bakes ambient occlusion into vertex colors with Cycles,
and exports Draco-compressed .glb files to public/assets.

Run:  python3 blender/build_assets.py            (bpy pip module)
  or: blender -b -P blender/build_assets.py

Units: 1 Blender unit = 1 map tile. Front of every building faces -Y (becomes +Z in glTF).
Materials whose name starts with "Tint" are recolored per instance in the game.
"""
import bpy, bmesh, math, random, os
from mathutils import Vector

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'assets')
os.makedirs(OUT, exist_ok=True)
MATS = {}


def srgb(c):
    return tuple(x ** 2.2 for x in c)


def mat(name, color, rough=0.75, metal=0.0, emit=0.0):
    key = name
    if key in MATS:
        return MATS[key]
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True
    except Exception:
        pass
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (*srgb(color), 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if emit:
        b.inputs['Emission Color'].default_value = (*srgb(color), 1)
        b.inputs['Emission Strength'].default_value = emit
    MATS[key] = m
    return m


def fresh():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MATS.clear()


def activate(o):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o


def apply_mods(o):
    activate(o)
    for m in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def finish(o, m, bevel=0.0):
    if bevel:
        b = o.modifiers.new('bevel', 'BEVEL')
        b.width = bevel
        b.segments = 1
        b.limit_method = 'ANGLE'
    o.data.materials.append(m)
    apply_mods(o)
    return o


def box(size, loc, m, bevel=0.0, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(o, m, bevel)


def cyl(r, depth, loc, m, verts=12, rot=(0, 0, 0), r2=None):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=depth, location=loc, rotation=rot)
    return finish(bpy.context.object, m)


def sphere(r, loc, m, sub=2, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=sub, radius=r, location=loc)
    o = bpy.context.object
    o.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for p in o.data.polygons:
        p.use_smooth = True
    return finish(o, m)


def mesh_obj(name, verts, faces, m, smooth=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    for p in me.polygons:
        p.use_smooth = smooth
    o.data.materials.append(m)
    return o


def hip_roof(w, d, z, oh, rise, m, thick=0.035):
    W, D = w / 2 + oh, d / 2 + oh
    if w >= d:
        r = W - D
        v = [(-W, -D, z), (W, -D, z), (W, D, z), (-W, D, z), (-r, 0, z + rise), (r, 0, z + rise)]
        f = [(0, 1, 5, 4), (2, 3, 4, 5), (1, 2, 5), (3, 0, 4), (3, 2, 1, 0)]
    else:
        r = D - W
        v = [(-W, -D, z), (W, -D, z), (W, D, z), (-W, D, z), (0, -r, z + rise), (0, r, z + rise)]
        f = [(0, 1, 4), (2, 3, 5), (1, 2, 5, 4), (3, 0, 4, 5), (3, 2, 1, 0)]
    o = mesh_obj('roof', v, f, m)
    s = o.modifiers.new('s', 'SOLIDIFY')
    s.thickness = thick
    apply_mods(o)
    return o


def gable_roof(w, d, z, oh, rise, m, thick=0.035):
    W, D = w / 2 + oh, d / 2 + oh
    v = [(-W, -D, z), (W, -D, z), (W, D, z), (-W, D, z), (-W, 0, z + rise), (W, 0, z + rise)]
    f = [(0, 1, 5, 4), (2, 3, 4, 5)]
    o = mesh_obj('roof', v, f, m)
    s = o.modifiers.new('s', 'SOLIDIFY')
    s.thickness = thick
    apply_mods(o)
    return o


def window(x, y, z, ww, wh, face, trim, glass, shutter=None):
    """face: 'front' (-Y), 'back' (+Y), 'left' (-X), 'right' (+X). x/y is the wall surface point."""
    t = 0.018
    if face in ('front', 'back'):
        s = -1 if face == 'front' else 1
        box((ww + 0.04, t, wh + 0.04), (x, y + s * t / 2, z), trim)
        box((ww, t, wh), (x, y + s * t, z), glass)
        box((0.012, t, wh), (x, y + s * t * 1.4, z), trim)
        if shutter:
            for sx in (-1, 1):
                box((ww * 0.32, t, wh + 0.04), (x + sx * (ww / 2 + ww * 0.2), y + s * t / 2, z), shutter)
    else:
        s = -1 if face == 'left' else 1
        box((t, ww + 0.04, wh + 0.04), (x + s * t / 2, y, z), trim)
        box((t, ww, wh), (x + s * t, y, z), glass)
        box((t, 0.012, wh), (x + s * t * 1.4, y, z), trim)


def join_all(name):
    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = name
    return o


def bake_ao(o, ground_z, subdiv=0, dist=0.6):
    """Bake ambient occlusion into a vertex color layer (the glTF COLOR_0 the game multiplies in)."""
    scene = bpy.context.scene
    if subdiv:
        sm = o.modifiers.new('sub', 'SUBSURF')
        sm.subdivision_type = 'SIMPLE'
        sm.levels = subdiv
        sm.render_levels = subdiv
        apply_mods(o)
    world = bpy.data.worlds.new('W')
    scene.world = world
    try:
        world.light_settings.distance = dist
    except Exception:
        pass
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, ground_z))
    ground = bpy.context.object
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = 48
    me = o.data
    ca = me.color_attributes.new('Col', 'BYTE_COLOR', 'CORNER')
    me.color_attributes.active_color = ca
    try:
        me.color_attributes.render_color_index = me.color_attributes.active_color_index
    except Exception:
        pass
    scene.render.bake.target = 'VERTEX_COLORS'
    activate(o)
    try:
        bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
        # Lift AO so it darkens creases without crushing everything
        for d in ca.data:
            a = d.color[0]
            v = 0.35 + 0.65 * a
            d.color = (v, v, v, 1)
    except Exception as e:
        print('AO bake skipped:', e)
    bpy.data.objects.remove(ground)


def export(o, name):
    activate(o)
    path = os.path.join(OUT, name + '.glb')
    kw = dict(filepath=path, use_selection=True, export_format='GLB', export_apply=True, export_yup=True,
              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=7,
              export_vertex_color='ACTIVE', export_materials='EXPORT', export_normals=True,
              export_texcoords=False, export_animations=False)
    while True:
        try:
            bpy.ops.export_scene.gltf(**kw)
            break
        except TypeError as e:
            bad = [k for k in kw if k in str(e) and k != 'filepath']
            if not bad:
                raise
            kw.pop(bad[0])
    print('wrote', path, os.path.getsize(path), 'bytes', len(o.data.polygons), 'faces')


# ---------------------------------------------------------------- materials
def house_mats():
    return dict(
        wall=mat('TintWall', (0.96, 0.95, 0.92), 0.9),
        found=mat('Foundation', (0.62, 0.6, 0.56), 0.95),
        trim=mat('Trim', (0.97, 0.97, 0.95), 0.6),
        glass=mat('Glass', (0.18, 0.3, 0.38), 0.08, 0.35),
        tile=mat('RoofTile', (0.72, 0.38, 0.27), 0.75),
        metalroof=mat('RoofMetal', (0.78, 0.8, 0.8), 0.32, 0.65),
        flat=mat('RoofFlat', (0.92, 0.92, 0.9), 0.85),
        door=mat('Door', (0.12, 0.33, 0.42), 0.5),
        garage=mat('GarageDoor', (0.9, 0.9, 0.88), 0.55),
        groove=mat('Groove', (0.7, 0.7, 0.68), 0.6),
        metal=mat('Metal', (0.7, 0.72, 0.73), 0.4, 0.5),
        shutter=mat('Shutter', (0.2, 0.45, 0.42), 0.6),
        stone=mat('Stone', (0.78, 0.7, 0.58), 0.95),
        concrete=mat('Concrete', (0.8, 0.79, 0.75), 0.9),
    )


def foundation(w, d, M):
    box((w + 0.05, d + 0.05, 1.0), (0, 0, -0.48), M['found'])
    box((w + 0.03, d + 0.03, 0.035), (0, 0, 0.02), M['trim'])


def ac_unit(x, y, M):
    box((0.14, 0.12, 0.11), (x, y, 0.055), M['metal'], 0.01)
    cyl(0.045, 0.01, (x, y, 0.115), M['groove'], 16)


# ---------------------------------------------------------------- houses
def house_ranch():
    fresh(); M = house_mats()
    w, d, h = 1.5, 1.25, 0.5
    foundation(w, d, M)
    box((w, d, h), (0, 0, h / 2), M['wall'])
    fy = -d / 2
    box((0.5, 0.02, 0.33), (0.42, fy - 0.006, 0.165), M['garage'])
    for gz in (0.08, 0.16, 0.24):
        box((0.5, 0.01, 0.008), (0.42, fy - 0.017, gz), M['groove'])
    box((0.15, 0.02, 0.3), (-0.08, fy - 0.006, 0.15), M['door'])
    box((0.25, 0.03, 0.008), (-0.08, fy - 0.01, 0.31), M['trim'])
    window(-0.45, fy, 0.27, 0.3, 0.2, 'front', M['trim'], M['glass'], M['shutter'])
    for wy in (-0.3, 0.3):
        window(-w / 2, wy, 0.27, 0.25, 0.2, 'left', M['trim'], M['glass'])
        window(w / 2, wy, 0.27, 0.25, 0.2, 'right', M['trim'], M['glass'])
    for wx in (-0.45, 0.0, 0.45):
        window(wx, d / 2, 0.27, 0.28, 0.2, 'back', M['trim'], M['glass'])
    hip_roof(w, d, h, 0.11, 0.36, M['tile'])
    box((0.07, 0.07, 0.22), (-0.3, 0.2, h + 0.3), M['wall'])  # chimney/vent stack
    ac_unit(w / 2 + 0.1, 0.25, M)
    o = join_all('house_ranch')
    bake_ao(o, -0.14, subdiv=2)
    export(o, 'house_ranch')


def house_twostory():
    fresh(); M = house_mats()
    w, d, h = 1.3, 1.15, 0.95
    foundation(w, d, M)
    box((w, d, h), (0, 0, h / 2), M['wall'])
    box((w + 0.02, d + 0.02, 0.03), (0, 0, h / 2), M['trim'])  # floor band
    fy = -d / 2
    # porch
    box((w + 0.04, 0.32, 0.05), (0, fy - 0.16, 0.0), M['concrete'])
    for px in (-0.6, -0.2, 0.2, 0.6):
        cyl(0.025, 0.42, (px, fy - 0.29, 0.23), M['trim'], 10)
    box((w + 0.08, 0.38, 0.03), (0, fy - 0.17, 0.455), M['trim'])
    box((w + 0.04, 0.012, 0.06), (0, fy - 0.3, 0.07), M['trim'])  # railing
    box((0.15, 0.02, 0.32), (0, fy - 0.006, 0.16), M['door'])
    for wx in (-0.42, 0.42):
        window(wx, fy, 0.25, 0.24, 0.24, 'front', M['trim'], M['glass'], M['shutter'])
    for wx in (-0.42, 0.0, 0.42):
        window(wx, fy, 0.72, 0.24, 0.24, 'front', M['trim'], M['glass'], M['shutter'])
        window(wx, d / 2, 0.72, 0.24, 0.24, 'back', M['trim'], M['glass'])
        window(wx, d / 2, 0.25, 0.24, 0.24, 'back', M['trim'], M['glass'])
    for wy in (-0.25, 0.25):
        for wz in (0.25, 0.72):
            window(-w / 2, wy, wz, 0.22, 0.24, 'left', M['trim'], M['glass'])
            window(w / 2, wy, wz, 0.22, 0.24, 'right', M['trim'], M['glass'])
    gable_roof(w, d, h, 0.1, 0.4, M['metalroof'])
    # gable ends
    for sx in (-1, 1):
        mesh_obj('gable', [(sx * w / 2, -d / 2, h), (sx * w / 2, d / 2, h), (sx * w / 2, 0, h + 0.37)], [(0, 1, 2) if sx > 0 else (2, 1, 0)], M['wall'])
    ac_unit(-w / 2 - 0.1, 0.3, M)
    o = join_all('house_twostory')
    bake_ao(o, -0.14, subdiv=2)
    export(o, 'house_twostory')


def house_modern():
    fresh(); M = house_mats()
    w, d, h = 1.55, 1.2, 0.52
    foundation(w, d, M)
    box((w, d, h), (0, 0, h / 2), M['wall'])
    fy = -d / 2
    box((0.42, 0.04, h), (-0.45, fy - 0.01, h / 2), M['stone'])  # stone accent block
    box((0.7, 0.02, 0.3), (0.25, fy - 0.006, 0.26), M['glass'])  # glass band
    for gx in (0.02, 0.25, 0.48):
        box((0.015, 0.03, 0.3), (gx, fy - 0.01, 0.26), M['trim'])
    box((0.14, 0.02, 0.32), (-0.12, fy - 0.006, 0.16), M['door'])
    box((w + 0.3, d + 0.3, 0.06), (0, 0, h + 0.03), M['flat'])  # flat roof with overhang
    box((w + 0.3, 0.02, 0.05), (0, -(d + 0.3) / 2, h + 0.06), M['trim'])
    # carport
    box((0.55, 0.7, 0.04), (w / 2 + 0.28, -0.1, h - 0.06), M['flat'])
    for py in (-0.4, 0.2):
        box((0.035, 0.035, h - 0.08), (w / 2 + 0.52, py, (h - 0.08) / 2), M['trim'])
    for wy in (-0.25, 0.25):
        window(-w / 2, wy, 0.28, 0.3, 0.24, 'left', M['trim'], M['glass'])
    box((1.0, 0.02, 0.34), (0, d / 2 + 0.006, 0.2), M['glass'])  # sliding doors to back lanai
    box((1.1, 0.35, 0.04), (0, d / 2 + 0.18, 0.0), M['concrete'])
    ac_unit(-w / 2 - 0.1, -0.3, M)
    o = join_all('house_modern')
    bake_ao(o, -0.14, subdiv=2)
    export(o, 'house_modern')


# ---------------------------------------------------------------- vegetation
def palm(name, seed, height):
    fresh()
    rnd = random.Random(seed)
    bark = mat('Bark', (0.55, 0.47, 0.37), 0.95)
    frond = mat('Frond', (0.3, 0.52, 0.22), 0.7)
    nut = mat('Coconut', (0.42, 0.32, 0.16), 0.8)
    bend = rnd.uniform(0.15, 0.3)
    segs, ring = 14, 8
    verts, faces = [], []

    def path(t):
        return Vector((bend * t * t, 0, height * t))

    for k in range(segs + 1):
        t = k / segs
        c = path(t)
        r = 0.065 * (1 - 0.35 * t) * (1.08 if k % 2 == 0 else 0.97) + (0.025 * (1 - t) ** 4)
        for j in range(ring):
            a = 2 * math.pi * j / ring
            verts.append(c + Vector((math.cos(a) * r, math.sin(a) * r, 0)))
    for k in range(segs):
        for j in range(ring):
            a, b = k * ring + j, k * ring + (j + 1) % ring
            faces.append((a, b, b + ring, a + ring))
    mesh_obj('trunk', verts, faces, bark, smooth=True)

    top = path(1.0)
    n_fronds = 11
    for f in range(n_fronds):
        ang = 2 * math.pi * f / n_fronds + rnd.uniform(-0.2, 0.2)
        lift = rnd.uniform(0.15, 0.55)
        L = rnd.uniform(0.75, 0.95)
        dirv = Vector((math.cos(ang), math.sin(ang), 0))
        side = Vector((-math.sin(ang), math.cos(ang), 0))
        v, fc = [], []
        steps = 12
        for s in range(steps + 1):
            u = s / steps
            p = top + dirv * (L * u) + Vector((0, 0, L * (lift * u - 0.9 * u * u)))
            wdt = 0.2 * math.sin(math.pi * min(1, u * 1.15)) + 0.01
            droop = Vector((0, 0, -0.06 * wdt / 0.2))
            v += [p, p + side * wdt + droop, p - side * wdt + droop]
        for s in range(steps):
            a = s * 3
            fc.append((a, a + 3, a + 4, a + 1))
            fc.append((a, a + 2, a + 5, a + 3))
        mesh_obj('frond', v, fc, frond, smooth=True)
    for k in range(4):
        a = 2 * math.pi * k / 4 + 0.4
        sphere(0.045, top + Vector((math.cos(a) * 0.06, math.sin(a) * 0.06, -0.06)), nut, 1)
    o = join_all(name)
    solid = o.modifiers.new('s', 'SOLIDIFY')  # gives fronds thickness so both sides shade
    solid.thickness = 0.008
    apply_mods(o)
    bake_ao(o, 0.0, dist=0.4)
    export(o, name)


def shrub():
    fresh()
    leaf = mat('Shrub', (0.24, 0.45, 0.2), 0.85)
    flower = mat('Flower', (0.88, 0.3, 0.45), 0.6)
    rnd = random.Random(3)
    for k in range(5):
        a = rnd.uniform(0, 6.28)
        r = rnd.uniform(0.0, 0.12)
        sphere(rnd.uniform(0.1, 0.15), (math.cos(a) * r, math.sin(a) * r, 0.1 + rnd.uniform(0, 0.05)), leaf, 2, (1, 1, 0.8))
    for k in range(7):
        a = rnd.uniform(0, 6.28)
        sphere(0.022, (math.cos(a) * 0.16, math.sin(a) * 0.16, 0.13 + rnd.uniform(0, 0.06)), flower, 1)
    o = join_all('shrub')
    bm = bmesh.new(); bm.from_mesh(o.data)
    for v in bm.verts:
        n = math.sin(v.co.x * 41) * math.cos(v.co.y * 37) * math.sin(v.co.z * 29)
        v.co += v.normal * 0.018 * n
    bm.to_mesh(o.data); bm.free()
    bake_ao(o, 0.0, dist=0.3)
    export(o, 'shrub')


# ---------------------------------------------------------------- street props
def car():
    fresh()
    paint = mat('TintPaint', (0.95, 0.95, 0.95), 0.3, 0.4)
    glass = mat('Glass', (0.1, 0.14, 0.18), 0.05, 0.4)
    tire = mat('Tire', (0.08, 0.08, 0.08), 0.9)
    rim = mat('Rim', (0.75, 0.75, 0.75), 0.3, 0.8)
    light = mat('Light', (1.0, 0.95, 0.8), 0.3, 0.0, 1.5)
    tail = mat('Tail', (0.8, 0.1, 0.1), 0.4)
    L, W = 0.46, 0.2
    box((W, L, 0.085), (0, 0, 0.075), paint, 0.02)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0.02, 0.15))
    cab = bpy.context.object
    cab.scale = (W * 0.86, L * 0.52, 0.07)
    bpy.ops.object.transform_apply(scale=True)
    for v in cab.data.vertices:
        if v.co.z > 0:
            v.co.x *= 0.85
            v.co.y *= 0.72
    finish(cab, glass, 0.008)
    box((W * 0.8, L * 0.32, 0.012), (0, 0.025, 0.188), paint, 0.004)
    for sx in (-1, 1):
        for sy in (-1, 1):
            cyl(0.04, 0.03, (sx * W / 2, sy * L * 0.31, 0.04), tire, 16, (0, math.pi / 2, 0))
            cyl(0.022, 0.032, (sx * W / 2, sy * L * 0.31, 0.04), rim, 10, (0, math.pi / 2, 0))
        box((0.04, 0.01, 0.02), (sx * W * 0.32, -L / 2, 0.09), light)
        box((0.04, 0.01, 0.02), (sx * W * 0.32, L / 2, 0.09), tail)
    o = join_all('car')
    bake_ao(o, 0.0, subdiv=1, dist=0.15)
    export(o, 'car')


def streetlight():
    fresh()
    pole = mat('Pole', (0.35, 0.37, 0.38), 0.5, 0.6)
    lamp = mat('Lamp', (1.0, 0.92, 0.75), 0.3, 0.0, 2.0)
    cyl(0.025, 1.1, (0, 0, 0.55), pole, 10, r2=None)
    cyl(0.05, 0.04, (0, 0, 0.02), pole, 10)
    box((0.02, 0.35, 0.02), (0, -0.17, 1.08), pole)
    box((0.07, 0.14, 0.03), (0, -0.33, 1.07), pole, 0.01)
    box((0.05, 0.11, 0.01), (0, -0.33, 1.053), lamp)
    o = join_all('streetlight')
    bake_ao(o, 0.0, dist=0.2)
    export(o, 'streetlight')


def drain():
    fresh()
    conc = mat('Concrete', (0.72, 0.71, 0.68), 0.9)
    iron = mat('Iron', (0.16, 0.16, 0.17), 0.55, 0.7)
    box((0.62, 0.62, 0.08), (0, 0, 0.0), conc, 0.01)
    box((0.48, 0.48, 0.02), (0, 0, 0.04), iron)
    for k in range(-4, 5):
        box((0.03, 0.46, 0.02), (k * 0.05, 0, 0.055), iron)
    o = join_all('drain')
    bake_ao(o, -0.04, subdiv=1, dist=0.08)
    export(o, 'drain')


def check_valve():
    fresh()
    flange = mat('ValveFlange', (0.95, 0.55, 0.12), 0.5, 0.3)
    rubber = mat('Rubber', (0.08, 0.08, 0.08), 0.9)
    bolt = mat('Bolt', (0.75, 0.75, 0.75), 0.3, 0.9)
    cyl(0.2, 0.05, (0, 0, 0.06), flange, 24)
    for k in range(8):
        a = 2 * math.pi * k / 8
        cyl(0.015, 0.02, (math.cos(a) * 0.16, math.sin(a) * 0.16, 0.09), bolt, 6)
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=0.13, radius2=0.02, depth=0.2, location=(0, 0, 0.18))
    bill = bpy.context.object
    bill.scale = (1, 0.45, 1)
    bpy.ops.object.transform_apply(scale=True)
    finish(bill, rubber)
    o = join_all('check_valve')
    bake_ao(o, 0.0, dist=0.1)
    export(o, 'check_valve')


def pump():
    fresh()
    conc = mat('Concrete', (0.74, 0.73, 0.7), 0.9)
    body = mat('PumpBody', (0.28, 0.45, 0.4), 0.45, 0.4)
    motor = mat('Motor', (0.92, 0.75, 0.15), 0.4, 0.3)
    pipe = mat('Pipe', (0.4, 0.42, 0.44), 0.4, 0.7)
    panel = mat('Panel', (0.85, 0.86, 0.86), 0.5, 0.3)
    box((0.75, 0.75, 0.06), (0, 0, 0.03), conc, 0.01)
    box((0.36, 0.34, 0.26), (0.08, 0, 0.19), body, 0.02)
    cyl(0.1, 0.22, (0.08, 0, 0.43), motor, 16)
    cyl(0.06, 0.04, (0.08, 0, 0.56), body, 16)
    cyl(0.055, 0.45, (-0.25, 0, 0.2), pipe, 14, (0, math.pi / 2, 0))
    cyl(0.07, 0.03, (-0.08, 0, 0.2), pipe, 14, (0, math.pi / 2, 0))
    cyl(0.055, 0.22, (-0.46, 0, 0.1), pipe, 14)
    box((0.14, 0.06, 0.24), (0.22, 0.3, 0.18), panel, 0.01)
    o = join_all('pump')
    bake_ao(o, 0.0, subdiv=1, dist=0.2)
    export(o, 'pump')


for fn in (house_ranch, house_twostory, house_modern, lambda: palm('palm_a', 1, 1.6), lambda: palm('palm_b', 7, 1.9),
           shrub, car, streetlight, drain, check_valve, pump):
    fn()
