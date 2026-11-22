"""Download real data for each Florida place and bake it into public/places/<id>.json.

Sources
  Elevation  USGS 3DEP via the AWS Terrain Tiles (terrarium PNG, meters, NAVD88)
  Map        OpenStreetMap (roads, buildings, water, beaches) via the Overpass API
  Tides      NOAA CO-OPS datums for the nearest water level station
  Rain       NOAA Atlas 14 precipitation frequency estimates

Run: python3 tools/fetch_places.py [place-id ...]
Then: node --experimental-strip-types tools/calibrate.ts
"""
import hashlib, io, json, math, os, subprocess, sys, time
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'places')
CACHE = os.path.join(ROOT, '.cache')
os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)

N = 48          # grid cells per side
CELL = 12.0     # meters per cell (grid covers 576 m)
Z = 15          # terrain tile zoom (about 4 m per pixel in Florida; the highest available)
M2FT = 3.28084

# id, name, county, water body, approximate center
PLACES = [
    ('miami-beach', 'Sunset Harbour, Miami Beach', 'Miami-Dade', 'Biscayne Bay', 25.7957, -80.1436),
    ('key-west', 'Old Town, Key West', 'Monroe', 'Key West Harbor', 24.5590, -81.8000),
    ('st-pete', 'Shore Acres, St. Petersburg', 'Pinellas', 'Tampa Bay', 27.7980, -82.6020),
    ('fort-lauderdale', 'Las Olas Isles, Fort Lauderdale', 'Broward', 'Intracoastal Waterway', 26.1185, -80.1185),
    ('daytona-shores', 'Daytona Beach Shores', 'Volusia', 'Halifax River', 29.1700, -80.9800),
    ('new-smyrna', 'New Smyrna Beach', 'Volusia', 'Indian River', 29.0270, -80.9180),
    ('davis-islands', 'Davis Islands, Tampa', 'Hillsborough', 'Hillsborough Bay', 27.9200, -82.4540),
    ('fort-myers-beach', 'Fort Myers Beach', 'Lee', 'Estero Bay', 26.4500, -81.9440),
    ('riverside-jax', 'Riverside, Jacksonville', 'Duval', 'St. Johns River', 30.3080, -81.6880),
    ('cedar-key', 'Cedar Key', 'Levy', 'Gulf of Mexico', 29.1380, -83.0350),
    ('apalachicola', 'Apalachicola', 'Franklin', 'Apalachicola Bay', 29.7250, -84.9830),
    ('pensacola-beach', 'Pensacola Beach', 'Escambia', 'Santa Rosa Sound', 30.3320, -87.1380),
    ('old-naples', 'Old Naples', 'Collier', 'Naples Bay', 26.1350, -81.7980),
]

ROAD_W = {'motorway': 3, 'trunk': 3, 'primary': 2.6, 'secondary': 2.3, 'tertiary': 2.0, 'unclassified': 1.6,
          'residential': 1.6, 'living_street': 1.4, 'service': 1.0}


def curl(url, data=None, binary=False, tries=4):
    key = os.path.join(CACHE, hashlib.md5(repr((url, data)).encode()).hexdigest() + ('.bin' if binary else '.txt'))
    if os.path.exists(key):
        return open(key, 'rb').read() if binary else open(key).read()
    cmd = ['curl', '-sL', '--fail', '--max-time', '100', url]
    if data is not None:
        cmd += ['--data-urlencode', 'data=' + data]
    for k in range(tries):
        r = subprocess.run(cmd, capture_output=True)
        if r.returncode == 0 and r.stdout:
            open(key, 'wb').write(r.stdout)
            return r.stdout if binary else r.stdout.decode('utf-8', 'replace')
        time.sleep(3 * (k + 1))
    raise RuntimeError('download failed: ' + url)


# ---------------------------------------------------------------- elevation
def tile_xy(lat, lon, z=Z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n
    return x, y


TILES = {}
def elev_m(lat, lon):
    x, y = tile_xy(lat, lon)
    tx, ty = int(x), int(y)
    if (tx, ty) not in TILES:
        png = curl(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{tx}/{ty}.png', binary=True)
        TILES[(tx, ty)] = Image.open(io.BytesIO(png)).convert('RGB')
    im = TILES[(tx, ty)]
    px, py = min(255, int((x - tx) * 256)), min(255, int((y - ty) * 256))
    r, g, b = im.getpixel((px, py))
    return r * 256 + g + b / 256 - 32768


# ---------------------------------------------------------------- tides
STATIONS = None
def tides(lat, lon):
    global STATIONS
    if STATIONS is None:
        STATIONS = json.loads(curl('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels&units=english'))['stations']
    cands = []
    for s in STATIONS:
        d = haversine(lat, lon, s['lat'], s['lng'])
        if d < 130000:
            cands.append((d, s))
    cands.sort(key=lambda c: c[0])
    for d, s in cands[:12]:
        try:
            js = json.loads(curl(f"https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/{s['id']}/datums.json?units=english"))
        except Exception:
            continue
        v = {x['name']: x['value'] for x in js.get('datums', []) if x.get('value') is not None}
        if 'NAVD88' in v and 'MHHW' in v and 'MSL' in v:
            nav = v['NAVD88']
            out = {'station': s['id'], 'stationName': s['name'], 'distMi': round(d / 1609.34, 1),
                   'mhhw': round(v['MHHW'] - nav, 2), 'msl': round(v['MSL'] - nav, 2)}
            if 'HAT' in v:
                out['hat'] = round(v['HAT'] - nav, 2)
                out['hatEstimated'] = False
            else:
                out['hat'] = round(out['mhhw'] + 0.75, 2)
                out['hatEstimated'] = True
            return out
    raise RuntimeError('no tide station with NAVD88 near %s,%s' % (lat, lon))


# ---------------------------------------------------------------- rain
def rain(lat, lon):
    txt = curl(f'https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_mean.csv?data=depth&lat={lat}&lon={lon}&series=pds&units=english')
    lines = [l.strip() for l in txt.splitlines()]
    aris, rows = None, {}
    for l in lines:
        if l.lower().startswith('by duration for ari'):
            aris = [int(x) for x in l.split(':', 1)[1].split(',') if x.strip()]
        elif aris and ':' in l and l.split(':')[0] in ('60-min', '1-hr', '2-hr', '3-hr', '24-hr'):
            k, rest = l.split(':', 1)
            rows['1-hr' if k == '60-min' else k] = [float(x) for x in rest.split(',') if x.strip()]
        if aris and len(rows) == 4:
            break
    if not aris or len(rows) < 4:
        raise RuntimeError('could not parse Atlas 14 for %s,%s' % (lat, lon))
    return {'ari': aris, 'h1': rows['1-hr'], 'h2': rows['2-hr'], 'h3': rows['3-hr'], 'h24': rows['24-hr']}


# ---------------------------------------------------------------- osm
def osm(s, w, n, e):
    q = f'[out:json][timeout:90];(way["highway"]({s},{w},{n},{e});way["building"]({s},{w},{n},{e});way["natural"~"water|beach"]({s},{w},{n},{e});relation["natural"="water"]({s},{w},{n},{e}););out geom;'
    api = f'https://api.openstreetmap.org/api/0.6/map?bbox={w},{s},{e},{n}'
    api_cached = os.path.exists(os.path.join(CACHE, hashlib.md5(repr((api, None)).encode()).hexdigest() + '.txt'))
    try:
        if api_cached:
            raise RuntimeError('using the cached OpenStreetMap API copy')
        return json.loads(curl('https://overpass.private.coffee/api/interpreter', data=q, tries=2))['elements']
    except Exception as ex:
        print('   overpass failed, using the OpenStreetMap API instead:', ex)
    # Fallback: the main OSM API returns raw XML for a bounding box
    import xml.etree.ElementTree as ET
    root = ET.fromstring(curl(api))
    nodes = {nd.get('id'): (float(nd.get('lat')), float(nd.get('lon'))) for nd in root.iter('node')}
    out = []
    for way in root.iter('way'):
        tags = {t.get('k'): t.get('v') for t in way.iter('tag')}
        if not ('highway' in tags or 'building' in tags or tags.get('natural') in ('water', 'beach')):
            continue
        geom = [{'lat': nodes[r.get('ref')][0], 'lon': nodes[r.get('ref')][1]} for r in way.iter('nd') if r.get('ref') in nodes]
        out.append({'type': 'way', 'tags': tags, 'geometry': geom})
    return out


def haversine(a1, o1, a2, o2):
    R = 6371000
    p1, p2 = math.radians(a1), math.radians(a2)
    dp, dl = p2 - p1, math.radians(o2 - o1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def poly_area_m2(pts):
    a = 0
    for i in range(len(pts)):
        x1, y1 = pts[i]; x2, y2 = pts[(i + 1) % len(pts)]
        a += x1 * y2 - x2 * y1
    return abs(a) / 2


def build(pid, name, county, water, lat0, lon0):
    print('==', pid)
    span = 1800  # meters fetched around the given center, to search for the best grid
    dlat = span / 2 / 110540
    dlon = span / 2 / (111320 * math.cos(math.radians(lat0)))
    els = osm(lat0 - dlat, lon0 - dlon, lat0 + dlat, lon0 + dlon)
    kx = 111320 * math.cos(math.radians(lat0))
    to_m = lambda la, lo: ((lo - lon0) * kx, (lat0 - la) * 110540)  # x east, y south, meters from the given center

    roads, bldgs, waters, beaches, bridges = [], [], [], [], []
    for el in els:
        t = el.get('tags', {})
        geoms = []
        if el['type'] == 'way' and 'geometry' in el:
            geoms = [el['geometry']]
        elif el['type'] == 'relation':
            geoms = [m['geometry'] for m in el.get('members', []) if m.get('role') == 'outer' and 'geometry' in m]
        for g in geoms:
            pts = [to_m(p['lat'], p['lon']) for p in g]
            if 'highway' in t and t['highway'] in ROAD_W:
                if t.get('bridge', 'no') != 'no':
                    bridges.append((ROAD_W[t['highway']], pts))  # elevated decks are not ground
                elif t.get('tunnel', 'no') == 'no':
                    roads.append((ROAD_W[t['highway']], pts))
            elif 'building' in t and len(pts) > 2:
                bldgs.append(pts)
            elif t.get('natural') == 'water' and len(pts) > 2:
                waters.append(pts)
            elif t.get('natural') == 'beach' and len(pts) > 2:
                beaches.append(pts)

    # Score candidate centers: want many small buildings, some open water nearby, mostly land
    best = None
    for oy in range(-450, 451, 150):
        for ox in range(-450, 451, 150):
            half = N * CELL / 2
            nb = sum(1 for b in bldgs if 60 < poly_area_m2(b) < 500 and all(abs(p[0] - ox) < half - 20 and abs(p[1] - oy) < half - 20 for p in b[:1]))
            land = 0; samples = 0; low = 0
            for sy in range(8):
                for sx in range(8):
                    mx = ox - half + (sx + 0.5) * N * CELL / 8
                    my = oy - half + (sy + 0.5) * N * CELL / 8
                    la, lo = lat0 - my / 110540, lon0 + mx / kx
                    e = elev_m(la, lo)
                    samples += 1
                    if e > 0.3: land += 1
                    else: low += 1
            frac = land / samples
            if frac < 0.45 or frac > 0.97:
                continue
            score = nb * (1.0 if low > 0 else 0.4) - abs(frac - 0.75) * 40
            if best is None or score > best[0]:
                best = (score, ox, oy, nb, frac)
    if best is None:
        raise RuntimeError('no usable grid near ' + pid)
    _, ox, oy, nb, frac = best
    print(f'   center offset {ox},{oy} m, {nb} houses, land {frac:.0%}')
    clat, clon = lat0 - oy / 110540, lon0 + ox / kx

    def g(p):  # meters (from given center) to grid coords
        return ((p[0] - ox) / CELL + N / 2 - 0.5, (p[1] - oy) / CELL + N / 2 - 0.5)

    # Elevation: average 3x3 samples per cell, feet NAVD88
    elev = []
    for gy in range(N):
        for gx in range(N):
            acc = 0
            for sy in (-0.33, 0, 0.33):
                for sx in (-0.33, 0, 0.33):
                    mx = (gx + 0.5 + sx - N / 2) * CELL + ox
                    my = (gy + 0.5 + sy - N / 2) * CELL + oy
                    acc += elev_m(lat0 - my / 110540, lon0 + mx / kx)
            elev.append(acc / 9 * M2FT)

    # Rasterize OSM at 8x and downsample to cell fractions
    S = 8
    def mask(polys, lines=None):
        im = Image.new('L', (N * S, N * S), 0)
        d = ImageDraw.Draw(im)
        for p in polys or []:
            d.polygon([((x + 0.5) * S, (y + 0.5) * S) for x, y in map(g, p)], fill=255)
        for w, p in lines or []:
            d.line([((x + 0.5) * S, (y + 0.5) * S) for x, y in map(g, p)], fill=255, width=max(1, int(w * S)))
        return im.resize((N, N), Image.BOX)
    road_m = mask(None, roads)
    water_m = mask(waters)
    beach_m = mask(beaches)

    # Open (tidal) water: low or mapped water, connected to the grid edge
    # The elevation tiles include bridge decks. Under a bridge, use the low ground (or water) around it instead.
    bridge_m = mask(None, [(w + 1.5, p) for w, p in bridges])
    under = [bridge_m.getpixel((i % N, i // N)) > 60 for i in range(N * N)]
    fixed = elev[:]
    for i in range(N * N):
        if not under[i]:
            continue
        x, y = i % N, i // N
        nb = sorted(elev[yy * N + xx] for yy in range(max(0, y - 4), min(N, y + 5)) for xx in range(max(0, x - 4), min(N, x + 5)) if not under[yy * N + xx])
        fixed[i] = nb[len(nb) // 5] if nb else min(elev[i], 0.0)
    elev = fixed
    wet = [elev[i] < 0.6 or water_m.getpixel((i % N, i // N)) > 128 for i in range(N * N)]
    open_ = [0] * (N * N)
    stack = [i for i in range(N * N) if wet[i] and (i % N in (0, N - 1) or i // N in (0, N - 1))]
    for i in stack: open_[i] = 1
    while stack:
        i = stack.pop(); x, y = i % N, i // N
        for j in (i - 1 if x > 0 else -1, i + 1 if x < N - 1 else -1, i - N if y > 0 else -1, i + N if y < N - 1 else -1):
            if j >= 0 and wet[j] and not open_[j]:
                open_[j] = 1; stack.append(j)

    surface = []
    for i in range(N * N):
        x, y = i % N, i // N
        if open_[i]: s = 0; elev[i] = min(elev[i], -3.0)
        elif water_m.getpixel((x, y)) > 128: s = 7  # inland pond
        elif road_m.getpixel((x, y)) > 110: s = 3
        elif beach_m.getpixel((x, y)) > 128: s = 1
        else: s = 2
        surface.append(s)

    # Houses: small buildings, spaced at least 2 cells apart, on land
    houses, taken = [], set()
    cand = []
    for b in bldgs:
        a = poly_area_m2(b)
        if not 60 < a < 500: continue
        cx = sum(p[0] for p in b) / len(b); cy = sum(p[1] for p in b) / len(b)
        gx, gy = g((cx, cy))
        if 1 <= gx < N - 2 and 1 <= gy < N - 2 and not open_[int(round(gy)) * N + int(round(gx))]:
            cand.append((math.hypot(gx - N / 2, gy - N / 2), gx, gy))
    cand.sort()
    for _, gx, gy in cand:
        x0, y0 = int(gx - 0.5 + 0.5), int(gy - 0.5 + 0.5)
        cells = [y0 * N + x0, y0 * N + x0 + 1, (y0 + 1) * N + x0, (y0 + 1) * N + x0 + 1]
        if any(c in taken or open_[c] or surface[c] in (3, 7) for c in cells): continue
        ring = {(y0 + dy) * N + x0 + dx for dy in range(-1, 3) for dx in range(-1, 3)}
        if ring & taken: continue
        houses.append(cells)
        taken |= set(cells)
        for c in cells: surface[c] = 4
        if len(houses) >= 36: break

    # Larger buildings keep their real outline (grid coords); their roofs shed water like pavement
    big, big_polys = [], []
    for b in bldgs:
        a = poly_area_m2(b)
        if a >= 500:
            pts = [tuple(round(v, 2) for v in g(q)) for q in b]
            xs, ys = zip(*pts)
            mx_, my_ = int(round(sum(xs) / len(xs))), int(round(sum(ys) / len(ys)))
            on_water = 0 <= mx_ < N and 0 <= my_ < N and (open_[my_ * N + mx_] or surface[my_ * N + mx_] == 7)
            if max(xs) > 0 and min(xs) < N - 1 and max(ys) > 0 and min(ys) < N - 1 and not on_water:
                big.append({'a': round(a), 'pts': pts})
                big_polys.append(b)
    big.sort(key=lambda o: -o['a'])
    big = big[:120]
    bm = mask(big_polys)
    for i in range(N * N):
        if not open_[i] and surface[i] not in (4, 7) and bm.getpixel((i % N, i // N)) > 128:
            surface[i] = 3

    road_lines = []
    for w, p in roads:
        pts = [tuple(round(v, 2) for v in g(q)) for q in p]
        if any(-6 < x < N + 6 and -6 < y < N + 6 for x, y in pts):
            road_lines.append({'w': w, 'pts': pts})

    data = {
        'id': pid, 'name': name, 'county': county, 'waterName': water,
        'lat': round(clat, 5), 'lon': round(clon, 5), 'n': N, 'cellMeters': CELL,
        'elev': [round(v, 2) for v in elev], 'surface': surface, 'open': open_,
        'houses': houses, 'roads': road_lines, 'bigBuildings': big[:120],
        'tide': tides(clat, clon), 'rain': rain(clat, clon),
        'sources': ['USGS 3DEP elevation (AWS Terrain Tiles)', 'OpenStreetMap contributors', 'NOAA CO-OPS tide datums', 'NOAA Atlas 14 precipitation frequency'],
    }
    json.dump(data, open(os.path.join(OUT, pid + '.json'), 'w'), separators=(',', ':'))
    t = data['tide']
    print(f"   {len(houses)} houses, {len(road_lines)} roads, tide {t['stationName']} MHHW {t['mhhw']} HAT {t['hat']} ft NAVD88")


want = set(sys.argv[1:])
for p in PLACES:
    if want and p[0] not in want:
        continue
    try:
        build(*p)
    except Exception as ex:
        print('   SKIPPED', p[0], ex)
