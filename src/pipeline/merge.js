// 多フレーム合成。
//
// 設計:
//   - 全フレームを保持せず、来たフレームから順に float の累積バッファへ足す（メモリ O(1)）
//   - 累積は必ずリニア光で行う（sRGB のまま平均すると暗部が濁る）
//   - 基準フレームから大きく外れた画素は重みを落とす（動体のゴースト対策）
//   - 出力を 2 倍格子にすると、手ぶれのサブピクセルずれが解像度として効く（ドリズル）
//
// WebGPU ではなく WebGL2 を使っている。合成自体はフラグメントシェーダ 2 本で足り、
// iOS 15 以降どこでも動くため。GPU 抽象は gpuContext() に閉じてあるので後から差し替えられる。

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const ACCUM_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uSrc;
uniform sampler2D uRef;
uniform sampler2D uAccum;
uniform ivec2 uSrcSize;
uniform ivec2 uOutSize;
uniform vec2 uShift;        // ソースを参照へ重ねるための画素単位のずれ
uniform float uWeight;      // このフレームの基本重み
uniform float uNoise;       // ロバスト性のしきい値（大きいほど寛容）
uniform int uBicubic;
uniform int uIsReference;

in vec2 vUv;
out vec4 outColor;

vec3 toLinear(vec3 c) {
  return pow(max(c, vec3(0.0)), vec3(2.2));
}

vec3 fetchClamped(sampler2D tex, ivec2 p) {
  p = clamp(p, ivec2(0), uSrcSize - 1);
  return texelFetch(tex, p, 0).rgb;
}

vec3 sampleBilinear(sampler2D tex, vec2 coord) {
  vec2 f = fract(coord - 0.5);
  ivec2 base = ivec2(floor(coord - 0.5));
  vec3 c00 = fetchClamped(tex, base);
  vec3 c10 = fetchClamped(tex, base + ivec2(1, 0));
  vec3 c01 = fetchClamped(tex, base + ivec2(0, 1));
  vec3 c11 = fetchClamped(tex, base + ivec2(1, 1));
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

vec4 catmullRom(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(
    -0.5 * t3 + t2 - 0.5 * t,
     1.5 * t3 - 2.5 * t2 + 1.0,
    -1.5 * t3 + 2.0 * t2 + 0.5 * t,
     0.5 * t3 - 0.5 * t2
  );
}

vec3 sampleBicubic(sampler2D tex, vec2 coord) {
  vec2 f = fract(coord - 0.5);
  ivec2 base = ivec2(floor(coord - 0.5));
  vec4 wx = catmullRom(f.x);
  vec4 wy = catmullRom(f.y);
  vec3 acc = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    vec3 row = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      row += fetchClamped(tex, base + ivec2(i - 1, j - 1)) * wx[i];
    }
    acc += row * wy[j];
  }
  return acc;
}

void main() {
  vec4 prev = texelFetch(uAccum, ivec2(gl_FragCoord.xy), 0);

  // gl_FragCoord は下原点、テクスチャは上原点（= 画像の並びそのまま）。
  // ImageBitmap ソースでは UNPACK_FLIP_Y_WEBGL が仕様上無視されるため、
  // flip に頼らずここで画像座標系へ変換する。入力が canvas でも video でも同じ結果になる。
  vec2 outCoord = vec2(gl_FragCoord.x, float(uOutSize.y) - gl_FragCoord.y);
  vec2 scale = vec2(uSrcSize) / vec2(uOutSize);
  vec2 srcCoord = outCoord * scale + uShift;

  if (srcCoord.x < 0.0 || srcCoord.y < 0.0
      || srcCoord.x > float(uSrcSize.x) || srcCoord.y > float(uSrcSize.y)) {
    outColor = prev;
    return;
  }

  vec3 src = uBicubic == 1 ? sampleBicubic(uSrc, srcCoord) : sampleBilinear(uSrc, srcCoord);
  src = clamp(src, 0.0, 1.0);

  float w = uWeight;
  if (uIsReference == 0) {
    vec3 ref = sampleBilinear(uRef, outCoord * scale);
    float d = distance(src, ref);
    // 基準から離れた画素（動体・位置合わせ失敗）ほど重みを落とす
    w *= exp(-(d * d) / max(uNoise * uNoise, 1e-5));
  }

  outColor = vec4(prev.rgb + toLinear(src) * w, prev.a + w);
}`;

const FINISH_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uAccum;
uniform ivec2 uOutSize;
uniform float uSharpen;      // アンシャープの強さ（0 で無効）
uniform float uSaturation;

in vec2 vUv;
out vec4 outColor;

vec3 normAt(ivec2 p) {
  p = clamp(p, ivec2(0), uOutSize - 1);
  vec4 a = texelFetch(uAccum, p, 0);
  return a.rgb / max(a.a, 1e-4);
}

vec3 toSrgb(vec3 c) {
  return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 center = normAt(p);

  if (uSharpen > 0.0) {
    // 3x3 ガウシアンとの差分を足す（ハローを抑えるため強さは控えめに）
    vec3 blur = center * 4.0;
    blur += (normAt(p + ivec2(1, 0)) + normAt(p + ivec2(-1, 0))
           + normAt(p + ivec2(0, 1)) + normAt(p + ivec2(0, -1))) * 2.0;
    blur += normAt(p + ivec2(1, 1)) + normAt(p + ivec2(1, -1))
          + normAt(p + ivec2(-1, 1)) + normAt(p + ivec2(-1, -1));
    blur /= 16.0;
    center = center + (center - blur) * uSharpen;
  }

  vec3 srgb = toSrgb(max(center, vec3(0.0)));
  if (uSaturation != 1.0) {
    float y = dot(srgb, vec3(0.2126, 0.7152, 0.0722));
    srgb = clamp(mix(vec3(y), srgb, uSaturation), 0.0, 1.0);
  }
  outColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`シェーダのコンパイルに失敗: ${log}`);
  }
  return shader;
}

function link(gl, vertSrc, fragSrc) {
  const program = gl.createProgram();
  const vert = compile(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.bindAttribLocation(program, 0, 'aPos');
  gl.linkProgram(program);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`シェーダのリンクに失敗: ${log}`);
  }
  return program;
}

// この画素数を超えたら累積バッファを half float にする
const HALF_FLOAT_THRESHOLD = 6_000_000;
// これ以上の出力は端末のメモリに乗らないとみなして拒否する
export const MAX_OUTPUT_PIXELS = 12_000_000;

/** WebGL2 と浮動小数レンダーターゲットが使えるか。 */
export function isGpuStackSupported() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    const ok = !!(gl.getExtension('EXT_color_buffer_float')
      || gl.getExtension('EXT_color_buffer_half_float'));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

export class GpuStacker {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.gl = this.canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!this.gl) throw new Error('WebGL2 が使えません');
    const gl = this.gl;
    this.float32 = !!gl.getExtension('EXT_color_buffer_float');
    if (!this.float32 && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('浮動小数のレンダーターゲットが使えません');
    }
    this.accumProgram = link(gl, VERT, ACCUM_FRAG);
    this.finishProgram = link(gl, VERT, FINISH_FRAG);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.srcTex = gl.createTexture();
    this.refTex = gl.createTexture();
    this.accum = [null, null];
    this.fbo = [null, null];
    this.current = 0;
    this.frameCount = 0;
  }

  _makeAccumTarget(index, width, height) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // 大きな出力では half float に落とす。RGBA32F は 1 画素 16 バイトで、
    // 8MP の ping-pong だけで 266MB に達してしまうため。
    const useHalf = !this.float32 || width * height > HALF_FLOAT_THRESHOLD;
    const internal = useHalf ? gl.RGBA16F : gl.RGBA32F;
    this.accumFormat = useHalf ? 'rgba16f' : 'rgba32f';
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`累積バッファを作れません (0x${status.toString(16)})`);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.accum[index] = tex;
    this.fbo[index] = fbo;
  }

  /** 合成を始める。scale に 2 を渡すと、2 倍の格子に重ねる（ドリズル）。 */
  begin(srcWidth, srcHeight, { scale = 1, bicubic = true, noise = 0.14 } = {}) {
    const gl = this.gl;
    this.srcWidth = srcWidth;
    this.srcHeight = srcHeight;
    this.outWidth = Math.round(srcWidth * scale);
    this.outHeight = Math.round(srcHeight * scale);
    this.bicubic = bicubic;
    this.noise = noise;
    this.frameCount = 0;
    this.current = 0;

    if (this.outWidth * this.outHeight > MAX_OUTPUT_PIXELS) {
      throw new Error(`出力が大きすぎます (${this.outWidth}×${this.outHeight})`);
    }

    this.canvas.width = this.outWidth;
    this.canvas.height = this.outHeight;

    for (let i = 0; i < 2; i += 1) {
      if (this.accum[i]) gl.deleteTexture(this.accum[i]);
      if (this.fbo[i]) gl.deleteFramebuffer(this.fbo[i]);
      this._makeAccumTarget(i, this.outWidth, this.outHeight);
    }
  }

  _upload(tex, source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // flip はシェーダ側で行う（ImageBitmap には効かないため）
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /**
   * フレームを 1 枚足す。
   * @param {ImageBitmap|HTMLCanvasElement|HTMLVideoElement} source
   * @param {{dx:number, dy:number, weight:number, isReference:boolean}} options
   */
  addFrame(source, { dx = 0, dy = 0, weight = 1, isReference = false } = {}) {
    const gl = this.gl;
    this._upload(this.srcTex, source);
    if (isReference || this.frameCount === 0) this._upload(this.refTex, source);

    const dst = 1 - this.current;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]);
    gl.viewport(0, 0, this.outWidth, this.outHeight);
    gl.useProgram(this.accumProgram);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.refTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.accum[this.current]);

    const p = this.accumProgram;
    gl.uniform1i(gl.getUniformLocation(p, 'uSrc'), 0);
    gl.uniform1i(gl.getUniformLocation(p, 'uRef'), 1);
    gl.uniform1i(gl.getUniformLocation(p, 'uAccum'), 2);
    gl.uniform2i(gl.getUniformLocation(p, 'uSrcSize'), this.srcWidth, this.srcHeight);
    gl.uniform2i(gl.getUniformLocation(p, 'uOutSize'), this.outWidth, this.outHeight);
    // シェーダ側で画像座標系に揃えているので、ずれはそのまま渡す
    gl.uniform2f(gl.getUniformLocation(p, 'uShift'), dx, dy);
    gl.uniform1f(gl.getUniformLocation(p, 'uWeight'), weight);
    gl.uniform1f(gl.getUniformLocation(p, 'uNoise'), this.noise);
    gl.uniform1i(gl.getUniformLocation(p, 'uBicubic'), this.bicubic ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(p, 'uIsReference'), (isReference || this.frameCount === 0) ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.current = dst;
    this.frameCount += 1;
  }

  /** 正規化・アンシャープを掛けて canvas を返す。 */
  finish({ sharpen = 0.35, saturation = 1.0 } = {}) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.outWidth, this.outHeight);
    gl.useProgram(this.finishProgram);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accum[this.current]);
    const p = this.finishProgram;
    gl.uniform1i(gl.getUniformLocation(p, 'uAccum'), 0);
    gl.uniform2i(gl.getUniformLocation(p, 'uOutSize'), this.outWidth, this.outHeight);
    gl.uniform1f(gl.getUniformLocation(p, 'uSharpen'), sharpen);
    gl.uniform1f(gl.getUniformLocation(p, 'uSaturation'), saturation);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.flush();
    return this.canvas;
  }

  dispose() {
    const gl = this.gl;
    for (let i = 0; i < 2; i += 1) {
      if (this.accum[i]) gl.deleteTexture(this.accum[i]);
      if (this.fbo[i]) gl.deleteFramebuffer(this.fbo[i]);
    }
    gl.deleteTexture(this.srcTex);
    gl.deleteTexture(this.refTex);
    gl.deleteProgram(this.accumProgram);
    gl.deleteProgram(this.finishProgram);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
