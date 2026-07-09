/*
 * Contourlines — interactive world contour map & sea level simulator.
 * Vanilla JS + WebGL2, no dependencies. MIT license.
 *
 * Rendering: a lon/lat grid mesh is projected either as an equirectangular
 * flat map (drawn in wrapping copies for seamless horizontal panning) or as
 * an orthographic globe; the vertex shader blends the two by uMorph, so
 * zooming out "rolls" the map onto a sphere. The fragment shader decodes a
 * 16-bit elevation heightmap packed into the R/G channels of a PNG, applies
 * hypsometric tints relative to the current sea level, and draws
 * screen-space anti-aliased contour lines, coastline, hillshade,
 * a reference line marking today's coastline, and an optional graticule.
 */

'use strict';

const DEG_R = 57.29577951308232; // 180/pi: globe radius = scale(px/deg) * DEG_R

// ------------------------------------------------------------------ i18n

// Supported languages in picker order. English and Simplified Chinese ship
// inline (instant first paint); the rest load on demand from locales/*.json.
const LANGS = [
  ['en', 'English'], ['zh', '简体中文'], ['zh-Hant', '繁體中文'], ['ja', '日本語'],
  ['ko', '한국어'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['pt', 'Português'], ['ru', 'Русский'], ['ar', 'العربية'],
];

const LOCALES = {
  en: {
    name: 'English', dir: 'ltr',
    ui: {
      tagline: 'Drag the sea level, redraw the world',
      seaLevel: 'Sea level', iceAge: 'Ice Age', today: 'Today', allMelt: 'Ice melted',
      contourInterval: 'Contour interval', auto: 'Auto',
      highlight: "Today's coastline", hillshade: 'Hillshade', graticule: 'Grid lines',
      about: 'About', loading: 'Loading terrain…', loadFail: 'Failed to load terrain data.',
      underWater: 'under water', aboveSea: 'above sea',
      playTitle: 'Animate sea level',
      sliderAria: 'Sea level offset, exponential scale from the Mariana Trench to Mount Everest',
      numAria: 'Sea level offset in meters, exact value',
      collapseTitle: 'Collapse panel', zoomIn: 'Zoom in', zoomOut: 'Zoom out',
      globeView: 'Globe view', closeAria: 'Close', langLabel: 'Language',
      webglTitle: 'WebGL2 required',
      webglBody: 'Contourlines needs WebGL2 to render the map. Please use a recent version of Chrome, Edge, Firefox, or Safari, and make sure hardware acceleration is enabled.',
      docTitle: 'Contourlines — Interactive World Contour Map & Sea Level Rise Simulator',
    },
  },
  zh: {
    name: '简体中文', dir: 'ltr',
    ui: {
      tagline: '拖动海平面，重绘世界',
      seaLevel: '海平面', iceAge: '冰河期', today: '现今', allMelt: '冰盖融化',
      contourInterval: '等高线间距', auto: '自动',
      highlight: '今日海岸线', hillshade: '山体阴影', graticule: '经纬网',
      about: '关于', loading: '正在加载地形…', loadFail: '地形数据加载失败。',
      underWater: '低于海面', aboveSea: '高于海面',
      playTitle: '播放海平面动画',
      sliderAria: '海平面偏移，指数刻度，从马里亚纳海沟到珠穆朗玛峰',
      numAria: '海平面偏移量（米），精确值',
      collapseTitle: '折叠面板', zoomIn: '放大', zoomOut: '缩小',
      globeView: '地球视图', closeAria: '关闭', langLabel: '语言',
      webglTitle: '需要 WebGL2',
      webglBody: 'Contourlines 需要 WebGL2 来渲染地图。请使用新版 Chrome、Edge、Firefox 或 Safari，并确保已开启硬件加速。',
      docTitle: 'Contourlines — 交互式世界等高线地图与海平面模拟器',
    },
  },
};

/** Map a BCP-47 tag to a supported locale code, or null. */
function matchLocale(tag) {
  if (!tag) return null;
  const t = String(tag).toLowerCase().replace(/_/g, '-');
  if (t === 'zh' || t.startsWith('zh-')) {
    return /hant|-tw|-hk|-mo/.test(t) ? 'zh-Hant' : 'zh';
  }
  const exact = LANGS.find(([c]) => c.toLowerCase() === t);
  if (exact) return exact[0];
  const primary = t.split('-')[0];
  const byPrimary = LANGS.find(([c]) => c.toLowerCase() === primary);
  return byPrimary ? byPrimary[0] : null;
}

// ---------------------------------------------------------------- shaders

const MESH_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aLonLat;
uniform vec2 uCenter;
uniform float uScale;
uniform float uMorph;
uniform vec2 uViewport;
uniform float uCopyOffset;
out vec2 vLonLat;
void main() {
  float lon = aLonLat.x + uCopyOffset;
  float lat = aLonLat.y;
  vLonLat = vec2(lon, lat);
  float dlon = lon - uCenter.x;
  vec2 flatPos = vec2(dlon, lat - uCenter.y) * uScale;
  float R = uScale * ${DEG_R};
  float lam = radians(dlon);
  float phi = radians(lat);
  float phi0 = radians(uCenter.y);
  vec3 p = vec3(cos(phi) * sin(lam), sin(phi), cos(phi) * cos(lam));
  float y2 = p.y * cos(phi0) - p.z * sin(phi0);
  float z2 = p.y * sin(phi0) + p.z * cos(phi0);
  vec2 globePos = vec2(p.x, y2) * R;
  vec2 pos = mix(flatPos, globePos, uMorph);
  gl_Position = vec4(pos * 2.0 / uViewport, -z2 * uMorph * 0.5, 1.0);
}`;

const MESH_FS = `#version 300 es
precision highp float;
in vec2 vLonLat;
uniform sampler2D uTex;
uniform sampler2D uLUT;
uniform vec2 uTexSize;
uniform float uSeaLevel;
uniform float uInterval;
uniform float uAlpha;
uniform float uHillshade;
uniform float uGraticule;
uniform float uRefCoast;
uniform float uMetersPerPx;
out vec4 fragColor;

float decode(vec4 c) { return c.r * 65280.0 + c.g * 255.0 - 11000.0; }

float elevAt(vec2 ll) {
  float W = uTexSize.x, H = uTexSize.y;
  float fx = (ll.x + 180.0) / 360.0 * W;
  float fy = (90.0 - ll.y) / 180.0 * H;
  fx -= W * floor(fx / W);
  fy = clamp(fy, 0.0, H - 1.0001);
  float x0 = floor(fx), y0 = floor(fy);
  vec2 f = vec2(fx - x0, fy - y0);
  int ix0 = int(x0), iy0 = int(y0);
  int ix1 = ix0 + 1 == int(W) ? 0 : ix0 + 1;
  int iy1 = min(iy0 + 1, int(H) - 1);
  float e00 = decode(texelFetch(uTex, ivec2(ix0, iy0), 0));
  float e10 = decode(texelFetch(uTex, ivec2(ix1, iy0), 0));
  float e01 = decode(texelFetch(uTex, ivec2(ix0, iy1), 0));
  float e11 = decode(texelFetch(uTex, ivec2(ix1, iy1), 0));
  return mix(mix(e00, e10, f.x), mix(e01, e11, f.x), f.y);
}

float lineAA(float f, float w) {
  float d = abs(fract(f + 0.5) - 0.5) / max(fwidth(f), 1e-7);
  return 1.0 - smoothstep(0.0, w, d);
}

void main() {
  float e = elevAt(vLonLat);
  float rel = e - uSeaLevel;
  bool water = rel < 0.0;

  vec3 col;
  if (water) {
    col = texture(uLUT, vec2(sqrt(clamp(-rel / 11000.0, 0.0, 1.0)), 0.25)).rgb;
  } else {
    col = texture(uLUT, vec2(sqrt(clamp(rel / 19850.0, 0.0, 1.0)), 0.75)).rgb;
  }

  if (uHillshade > 0.5) {
    vec2 g = vec2(dFdx(e), dFdy(e)) / max(uMetersPerPx, 1.0);
    vec3 n = normalize(vec3(-g.x, -g.y, 1.8));
    float lit = clamp(dot(n, normalize(vec3(-0.55, 0.62, 0.72))), 0.0, 1.0);
    float amt = water ? 0.20 : 0.52;
    col *= (1.0 - amt) + amt * (0.35 + 1.15 * lit);
  }

  // contour lines relative to the current sea level: isolines above the new
  // shoreline, isobaths (shallow to deep) below it — including flooded land
  float f = rel / uInterval;
  float fadeMinor = 1.0 - smoothstep(0.30, 0.65, fwidth(f));
  float fadeMajor = 1.0 - smoothstep(0.30, 0.65, fwidth(f) / 5.0);
  vec3 lineCol = water ? vec3(0.16, 0.32, 0.50) : vec3(0.35, 0.27, 0.17);
  col = mix(col, lineCol, lineAA(f, 1.0) * (water ? 0.24 : 0.26) * fadeMinor);
  col = mix(col, lineCol, lineAA(f / 5.0, 1.25) * (water ? 0.40 : 0.45) * fadeMajor);

  // coastline at the current sea level
  float coast = 1.0 - smoothstep(0.0, 1.5, abs(rel) / max(fwidth(rel), 1e-7));
  col = mix(col, vec3(0.05, 0.23, 0.42), coast * 0.75);

  // reference line marking today's (0 m) coastline while sea level != 0, so
  // the flooded or reclaimed band between old and new coasts is obvious
  if (uRefCoast > 0.5) {
    float refc = 1.0 - smoothstep(0.0, 1.25, abs(e) / max(fwidth(e), 1e-7));
    col = mix(col, vec3(0.80, 0.22, 0.14), refc * 0.78);
  }

  if (uGraticule > 0.5) {
    vec2 gf = vLonLat / 15.0;
    vec2 gg = abs(fract(gf + 0.5) - 0.5) / max(fwidth(gf), vec2(1e-7));
    float grat = 1.0 - smoothstep(0.6, 1.6, min(gg.x, gg.y));
    col = mix(col, vec3(0.15, 0.3, 0.45), grat * 0.30);
  }

  fragColor = vec4(col, uAlpha);
}`;

const BG_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const BG_FS = `#version 300 es
precision highp float;
uniform vec2 uViewport;
uniform float uR;
uniform float uMorph;
out vec4 fragColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 px = gl_FragCoord.xy;
  vec3 col = mix(vec3(0.014, 0.02, 0.045), vec3(0.035, 0.055, 0.11), px.y / uViewport.y);
  vec2 cell = floor(px / 2.0);
  float h = hash(cell);
  if (h > 0.9974) col += vec3(0.85, 0.9, 1.0) * ((h - 0.9974) / 0.0026) * 0.45 * (0.4 + 0.6 * hash(cell + 7.0));
  if (uMorph > 0.01) {
    float d = length(px - uViewport * 0.5) - uR;
    if (d > 0.0) {
      float glow = exp(-d / (uR * 0.05)) * 0.5 + exp(-d / (uR * 0.18)) * 0.13;
      col += vec3(0.35, 0.6, 1.0) * glow * uMorph;
    }
  }
  fragColor = vec4(col, 1.0);
}`;

// ----------------------------------------------------------- GL utilities

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('Shader error: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

function makeProgram(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('Link error: ' + gl.getProgramInfoLog(p));
  }
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { prog: p, u: uniforms };
}

// -------------------------------------------------------------- palettes

function evalStops(stops, v) {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [v0, c0] = stops[i - 1], [v1, c1] = stops[i];
      const t = (v - v0) / (v1 - v0);
      return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * t);
    }
  }
  return stops[stops.length - 1][1];
}

const OCEAN_STOPS = [
  [0, [216, 242, 250]], [50, [198, 236, 255]], [200, [185, 227, 255]],
  [1000, [172, 219, 251]], [2000, [161, 210, 247]], [3000, [150, 201, 240]],
  [4000, [141, 193, 234]], [5000, [132, 185, 227]], [6000, [121, 178, 222]],
  [8000, [104, 163, 210]], [11000, [86, 146, 197]],
];
// Land palette spans the full possible height above the waterline: with the
// ocean drained to -11000 m, old seafloor can sit ~19850 m above the new sea,
// so the ramp keeps stepping (brown -> red-brown -> rose grey -> warm grey)
// instead of jumping to white after the yellows.
const LAND_MAX = 19850;
const LAND_STOPS = [
  [0, [172, 208, 165]], [50, [148, 191, 139]], [200, [168, 198, 143]],
  [500, [189, 204, 150]], [1000, [209, 215, 171]], [1500, [225, 228, 181]],
  [2000, [239, 235, 192]], [2500, [232, 225, 182]], [3000, [222, 214, 163]],
  [3500, [211, 202, 157]], [4000, [202, 185, 130]], [4500, [195, 167, 107]],
  [5000, [185, 152, 90]], [5500, [170, 135, 83]], [6500, [158, 118, 76]],
  [7500, [148, 103, 68]], [8500, [143, 94, 72]], [9500, [149, 100, 90]],
  [11000, [161, 120, 110]], [12500, [173, 141, 130]], [14000, [186, 161, 150]],
  [15500, [201, 181, 170]], [17000, [221, 206, 196]], [18500, [239, 233, 227]],
  [19850, [250, 249, 247]],
];

function buildLUT(gl) {
  const W = 1024;
  const data = new Uint8Array(W * 2 * 4);
  for (let i = 0; i < W; i++) {
    const t = i / (W - 1);
    const oc = evalStops(OCEAN_STOPS, t * t * 11000);
    const lc = evalStops(LAND_STOPS, t * t * LAND_MAX);
    data.set([oc[0], oc[1], oc[2], 255], i * 4);
    data.set([lc[0], lc[1], lc[2], 255], (W + i) * 4);
  }
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

// ------------------------------------------------------------- data load

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return new Blob([await res.arrayBuffer()]);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onProgress) onProgress(got / total);
  }
  return new Blob(chunks);
}

async function decodeElevation(blob) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob, {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
  } catch (_) {
    // older Safari rejects the options bag; the PNG is fully opaque, so
    // premultiplication is a no-op and a plain decode is still lossless
    bmp = await createImageBitmap(blob);
  }
  const W = bmp.width, H = bmp.height;
  const cnv = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(W, H)
    : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const px = ctx.getImageData(0, 0, W, H).data;
  const elev = new Int16Array(W * H);
  for (let i = 0; i < W * H; i++) elev[i] = ((px[i * 4] << 8) | px[i * 4 + 1]) - 11000;
  return { W, H, px, elev };
}

// ------------------------------------------------------------------ main

function main() {
  const canvas = document.getElementById('map');
  const gl = canvas.getContext('webgl2', {
    antialias: true,
    depth: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    document.getElementById('webgl-error').hidden = false;
    document.getElementById('loader').classList.add('done');
    return;
  }

  const mesh = makeProgram(gl, MESH_VS, MESH_FS);
  const bg = makeProgram(gl, BG_VS, BG_FS);
  buildLUT(gl);

  // lon/lat grid mesh
  const SEG_X = 192, SEG_Y = 96;
  let meshVao;
  {
    const verts = new Float32Array((SEG_X + 1) * (SEG_Y + 1) * 2);
    let vi = 0;
    for (let y = 0; y <= SEG_Y; y++) {
      for (let x = 0; x <= SEG_X; x++) {
        verts[vi++] = -180 + (360 * x) / SEG_X;
        verts[vi++] = 90 - (180 * y) / SEG_Y;
      }
    }
    const idx = new Uint32Array(SEG_X * SEG_Y * 6);
    let ii = 0;
    for (let y = 0; y < SEG_Y; y++) {
      for (let x = 0; x < SEG_X; x++) {
        const a = y * (SEG_X + 1) + x, b = a + 1, c = a + SEG_X + 1, d = c + 1;
        idx[ii++] = a; idx[ii++] = c; idx[ii++] = b;
        idx[ii++] = b; idx[ii++] = c; idx[ii++] = d;
      }
    }
    meshVao = gl.createVertexArray();
    gl.bindVertexArray(meshVao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  }
  const MESH_COUNT = SEG_X * SEG_Y * 6;
  const bgVao = gl.createVertexArray();

  // elevation texture
  const elevTex = gl.createTexture();
  let data = null; // { W, H, px, elev }
  function uploadElevation(d) {
    data = d;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, elevTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, d.W, d.H, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(d.px.buffer, d.px.byteOffset, d.px.length));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    dirty = true;
  }

  // --------------------------------------------------------- view state

  const params = new URLSearchParams(location.search);
  const num = (k, d) => (params.has(k) && isFinite(+params.get(k)) ? +params.get(k) : d);

  let vw = 0, vh = 0, dpr = 1;
  const view = {
    lon: num('lon', 105),
    lat: num('lat', 25),
    s: num('z', 0), // px per degree; 0 -> globe fit, resolved on first resize
    sea: num('sea', 0),
    interval: num('int', 0),
    highlight: num('hl', 1) > 0,
    hillshade: num('hs', 1) > 0,
    graticule: num('gr', 0) > 0,
  };
  let interacted = params.has('lon') || params.has('z') || num('spin', 1) === 0;
  let dirty = true;
  let dataError = false;
  let lang = 'en';
  let dict = LOCALES.en.ui;

  const sMax = 140;
  const sMin = () => 0.44 * Math.min(vw, vh) / DEG_R;
  const morphT = (s) => {
    const e0 = sMin() * 1.15, e1 = sMin() * 2.6;
    const x = Math.min(1, Math.max(0, (s - e0) / (e1 - e0)));
    return 1 - x * x * (3 - 2 * x);
  };
  const wrapLon = (x) => ((((x + 180) % 360) + 360) % 360) - 180;

  function clampView() {
    view.s = Math.min(sMax, Math.max(sMin(), view.s));
    const t = morphT(view.s);
    const hh = vh / 2 / view.s;
    const flatLimit = Math.max(0, 90 - hh);
    const limit = flatLimit * (1 - t) + 90 * t;
    view.lat = Math.min(limit, Math.max(-limit, view.lat));
    view.lon = wrapLon(view.lon);
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = canvas.clientWidth;
    vh = canvas.clientHeight;
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    if (view.s === 0) view.s = sMin();
    clampView();
    dirty = true;
  }
  window.addEventListener('resize', resize);
  resize();

  // ------------------------------------------------------------- render

  function autoInterval(s) {
    if (s < 3) return 1000;
    if (s < 10) return 500;
    if (s < 30) return 200;
    if (s < 80) return 100;
    return 50;
  }

  function draw() {
    const t = morphT(view.s);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    gl.useProgram(bg.prog);
    gl.bindVertexArray(bgVao);
    gl.uniform2f(bg.u.uViewport, canvas.width, canvas.height);
    gl.uniform1f(bg.u.uR, view.s * DEG_R * dpr);
    gl.uniform1f(bg.u.uMorph, t);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (!data) return;

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(mesh.prog);
    gl.bindVertexArray(meshVao);
    gl.uniform1i(mesh.u.uTex, 0);
    gl.uniform1i(mesh.u.uLUT, 1);
    gl.uniform2f(mesh.u.uTexSize, data.W, data.H);
    gl.uniform2f(mesh.u.uCenter, view.lon, view.lat);
    gl.uniform1f(mesh.u.uScale, view.s);
    gl.uniform1f(mesh.u.uMorph, t);
    gl.uniform2f(mesh.u.uViewport, vw, vh);
    gl.uniform1f(mesh.u.uSeaLevel, view.sea);
    gl.uniform1f(mesh.u.uInterval, view.interval || autoInterval(view.s));
    gl.uniform1f(mesh.u.uHillshade, view.hillshade ? 1 : 0);
    gl.uniform1f(mesh.u.uGraticule, view.graticule ? 1 : 0);
    gl.uniform1f(mesh.u.uRefCoast, view.highlight && Math.abs(view.sea) > 0.01 ? 1 : 0);
    gl.uniform1f(mesh.u.uMetersPerPx, 111320 / (view.s * dpr));

    const halfW = vw / 2 / view.s;
    for (let k = -3; k <= 3; k++) {
      if (k !== 0 && t > 0.95) continue;
      const lo = k * 360 - 180 - view.lon, hi = k * 360 + 180 - view.lon;
      if (hi < -halfW || lo > halfW) continue;
      gl.uniform1f(mesh.u.uCopyOffset, k * 360);
      gl.uniform1f(mesh.u.uAlpha, k === 0 ? 1 : 1 - t);
      gl.drawElements(gl.TRIANGLES, MESH_COUNT, gl.UNSIGNED_INT, 0);
    }
  }

  // ---------------------------------------------------------- animation

  let seaAnim = null; // { dir: 1 } ping-pong between -120 and +70
  let zoomAnim = null; // { s0, s1, lon0, lon1, lat0, lat1, t0, dur }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!interacted && morphT(view.s) === 1 && data && !dataError) {
      view.lon = wrapLon(view.lon + 0.06);
      dirty = true;
    }
    if (seaAnim) {
      let v = view.sea + seaAnim.dir * 0.28 * (view.s > 30 ? 0.35 : 1);
      if (v > 70) { v = 70; seaAnim.dir = -1; }
      if (v < -120) { v = -120; seaAnim.dir = 1; }
      setSea(v, false);
    }
    if (zoomAnim) {
      const a = Math.min(1, (now - zoomAnim.t0) / zoomAnim.dur);
      const e = 1 - (1 - a) * (1 - a);
      view.s = zoomAnim.s0 + (zoomAnim.s1 - zoomAnim.s0) * e;
      view.lon = zoomAnim.lon0 + (zoomAnim.lon1 - zoomAnim.lon0) * e;
      view.lat = zoomAnim.lat0 + (zoomAnim.lat1 - zoomAnim.lat0) * e;
      clampView();
      if (a >= 1) zoomAnim = null;
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      draw();
      scheduleUrlUpdate();
    }
  }

  function animateZoomTo(s1, lon1, lat1, dur = 400) {
    zoomAnim = {
      s0: view.s, s1, lon0: view.lon, lon1: lon1 ?? view.lon,
      lat0: view.lat, lat1: lat1 ?? view.lat, t0: performance.now(), dur,
    };
  }

  // -------------------------------------------------------- interaction

  function screenToLonLat(px, py) {
    const t = morphT(view.s);
    if (t < 0.5) {
      return [wrapLon(view.lon + (px - vw / 2) / view.s), view.lat - (py - vh / 2) / view.s];
    }
    const R = view.s * DEG_R;
    const X = (px - vw / 2) / R, Y = -(py - vh / 2) / R;
    const r2 = X * X + Y * Y;
    if (r2 > 1) return null;
    const Z = Math.sqrt(1 - r2);
    const phi0 = view.lat / DEG_R;
    const y = Y * Math.cos(phi0) + Z * Math.sin(phi0);
    const z = -Y * Math.sin(phi0) + Z * Math.cos(phi0);
    return [wrapLon(view.lon + Math.atan2(X, z) * DEG_R), Math.asin(Math.max(-1, Math.min(1, y))) * DEG_R];
  }

  function zoomAt(px, py, factor) {
    const t = morphT(view.s);
    const before = t < 0.5 ? screenToLonLat(px, py) : null;
    view.s = Math.min(sMax, Math.max(sMin(), view.s * factor));
    if (before && morphT(view.s) < 0.5) {
      view.lon = before[0] - (px - vw / 2) / view.s;
      view.lat = before[1] + (py - vh / 2) / view.s;
    }
    clampView();
    dirty = true;
  }

  const pointers = new Map();
  let pinchDist = 0;

  canvas.addEventListener('pointerdown', (ev) => {
    interacted = true;
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* synthetic events */ }
    pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
    canvas.classList.add('dragging');
    zoomAnim = null;
  });

  canvas.addEventListener('pointermove', (ev) => {
    updateReadout(ev.clientX, ev.clientY);
    if (!pointers.has(ev.pointerId)) return;
    const prev = pointers.get(ev.pointerId);
    pointers.set(ev.pointerId, [ev.clientX, ev.clientY]);
    if (pointers.size === 1) {
      view.lon -= (ev.clientX - prev[0]) / view.s;
      view.lat += (ev.clientY - prev[1]) / view.s;
      clampView();
      dirty = true;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinchDist > 0 && d > 0) {
        zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, d / pinchDist);
      }
      pinchDist = d;
    }
  });

  const endPointer = (ev) => {
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    interacted = true;
    zoomAt(ev.clientX, ev.clientY, Math.exp(-ev.deltaY * 0.0016));
  }, { passive: false });

  canvas.addEventListener('dblclick', (ev) => {
    interacted = true;
    zoomAt(ev.clientX, ev.clientY, 1.7);
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
    const pan = 60 / view.s;
    let handled = true;
    if (ev.key === '+' || ev.key === '=') zoomAt(vw / 2, vh / 2, 1.35);
    else if (ev.key === '-') zoomAt(vw / 2, vh / 2, 1 / 1.35);
    else if (ev.key === 'ArrowLeft') view.lon -= pan;
    else if (ev.key === 'ArrowRight') view.lon += pan;
    else if (ev.key === 'ArrowUp') view.lat += pan;
    else if (ev.key === 'ArrowDown') view.lat -= pan;
    else if (ev.key === 'Home') animateZoomTo(sMin());
    else if (ev.key === 'Escape') aboutEl.hidden = true;
    else handled = false;
    if (handled) {
      interacted = true;
      clampView();
      dirty = true;
      ev.preventDefault();
    }
  });

  // ------------------------------------------------------------ readout

  const readoutEl = document.getElementById('readout');

  function elevCPU(lon, lat) {
    if (!data) return null;
    const { W, H, elev } = data;
    let fx = ((lon + 180) / 360) * W;
    let fy = ((90 - lat) / 180) * H;
    fx -= W * Math.floor(fx / W);
    fy = Math.min(H - 1.0001, Math.max(0, fy));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = (x0 + 1) % W, y1 = Math.min(y0 + 1, H - 1);
    const gx = fx - x0, gy = fy - y0;
    const e00 = elev[y0 * W + x0], e10 = elev[y0 * W + x1];
    const e01 = elev[y1 * W + x0], e11 = elev[y1 * W + x1];
    return (e00 * (1 - gx) + e10 * gx) * (1 - gy) + (e01 * (1 - gx) + e11 * gx) * gy;
  }

  function updateReadout(px, py) {
    const ll = screenToLonLat(px, py);
    if (!ll || !data) { readoutEl.hidden = true; return; }
    const e = Math.round(elevCPU(ll[0], ll[1]));
    const latS = `${Math.abs(ll[1]).toFixed(2)}°${ll[1] >= 0 ? 'N' : 'S'}`;
    const lonS = `${Math.abs(ll[0]).toFixed(2)}°${ll[0] >= 0 ? 'E' : 'W'}`;
    const rel = e - view.sea;
    const s = dict;
    const status = rel < 0
      ? ` · <b>${Math.round(-rel)} m</b> ${s.underWater}`
      : (view.sea !== 0 ? ` · <b>${Math.round(rel)} m</b> ${s.aboveSea}` : '');
    readoutEl.innerHTML = `${latS} ${lonS} · <b>${e} m</b>${status}`;
    readoutEl.hidden = false;
  }

  // ----------------------------------------------------------------- UI

  const $ = (id) => document.getElementById(id);
  const seaSlider = $('sea-slider'), seaNum = $('sea-num'), seaValue = $('sea-value');
  const aboutEl = $('about');

  function detectLang() {
    const candidates = [
      params.get('lang'),
      localStorage.getItem('cl-lang'),
      ...(navigator.languages || []),
      navigator.language,
    ];
    for (const c of candidates) {
      const m = matchLocale(c);
      if (m) return m;
    }
    return 'en';
  }

  async function loadLocale(code) {
    if (LOCALES[code]) return LOCALES[code];
    const res = await fetch(`locales/${code}.json`);
    if (!res.ok) throw new Error(`locale ${code}: HTTP ${res.status}`);
    const loc = await res.json();
    LOCALES[code] = loc;
    return loc;
  }

  const esc = (s) => String(s).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // trusted HTML: locale files are authored content shipped with the app
  function renderAbout(el, a) {
    el.innerHTML = [
      `<h2>${esc(a.title)}</h2>`,
      `<p>${a.intro}</p>`,
      `<h3>${esc(a.howTitle)}</h3>`,
      `<ul>${a.how.map((li) => `<li>${li}</li>`).join('')}</ul>`,
      `<h3>${esc(a.faqTitle)}</h3>`,
      `<dl>${a.faq.map((f) => `<dt>${esc(f.q)}</dt><dd>${f.a}</dd>`).join('')}</dl>`,
      `<h3>${esc(a.dataTitle)}</h3>`,
      `<p>${a.data}</p>`,
    ].join('');
  }

  const ATTR_I18N = [
    ['sea-play', 'title', 'playTitle'], ['sea-play', 'aria-label', 'playTitle'],
    ['sea-slider', 'aria-label', 'sliderAria'], ['sea-num', 'aria-label', 'numAria'],
    ['collapse', 'title', 'collapseTitle'], ['collapse', 'aria-label', 'collapseTitle'],
    ['zoom-in', 'title', 'zoomIn'], ['zoom-in', 'aria-label', 'zoomIn'],
    ['zoom-out', 'title', 'zoomOut'], ['zoom-out', 'aria-label', 'zoomOut'],
    ['zoom-globe', 'title', 'globeView'], ['zoom-globe', 'aria-label', 'globeView'],
    ['about-close', 'aria-label', 'closeAria'],
    ['lang', 'title', 'langLabel'], ['lang', 'aria-label', 'langLabel'],
  ];

  async function setLang(code) {
    let loc;
    try {
      loc = await loadLocale(code);
    } catch (err) {
      console.error(err);
      code = 'en';
      loc = LOCALES.en;
    }
    lang = code;
    dict = loc.ui;
    document.documentElement.lang = code;
    document.documentElement.dir = loc.dir || 'ltr';
    document.body.dataset.lang = code;
    document.title = dict.docTitle;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      if (dict[key]) el.textContent = dict[key];
    });
    for (const [id, attr, key] of ATTR_I18N) {
      const el = $(id);
      if (el && dict[key]) el.setAttribute(attr, dict[key]);
    }
    const dyn = $('about-dyn');
    document.querySelector('#about-card article[data-lang="en"]').hidden = code !== 'en';
    document.querySelector('#about-card article[data-lang="zh"]').hidden = code !== 'zh';
    dyn.hidden = code === 'en' || code === 'zh';
    if (!dyn.hidden && loc.about) renderAbout(dyn, loc.about);
    $('lang').value = code;
    localStorage.setItem('cl-lang', code);
    if (!data) loaderText.textContent = dict.loading;
    setSea(view.sea, false); // refresh aria-valuetext wording
  }

  // populate the picker and apply the detected language
  for (const [code, name] of LANGS) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    $('lang').appendChild(opt);
  }
  $('lang').addEventListener('change', (ev) => setLang(ev.target.value));
  setLang(detectLang());

  // Exponential slider: full planetary range, fine-grained near 0.
  // slider x in [-1, 1]  ->  sea = sign(x) * (e^(k|x|) - 1)/(e^k - 1) * side,
  // where side is the Challenger Deep (-11000 m) or Everest (+8848 m).
  const SEA_MIN = -11000, SEA_MAX = 8848, SEA_K = 6;
  const SEA_E = Math.exp(SEA_K) - 1;

  function seaFromSlider(x) {
    const side = x < 0 ? -SEA_MIN : SEA_MAX;
    const v = Math.sign(x) * ((Math.exp(SEA_K * Math.abs(x)) - 1) / SEA_E) * side;
    // magnetic detents: snap to the preset values when within ~one slider
    // notch, so -120/0/+70 are reachable by dragging even where the
    // exponential scale is coarser than the friendly rounding below
    const notch = ((SEA_K * Math.exp(SEA_K * Math.abs(x))) / SEA_E) * side * 0.002;
    for (const p of [-120, 0, 70]) {
      if (Math.abs(v - p) < Math.max(0.5, 0.6 * notch)) return p;
    }
    const a = Math.abs(v);
    const step = a >= 3000 ? 50 : a >= 1000 ? 10 : a >= 200 ? 5 : a >= 50 ? 1 : 0.5;
    return Math.round(v / step) * step;
  }

  function sliderFromSea(v) {
    const side = v < 0 ? -SEA_MIN : SEA_MAX;
    const m = Math.min(1, Math.abs(v) / side);
    return (Math.sign(v) * Math.log(1 + m * SEA_E)) / SEA_K;
  }

  function setSea(v, stopAnim = true, fromSlider = false) {
    v = Math.min(SEA_MAX, Math.max(SEA_MIN, v));
    view.sea = v;
    if (stopAnim && seaAnim) { seaAnim = null; $('sea-play').textContent = '▶'; }
    // never write the thumb position back while the slider itself is the
    // source — the rounding would undo small keyboard steps and wedge it
    if (!fromSlider) seaSlider.value = String(sliderFromSea(v));
    const label = `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10} m`;
    seaSlider.setAttribute('aria-valuetext', label);
    seaNum.value = String(Math.round(v * 10) / 10);
    seaValue.textContent = label;
    document.querySelectorAll('.preset').forEach((b) => {
      b.classList.toggle('active', Math.abs(+b.dataset.sea - v) < 0.25);
    });
    dirty = true;
  }

  // tick marks at exponential positions along the slider scale
  {
    const scale = $('sea-scale');
    for (const v of [-10000, -3000, -1000, -300, -100, 0, 100, 300, 1000, 3000, 8000]) {
      const t = document.createElement('span');
      t.className = 'tick' + (v === 0 ? ' zero' : '');
      const p = (sliderFromSea(v) + 1) / 2;
      t.style.left = `calc(8.5px + (100% - 17px) * ${p.toFixed(4)})`;
      t.title = `${v > 0 ? '+' : ''}${v} m`;
      scale.appendChild(t);
    }
    const lo = document.createElement('b');
    lo.textContent = `${SEA_MIN}`;
    const hi = document.createElement('b');
    hi.textContent = `+${SEA_MAX}`;
    hi.style.right = '0';
    scale.append(lo, hi);
  }

  seaSlider.addEventListener('input', () => setSea(seaFromSlider(+seaSlider.value), true, true));
  seaNum.addEventListener('change', () => setSea(+seaNum.value || 0));
  document.querySelectorAll('.preset').forEach((b) => {
    b.addEventListener('click', () => setSea(+b.dataset.sea));
  });

  $('sea-play').addEventListener('click', () => {
    if (seaAnim) {
      seaAnim = null;
      $('sea-play').textContent = '▶';
    } else {
      seaAnim = { dir: view.sea >= 70 ? -1 : 1 };
      $('sea-play').textContent = '⏸';
    }
  });

  $('interval').addEventListener('change', (ev) => {
    view.interval = +ev.target.value;
    dirty = true;
  });
  $('highlight').addEventListener('change', (ev) => { view.highlight = ev.target.checked; dirty = true; });
  $('hillshade').addEventListener('change', (ev) => { view.hillshade = ev.target.checked; dirty = true; });
  $('graticule').addEventListener('change', (ev) => { view.graticule = ev.target.checked; dirty = true; });

  $('zoom-in').addEventListener('click', () => { interacted = true; animateZoomTo(Math.min(sMax, view.s * 1.6)); });
  $('zoom-out').addEventListener('click', () => { interacted = true; animateZoomTo(Math.max(sMin(), view.s / 1.6)); });
  $('zoom-globe').addEventListener('click', () => { interacted = true; animateZoomTo(sMin(), view.lon, 20, 700); });

  $('collapse').addEventListener('click', () => $('panel').classList.toggle('collapsed'));
  $('about-btn').addEventListener('click', () => { aboutEl.hidden = false; });
  $('about-close').addEventListener('click', () => { aboutEl.hidden = true; });
  aboutEl.addEventListener('click', (ev) => { if (ev.target === aboutEl) aboutEl.hidden = true; });

  // initial control state from URL
  setSea(view.sea, false);
  $('interval').value = String(view.interval);
  $('highlight').checked = view.highlight;
  $('hillshade').checked = view.hillshade;
  $('graticule').checked = view.graticule;

  // shareable URL
  let urlTimer = 0;
  function scheduleUrlUpdate() {
    clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      const p = new URLSearchParams();
      if (Math.abs(view.sea) > 0.01) p.set('sea', String(Math.round(view.sea * 10) / 10));
      p.set('lon', view.lon.toFixed(2));
      p.set('lat', view.lat.toFixed(2));
      p.set('z', view.s.toFixed(2));
      if (!view.highlight) p.set('hl', '0');
      if (!view.hillshade) p.set('hs', '0');
      if (view.graticule) p.set('gr', '1');
      if (view.interval) p.set('int', String(view.interval));
      history.replaceState(null, '', '?' + p.toString());
    }, 500);
  }

  // ------------------------------------------------------------ loading

  const loader = $('loader'), loaderText = $('loader-text'), loaderFill = $('loader-fill');
  loaderText.textContent = dict.loading;

  (async () => {
    try {
      const lowBlob = await fetchWithProgress('data/elev-1080.png', (p) => {
        loaderFill.style.width = `${Math.round(p * 100)}%`;
      });
      uploadElevation(await decodeElevation(lowBlob));
      loader.classList.add('done');
      window.__clReady = true;
      // high-res upgrade in the background
      const hiBlob = await fetchWithProgress('data/elev-4320.png', null);
      uploadElevation(await decodeElevation(hiBlob));
      window.__clHires = true;
    } catch (err) {
      console.error(err);
      dataError = true;
      if (!data) {
        loaderText.textContent = dict.loadFail + ' ' + err.message;
        loaderFill.style.width = '0%';
      }
    }
  })();

  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    location.reload();
  });

  requestAnimationFrame(frame);
}

main();
