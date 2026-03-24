'use strict';
// ================================================================
//  ORBIT CALCULATOR  —  orbit.js
//  A full-featured graphing calculator inspired by Desmos
// ================================================================

// ---- Expression colors (cycling) --------------------------------
const COLORS = [
  '#4a9eff', '#ff6b6b', '#3dd6a3', '#c678dd',
  '#ffb347', '#22d4e8', '#ff94c8', '#b8d647'
];

// ---- Functions that mathjs knows (don't treat as user vars) -----
const MATH_SYMBOLS = new Set([
  'x','y','t','r','theta','pi','e','i','tau','Inf','Infinity',
  'true','false','undefined','null',
  'sin','cos','tan','sec','csc','cot',
  'asin','acos','atan','atan2','asec','acsc','acot',
  'sinh','cosh','tanh','asinh','acosh','atanh',
  'exp','log','log2','log10','ln',
  'sqrt','cbrt','nthRoot','abs',
  'ceil','floor','round','sign','fix','mod',
  'max','min','pow','sum','prod',
  'factorial','gamma','beta',
  'derivative','integral','simplify','parse',
  'Number','Complex','BigNumber','Fraction','Unit','Matrix','DenseMatrix'
]);

// ================================================================
//  Viewport  —  world ↔ canvas coordinate system
// ================================================================
class Viewport {
  constructor() {
    this.cx = 0;   // world x at canvas center
    this.cy = 0;   // world y at canvas center
    this.ppu = 60; // pixels per unit
    this.w = 800;
    this.h = 600;
  }

  get xMin() { return this.cx - this.w / (2 * this.ppu); }
  get xMax() { return this.cx + this.w / (2 * this.ppu); }
  get yMin() { return this.cy - this.h / (2 * this.ppu); }
  get yMax() { return this.cy + this.h / (2 * this.ppu); }

  toCanvas(wx, wy) {
    return [
      (wx - this.cx) * this.ppu + this.w / 2,
      -(wy - this.cy) * this.ppu + this.h / 2
    ];
  }

  toWorld(cx, cy) {
    return [
      (cx - this.w / 2) / this.ppu + this.cx,
     -((cy - this.h / 2) / this.ppu) + this.cy
    ];
  }

  zoom(factor, cx, cy) {
    const [wx, wy] = this.toWorld(cx, cy);
    this.ppu = Math.max(1, Math.min(1e6, this.ppu * factor));
    this.cx = wx - (cx - this.w / 2) / this.ppu;
    this.cy = wy + (cy - this.h / 2) / this.ppu;
  }

  pan(dx, dy) {
    this.cx -= dx / this.ppu;
    this.cy += dy / this.ppu;
  }

  setSize(w, h) {
    this.w = w;
    this.h = h;
  }

  reset() {
    this.cx = 0; this.cy = 0;
    this.ppu = Math.min(this.w, this.h) / 20;
  }
}

// ================================================================
//  Expression preprocessing
// ================================================================
function preprocess(expr) {
  let s = expr.trim();
  // Replace ^ with ^ (mathjs handles it)
  // Implicit multiplication: 2x → 2*x
  s = s.replace(/(\d)([\(a-zA-Z])/g, '$1*$2');
  // )(  →  )*(
  s = s.replace(/\)\s*(\()/g, ')*$1');
  // )a  →  )*a
  s = s.replace(/\)\s*([a-zA-Z])/g, ')*$1');
  // ln( → log(
  s = s.replace(/\bln\s*\(/g, 'log(');
  return s;
}

// ================================================================
//  Evaluator  —  wraps mathjs with slider values
// ================================================================
class Evaluator {
  constructor(sliders = {}) {
    this.sliders = sliders;
  }

  _scope(extra = {}) {
    return { pi: Math.PI, e: Math.E, tau: 2 * Math.PI, ...this.sliders, ...extra };
  }

  eval(expr, vars = {}) {
    try {
      const v = math.evaluate(preprocess(expr), this._scope(vars));
      if (typeof v === 'number') return v;
      if (v && typeof v.re === 'number') return v.re; // complex
      return NaN;
    } catch {
      return NaN;
    }
  }

  // Evaluate f(x) for each x in array
  evalBatch(expr, xs) {
    try {
      const compiled = math.compile(preprocess(expr));
      const scope = this._scope();
      return xs.map(x => {
        scope.x = x;
        try {
          const v = compiled.evaluate(scope);
          if (typeof v === 'number') return v;
          if (v && typeof v.re === 'number') return v.re;
          return NaN;
        } catch {
          return NaN;
        }
      });
    } catch {
      return xs.map(() => NaN);
    }
  }

  evalXY(expr, x, y) {
    return this.eval(expr, { x, y });
  }

  getFreeVars(expr) {
    try {
      const node = math.parse(preprocess(expr));
      const vars = new Set();
      node.traverse(n => {
        if (n.type === 'SymbolNode' && !MATH_SYMBOLS.has(n.name)) {
          vars.add(n.name);
        }
      });
      return [...vars];
    } catch {
      return [];
    }
  }

  symbolicDerivative(expr, v = 'x') {
    try {
      return math.derivative(preprocess(expr), v).toString();
    } catch {
      return null;
    }
  }

  numericalIntegral(expr, a, b, n = 500) {
    const h = (b - a) / n;
    let sum = 0;
    const compiled = math.compile(preprocess(expr));
    const scope = this._scope();
    for (let i = 0; i <= n; i++) {
      scope.x = a + i * h;
      try {
        const v = compiled.evaluate(scope);
        const y = typeof v === 'number' ? v : NaN;
        if (!isNaN(y)) {
          sum += (i === 0 || i === n) ? y : (i % 2 === 0 ? 2 * y : 4 * y);
        }
      } catch {}
    }
    return sum * h / 3;
  }
}

// ================================================================
//  Parser  —  interpret what the user typed
// ================================================================
class Parser {
  constructor(sliders = {}) {
    this.ev = new Evaluator(sliders);
  }

  parse(raw) {
    const s = raw.trim();
    if (!s) return null;

    // ----- Parametric: (f(t), g(t))  -----
    const paramMatch = s.match(/^\(\s*([^,]+)\s*,\s*([^)]+)\s*\)$/);
    if (paramMatch) {
      const xE = paramMatch[1].trim(), yE = paramMatch[2].trim();
      const freeX = this.ev.getFreeVars(xE);
      const freeY = this.ev.getFreeVars(yE);
      const allFree = [...new Set([...freeX, ...freeY])];
      const hasT = allFree.includes('t') || allFree.length === 0;
      const allSliders = allFree.every(v => v === 't' || v in this.ev.sliders);
      if (hasT || allSliders) {
        // Try as point first (no t, numeric)
        const px = this.ev.eval(xE, { t: 0 });
        const py = this.ev.eval(yE, { t: 0 });
        if (!isNaN(px) && !isNaN(py) && !allFree.includes('t')) {
          return { kind: 'point', x: px, y: py };
        }
        return { kind: 'parametric', xExpr: xE, yExpr: yE };
      }
    }

    // ----- Polar: r = f(theta) -----
    const polarM = s.match(/^r\s*=\s*(.+)$/i);
    if (polarM) return { kind: 'polar', expr: polarM[1].trim() };

    // ----- Vertical line: x = c -----
    const vertM = s.match(/^x\s*=\s*(.+)$/);
    if (vertM) {
      const v = this.ev.eval(vertM[1], { x: 0 });
      if (!isNaN(v)) return { kind: 'vertical', value: v };
    }

    // ----- y = f(x) or y [<>] f(x) -----
    const yM = s.match(/^y\s*([=<>!]{1,2})\s*(.+)$/);
    if (yM) {
      const op = yM[1], expr = yM[2].trim();
      if (op === '=') return { kind: 'function', expr };
      if (['<', '>', '<=', '>='].includes(op)) return { kind: 'inequality', op, expr };
    }

    // ----- Horizontal line: implicit y = c (just a number) -----
    const horzM = s.match(/^(-?[\d.]+(?:e[+-]?\d+)?)$/i);
    if (horzM) {
      const v = parseFloat(horzM[1]);
      if (!isNaN(v)) return { kind: 'function', expr: String(v) };
    }

    // ----- Slider: a = 3  or  a = 3 {min <= a <= max} -----
    const sliderM = s.match(/^([a-zA-Z])\s*=\s*(-?[\d.]+(?:e[+-]?\d+)?)\s*(\{.*\})?$/);
    if (sliderM && sliderM[1] !== 'x' && sliderM[1] !== 'y' &&
        sliderM[1] !== 'r' && sliderM[1] !== 't') {
      const name = sliderM[1];
      const value = parseFloat(sliderM[2]);
      let min = -10, max = 10;
      if (sliderM[3]) {
        const cm = sliderM[3].match(/(-?[\d.]+)\s*<=?\s*\w+\s*<=?\s*(-?[\d.]+)/);
        if (cm) { min = parseFloat(cm[1]); max = parseFloat(cm[2]); }
      }
      return { kind: 'slider', var: name, value, min, max };
    }

    // ----- Implicit equation: f(x,y) = g(x,y) -----
    if (s.includes('=')) {
      const idx = s.indexOf('=');
      if (s[idx - 1] !== '<' && s[idx - 1] !== '>' && s[idx + 1] !== '=') {
        const left = s.slice(0, idx).trim();
        const right = s.slice(idx + 1).trim();
        const freeL = this.ev.getFreeVars(left);
        const freeR = this.ev.getFreeVars(right);
        const allF = [...new Set([...freeL, ...freeR])];
        if (allF.includes('y') || (allF.includes('x') && allF.length === 1)) {
          return { kind: 'implicit', left, right };
        }
      }
    }

    // ----- Fallback: try as f(x) -----
    const testVal = this.ev.eval(s, { x: 0.5 });
    if (!isNaN(testVal)) return { kind: 'function', expr: s };

    return { kind: 'error', message: 'Cannot parse expression' };
  }
}

// ================================================================
//  Renderer  —  all canvas drawing
// ================================================================
class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.vp = new Viewport();
    this.dpr = window.devicePixelRatio || 1;
    this._calcOverlays = []; // { type, ... }
  }

  resize() {
    const c = this.canvas;
    const w = c.parentElement.clientWidth;
    const h = c.parentElement.clientHeight;
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    c.width = w * this.dpr;
    c.height = h * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.vp.setSize(w, h);
  }

  // -- Grid & axes -----------------------------------------------

  drawGrid() {
    const { ctx, vp } = this;
    const { w, h, xMin, xMax, yMin, yMax } = vp;

    // Background
    ctx.fillStyle = '#080808';
    ctx.fillRect(0, 0, w, h);

    const xRange = xMax - xMin;
    const yRange = yMax - yMin;
    const xStep = niceStep(xRange, 10);
    const yStep = niceStep(yRange, 10);

    // Minor gridlines
    ctx.strokeStyle = 'rgba(50, 50, 50, 0.7)';
    ctx.lineWidth = 0.5;
    this._drawGridLines(xStep, yStep);

    // Sub-divisions (5x finer) if zoomed in
    if (vp.ppu > 40) {
      ctx.strokeStyle = 'rgba(35, 35, 35, 0.6)';
      ctx.lineWidth = 0.3;
      this._drawGridLines(xStep / 5, yStep / 5);
    }

    // Axes
    const [ax] = vp.toCanvas(0, 0);
    const [, ay] = vp.toCanvas(0, 0);

    ctx.strokeStyle = 'rgba(100, 100, 100, 0.9)';
    ctx.lineWidth = 1.5;

    if (ay >= 0 && ay <= h) {
      ctx.beginPath(); ctx.moveTo(0, ay); ctx.lineTo(w, ay); ctx.stroke();
    }
    if (ax >= 0 && ax <= w) {
      ctx.beginPath(); ctx.moveTo(ax, 0); ctx.lineTo(ax, h); ctx.stroke();
    }

    // Axis arrows
    ctx.fillStyle = 'rgba(100, 100, 100, 0.9)';
    if (ay >= 0 && ay <= h) {
      // Right arrow
      ctx.beginPath(); ctx.moveTo(w - 8, ay - 4); ctx.lineTo(w, ay); ctx.lineTo(w - 8, ay + 4); ctx.fill();
    }
    if (ax >= 0 && ax <= w) {
      // Up arrow
      ctx.beginPath(); ctx.moveTo(ax - 4, 8); ctx.lineTo(ax, 0); ctx.lineTo(ax + 4, 8); ctx.fill();
    }

    // Tick labels
    this._drawTickLabels(xStep, yStep, ax, ay);
  }

  _drawGridLines(xStep, yStep) {
    const { ctx, vp } = this;
    const { w, h, xMin, xMax, yMin, yMax } = vp;

    const xStart = Math.floor(xMin / xStep) * xStep;
    for (let x = xStart; x <= xMax + xStep; x += xStep) {
      if (Math.abs(x) < xStep * 1e-6) continue;
      const [cx] = vp.toCanvas(x, 0);
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
    }

    const yStart = Math.floor(yMin / yStep) * yStep;
    for (let y = yStart; y <= yMax + yStep; y += yStep) {
      if (Math.abs(y) < yStep * 1e-6) continue;
      const [, cy] = vp.toCanvas(0, y);
      ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
    }
  }

  _drawTickLabels(xStep, yStep, axisX, axisY) {
    const { ctx, vp } = this;
    const { w, h, xMin, xMax, yMin, yMax } = vp;

    ctx.font = `${Math.max(9, Math.min(12, 11))}px ui-monospace, 'Menlo', 'Consolas', monospace`;
    ctx.fillStyle = 'rgba(90, 90, 90, 0.85)';

    // X labels
    const labelY = Math.min(Math.max(axisY + 5, 5), h - 18);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xStart = Math.floor(xMin / xStep) * xStep;
    for (let x = xStart; x <= xMax; x += xStep) {
      if (Math.abs(x) < xStep * 1e-6) continue;
      const [cx] = vp.toCanvas(x, 0);
      if (cx > 20 && cx < w - 20) ctx.fillText(fmt(x), cx, labelY);
    }

    // Y labels
    const labelX = Math.min(Math.max(axisX - 5, 30), w - 30);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yStart = Math.floor(yMin / yStep) * yStep;
    for (let y = yStart; y <= yMax; y += yStep) {
      if (Math.abs(y) < yStep * 1e-6) continue;
      const [, cy] = vp.toCanvas(0, y);
      if (cy > 15 && cy < h - 15) ctx.fillText(fmt(y), labelX, cy);
    }

    // Origin
    if (axisX > 20 && axisX < w - 20 && axisY > 15 && axisY < h - 15) {
      ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(70, 70, 70, 0.7)';
      ctx.fillText('0', axisX - 5, axisY + 5);
    }
  }

  // -- Function plotting -----------------------------------------

  plotFunction(expr, color, thickness, evaluator) {
    const { ctx, vp } = this;
    const N = Math.max(600, vp.w * 2);
    const dx = (vp.xMax - vp.xMin) / N;
    const xs = Array.from({ length: N + 1 }, (_, i) => vp.xMin + i * dx);
    const ys = evaluator.evalBatch(expr, xs);

    const maxJump = (vp.yMax - vp.yMin) * 8;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.lineJoin = 'round';
    ctx.shadowBlur = 4;
    ctx.shadowColor = color;
    ctx.beginPath();

    let pen = false;
    for (let i = 0; i <= N; i++) {
      const y = ys[i];
      if (!isFinite(y)) { pen = false; continue; }
      if (pen && Math.abs(y - ys[i - 1]) > maxJump) { pen = false; }

      const [cx, cy] = vp.toCanvas(xs[i], y);
      if (!pen) { ctx.moveTo(cx, cy); pen = true; }
      else ctx.lineTo(cx, cy);
    }

    ctx.stroke();
    ctx.restore();
  }

  // -- Inequality shading ----------------------------------------

  plotInequality(expr, op, color, evaluator) {
    const { ctx, vp } = this;
    const W = vp.w, H = vp.h;
    const step = Math.max(2, Math.floor(W / 180));

    // Build offscreen pixel map
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const oc = off.getContext('2d');
    oc.fillStyle = color;

    for (let px = 0; px < W; px += step) {
      for (let py = 0; py < H; py += step) {
        const [wx, wy] = vp.toWorld(px + step / 2, py + step / 2);
        const rhs = evaluator.eval(expr, { x: wx });
        if (!isFinite(rhs)) continue;
        let ok = false;
        if (op === '<')  ok = wy < rhs;
        if (op === '>')  ok = wy > rhs;
        if (op === '<=') ok = wy <= rhs;
        if (op === '>=') ok = wy >= rhs;
        if (ok) oc.fillRect(px, py, step, step);
      }
    }

    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.drawImage(off, 0, 0);
    ctx.restore();

    // Boundary line
    this.plotFunction(expr, color, 2, evaluator);
  }

  // -- Implicit function (marching squares) ----------------------

  plotImplicit(leftExpr, rightExpr, color, thickness, evaluator) {
    const { ctx, vp } = this;
    const RES = 120;
    const dx = (vp.xMax - vp.xMin) / RES;
    const dy = (vp.yMax - vp.yMin) / RES;

    // Sample grid
    const grid = [];
    for (let j = 0; j <= RES; j++) {
      grid[j] = [];
      for (let i = 0; i <= RES; i++) {
        const x = vp.xMin + i * dx;
        const y = vp.yMin + j * dy;
        const lv = evaluator.evalXY(leftExpr, x, y);
        const rv = evaluator.evalXY(rightExpr, x, y);
        grid[j][i] = isNaN(lv) || isNaN(rv) ? NaN : lv - rv;
      }
    }

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.shadowBlur = 4;
    ctx.shadowColor = color;
    ctx.beginPath();

    for (let j = 0; j < RES; j++) {
      for (let i = 0; i < RES; i++) {
        const v = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]];
        if (v.some(isNaN)) continue;
        const c = (v[0] > 0 ? 8 : 0) | (v[1] > 0 ? 4 : 0) | (v[2] > 0 ? 2 : 0) | (v[3] > 0 ? 1 : 0);
        if (c === 0 || c === 15) continue;

        const x0 = vp.xMin + i * dx, x1 = x0 + dx;
        const y0 = vp.yMin + j * dy, y1 = y0 + dy;

        const lerp = (va, vb) => Math.abs(va - vb) < 1e-12 ? 0.5 : va / (va - vb);
        const e = {
          top:    [x0 + lerp(v[0], v[1]) * dx, y0],
          right:  [x1, y0 + lerp(v[1], v[2]) * dy],
          bottom: [x0 + lerp(v[3], v[2]) * dx, y1],
          left:   [x0, y0 + lerp(v[0], v[3]) * dy],
        };

        const segs = this._msSegments(c, e);
        for (const [p1, p2] of segs) {
          const [cx1, cy1] = vp.toCanvas(...p1);
          const [cx2, cy2] = vp.toCanvas(...p2);
          ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2);
        }
      }
    }

    ctx.stroke();
    ctx.restore();
  }

  _msSegments(c, e) {
    const { top, right, bottom, left } = e;
    switch (c) {
      case 1: case 14: return [[left, bottom]];
      case 2: case 13: return [[bottom, right]];
      case 3: case 12: return [[left, right]];
      case 4: case 11: return [[top, right]];
      case 5:          return [[top, left], [bottom, right]];
      case 6: case  9: return [[top, bottom]];
      case 7: case  8: return [[top, left]];
      case 10:         return [[top, right], [left, bottom]];
      default:         return [];
    }
  }

  // -- Polar curve -----------------------------------------------

  plotPolar(expr, color, thickness, evaluator) {
    const { ctx, vp } = this;
    const N = 2000;
    const thetaMax = 4 * Math.PI;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.shadowBlur = 4;
    ctx.shadowColor = color;
    ctx.beginPath();

    let pen = false;
    for (let i = 0; i <= N; i++) {
      const theta = (i / N) * thetaMax;
      const r = evaluator.eval(expr, { theta, t: theta });
      if (!isFinite(r)) { pen = false; continue; }
      const wx = r * Math.cos(theta);
      const wy = r * Math.sin(theta);
      const [cx, cy] = vp.toCanvas(wx, wy);
      if (!pen) { ctx.moveTo(cx, cy); pen = true; }
      else ctx.lineTo(cx, cy);
    }

    ctx.stroke();
    ctx.restore();
  }

  // -- Parametric curve ------------------------------------------

  plotParametric(xExpr, yExpr, color, thickness, evaluator) {
    const { ctx, vp } = this;
    const N = 1000;
    const tMin = -2 * Math.PI, tMax = 2 * Math.PI;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.shadowBlur = 4;
    ctx.shadowColor = color;
    ctx.beginPath();

    let pen = false;
    let prevX = NaN, prevY = NaN;
    const maxJump = (vp.xMax - vp.xMin + vp.yMax - vp.yMin) * 4;

    for (let i = 0; i <= N; i++) {
      const t = tMin + (i / N) * (tMax - tMin);
      const wx = evaluator.eval(xExpr, { t });
      const wy = evaluator.eval(yExpr, { t });
      if (!isFinite(wx) || !isFinite(wy)) { pen = false; continue; }
      const dist = Math.hypot(wx - prevX, wy - prevY);
      if (pen && dist > maxJump) pen = false;
      const [cx, cy] = vp.toCanvas(wx, wy);
      if (!pen) { ctx.moveTo(cx, cy); pen = true; }
      else ctx.lineTo(cx, cy);
      prevX = wx; prevY = wy;
    }

    ctx.stroke();
    ctx.restore();
  }

  // -- Point -----------------------------------------------------

  plotPoint(wx, wy, color, label) {
    const { ctx, vp } = this;
    const [cx, cy] = vp.toCanvas(wx, wy);

    ctx.save();
    ctx.shadowBlur = 6;
    ctx.shadowColor = color;
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();

    if (label) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ddd';
      ctx.font = '11px Courier New';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, cx + 9, cy - 4);
    }
    ctx.restore();
  }

  // -- Vertical line ---------------------------------------------

  plotVertical(x, color, thickness) {
    const { ctx, vp } = this;
    const [cx] = vp.toCanvas(x, 0);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.shadowBlur = 4;
    ctx.shadowColor = color;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, vp.h);
    ctx.stroke();
    ctx.restore();
  }

  // -- Tangent line overlay --------------------------------------

  drawTangentAt(expr, x0, color, evaluator) {
    const { ctx, vp } = this;
    const y0 = evaluator.eval(expr, { x: x0 });
    if (!isFinite(y0)) return null;

    const h = 1e-5;
    const dy = (evaluator.eval(expr, { x: x0 + h }) - evaluator.eval(expr, { x: x0 - h })) / (2 * h);
    if (!isFinite(dy)) return null;

    // Tangent line across viewport
    const x1 = vp.xMin, y1 = y0 + dy * (x1 - x0);
    const x2 = vp.xMax, y2 = y0 + dy * (x2 - x0);
    const [cx1, cy1] = vp.toCanvas(x1, y1);
    const [cx2, cy2] = vp.toCanvas(x2, y2);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(cx1, cy1); ctx.lineTo(cx2, cy2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    this.plotPoint(x0, y0, color, `m=${dy.toFixed(4)}`);
    return dy;
  }

  // -- Integral shading ------------------------------------------

  drawIntegral(expr, a, b, color, evaluator) {
    const { ctx, vp } = this;
    const N = 400;
    const dx = (b - a) / N;

    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.28;
    ctx.beginPath();

    const [ax0, ay0] = vp.toCanvas(a, 0);
    ctx.moveTo(ax0, ay0);

    for (let i = 0; i <= N; i++) {
      const x = a + i * dx;
      const y = evaluator.eval(expr, { x });
      if (isFinite(y)) {
        const [cx, cy] = vp.toCanvas(x, y);
        ctx.lineTo(cx, cy);
      }
    }

    const [ax1, ay1] = vp.toCanvas(b, 0);
    ctx.lineTo(ax1, ay1);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Boundary lines
    const ya = evaluator.eval(expr, { x: a });
    const yb = evaluator.eval(expr, { x: b });
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([4, 3]);
    const [cxa, cya0] = vp.toCanvas(a, 0);
    const [, cyaT] = vp.toCanvas(a, ya);
    const [cxb, cyb0] = vp.toCanvas(b, 0);
    const [, cybT] = vp.toCanvas(b, yb);
    ctx.beginPath(); ctx.moveTo(cxa, cya0); ctx.lineTo(cxa, cyaT); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cxb, cyb0); ctx.lineTo(cxb, cybT); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

// ================================================================
//  ExprItem  —  data model for one expression row
// ================================================================
let _nextId = 1;
let _colorIdx = 0;

class ExprItem {
  constructor() {
    this.id = _nextId++;
    this.color = COLORS[_colorIdx++ % COLORS.length];
    this.raw = '';
    this.parsed = null;
    this.thickness = 2.5;
    this.visible = true;
    this.settingsOpen = false;
    this.isTable = false;
    this.tableRows = [{ x: '', y: '' }, { x: '', y: '' }, { x: '', y: '' }];
    // slider state
    this.sliderVal = 1;
    this.sliderMin = -10;
    this.sliderMax = 10;
  }
}

// ================================================================
//  OrbitApp  —  main application
// ================================================================
class OrbitApp {
  constructor() {
    this.canvas = document.getElementById('graph');
    this.renderer = new Renderer(this.canvas);
    this.items = [];
    this.sliders = {};  // { varName: value }
    this.dirty = true;
    this.dragging = false;
    this.lastMouse = { x: 0, y: 0 };
    this.calcMode = false;
    this._calcTangentExpr = null;
    this._calcIntExpr = null;
    this._calcOverlay = null; // { type, ... }

    this._init();
  }

  _init() {
    this.renderer.resize();
    this.renderer.vp.reset();

    // Add two starter expressions
    this._addItem();

    this._bindEvents();
    this._renderLoop();

    window.addEventListener('resize', () => {
      this.renderer.resize();
      this.dirty = true;
    });
  }

  // ---- Item management ----------------------------------------

  _addItem(isTable = false) {
    const item = new ExprItem();
    item.isTable = isTable;
    this.items.push(item);
    this._rebuildSidebar();
    this.dirty = true;

    // Focus last input
    setTimeout(() => {
      const inputs = document.querySelectorAll('.expr-input');
      if (inputs.length) inputs[inputs.length - 1].focus();
    }, 30);

    return item;
  }

  _removeItem(id) {
    const item = this.items.find(i => i.id === id);
    if (item && item.parsed && item.parsed.kind === 'slider') {
      delete this.sliders[item.parsed.var];
    }
    this.items = this.items.filter(i => i.id !== id);
    this._rebuildSidebar();
    this.dirty = true;
  }

  _updateItem(id, raw) {
    const item = this.items.find(i => i.id === id);
    if (!item) return;
    item.raw = raw;

    const parser = new Parser(this.sliders);
    item.parsed = parser.parse(raw);

    if (item.parsed && item.parsed.kind === 'slider') {
      // Register slider value (keep existing if already set)
      if (!(item.parsed.var in this.sliders)) {
        this.sliders[item.parsed.var] = item.parsed.value;
        item.sliderVal = item.parsed.value;
        item.sliderMin = item.parsed.min;
        item.sliderMax = item.parsed.max;
      }
    }

    this._refreshItemUI(id);
    this.dirty = true;
  }

  // ---- Sidebar rendering -------------------------------------

  _rebuildSidebar() {
    const list = document.getElementById('expression-list');
    list.innerHTML = '';
    for (const item of this.items) {
      list.appendChild(item.isTable ? this._buildTableEl(item) : this._buildExprEl(item));
    }
  }

  _refreshItemUI(id) {
    const item = this.items.find(i => i.id === id);
    if (!item) return;

    const el = document.querySelector(`.expr-item[data-id="${id}"]`);
    if (!el) return;

    // Error state
    const err = el.querySelector('.expr-error-msg');
    if (item.parsed && item.parsed.kind === 'error') {
      el.classList.add('has-error');
      if (err) err.textContent = item.parsed.message;
    } else {
      el.classList.remove('has-error');
    }

    // Slider row visibility
    const sliderRow = el.querySelector('.slider-row');
    if (sliderRow) {
      if (item.parsed && item.parsed.kind === 'slider') {
        sliderRow.classList.add('visible');
        const range = sliderRow.querySelector('.slider-range-input');
        if (range) {
          range.min = item.sliderMin;
          range.max = item.sliderMax;
          range.value = item.sliderVal;
          range.style.setProperty('--fill', item.color);
        }
        const vd = sliderRow.querySelector('.slider-val-display');
        if (vd) vd.textContent = Number(item.sliderVal).toFixed(3);
      } else {
        sliderRow.classList.remove('visible');
      }
    }
  }

  _buildExprEl(item) {
    const div = document.createElement('div');
    div.className = 'expr-item';
    div.dataset.id = item.id;

    div.innerHTML = `
      <div class="expr-main-row">
        <div class="expr-color-bar" style="background:${item.color}" title="Click to change settings"></div>
        <div class="expr-input-area">
          <textarea class="expr-input" placeholder="y = sin(x)  or  x²+y²=9  …" rows="1" spellcheck="false">${item.raw}</textarea>
          <div class="expr-error-msg"></div>
        </div>
        <div class="expr-side-btns">
          <button class="expr-btn settings" title="Settings">⚙</button>
          <button class="expr-btn delete" title="Delete">✕</button>
        </div>
      </div>
      <div class="slider-row">
        <div class="slider-track-row">
          <input type="range" class="slider-range-input"
            min="${item.sliderMin}" max="${item.sliderMax}"
            step="${(item.sliderMax - item.sliderMin) / 200}"
            value="${item.sliderVal}"
            style="--fill:${item.color}">
          <span class="slider-val-display">${Number(item.sliderVal).toFixed(3)}</span>
        </div>
        <div class="slider-bounds-row">
          min <input type="number" class="slider-bound-input slider-min-in" value="${item.sliderMin}" step="any">
          max <input type="number" class="slider-bound-input slider-max-in" value="${item.sliderMax}" step="any">
        </div>
      </div>
      <div class="expr-settings ${item.settingsOpen ? 'open' : ''}">
        <div class="settings-row">
          <span class="settings-label">Color</span>
          <div class="color-swatches">
            ${COLORS.map(c => `<div class="color-swatch ${c === item.color ? 'selected' : ''}" style="background:${c}" data-c="${c}"></div>`).join('')}
          </div>
        </div>
        <div class="settings-row">
          <span class="settings-label">Thickness</span>
          <input type="range" class="thickness-range" min="0.5" max="8" step="0.5" value="${item.thickness}">
          <span class="thickness-label">${item.thickness}px</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Visible</span>
          <input type="checkbox" class="visibility-check" ${item.visible ? 'checked' : ''}>
        </div>
      </div>
    `;

    // --- auto-resize textarea ---
    const ta = div.querySelector('.expr-input');
    const autoH = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    };
    autoH();

    ta.addEventListener('input', () => {
      autoH();
      this._updateItem(item.id, ta.value);
    });
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._addItem();
      }
    });

    // --- slider range ---
    const range = div.querySelector('.slider-range-input');
    const vDisp = div.querySelector('.slider-val-display');
    range.addEventListener('input', () => {
      item.sliderVal = parseFloat(range.value);
      if (item.parsed && item.parsed.kind === 'slider') {
        this.sliders[item.parsed.var] = item.sliderVal;
      }
      vDisp.textContent = item.sliderVal.toFixed(3);
      this.dirty = true;
    });

    div.querySelector('.slider-min-in').addEventListener('change', e => {
      item.sliderMin = parseFloat(e.target.value);
      range.min = item.sliderMin;
      range.step = (item.sliderMax - item.sliderMin) / 200;
    });
    div.querySelector('.slider-max-in').addEventListener('change', e => {
      item.sliderMax = parseFloat(e.target.value);
      range.max = item.sliderMax;
      range.step = (item.sliderMax - item.sliderMin) / 200;
    });

    // --- settings panel ---
    const settingsPanel = div.querySelector('.expr-settings');
    const colorBar = div.querySelector('.expr-color-bar');
    const settingsBtn = div.querySelector('.expr-btn.settings');

    const toggleSettings = () => {
      item.settingsOpen = !item.settingsOpen;
      settingsPanel.classList.toggle('open', item.settingsOpen);
      settingsBtn.classList.toggle('active', item.settingsOpen);
      div.classList.toggle('open', item.settingsOpen);
    };
    colorBar.addEventListener('click', toggleSettings);
    settingsBtn.addEventListener('click', toggleSettings);

    // --- delete ---
    div.querySelector('.expr-btn.delete').addEventListener('click', () => {
      this._removeItem(item.id);
    });

    // --- color swatches ---
    div.querySelectorAll('.color-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        item.color = sw.dataset.c;
        colorBar.style.background = item.color;
        div.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        sw.classList.add('selected');
        range.style.setProperty('--fill', item.color);
        this.dirty = true;
      });
    });

    // --- thickness ---
    const thRange = div.querySelector('.thickness-range');
    const thLabel = div.querySelector('.thickness-label');
    thRange.addEventListener('input', () => {
      item.thickness = parseFloat(thRange.value);
      thLabel.textContent = item.thickness + 'px';
      this.dirty = true;
    });

    // --- visibility ---
    div.querySelector('.visibility-check').addEventListener('change', e => {
      item.visible = e.target.checked;
      this.dirty = true;
    });

    return div;
  }

  _buildTableEl(item) {
    const div = document.createElement('div');
    div.className = 'expr-item';
    div.dataset.id = item.id;

    const renderRows = () => {
      const rowsContainer = div.querySelector('.table-rows');
      if (!rowsContainer) return;
      rowsContainer.innerHTML = '';
      item.tableRows.forEach((row, idx) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'table-data-row';
        rowEl.innerHTML = `
          <input class="table-cell" type="text" value="${row.x}" placeholder="x" data-col="x" data-idx="${idx}">
          <input class="table-cell" type="text" value="${row.y}" placeholder="y" data-col="y" data-idx="${idx}">
          <button class="table-row-del" data-idx="${idx}">✕</button>
        `;
        rowEl.querySelectorAll('.table-cell').forEach(inp => {
          inp.addEventListener('input', e => {
            item.tableRows[e.target.dataset.idx][e.target.dataset.col] = e.target.value;
            this.dirty = true;
          });
        });
        rowEl.querySelector('.table-row-del').addEventListener('click', e => {
          item.tableRows.splice(parseInt(e.target.dataset.idx), 1);
          if (item.tableRows.length === 0) item.tableRows.push({ x: '', y: '' });
          renderRows();
          this.dirty = true;
        });
        rowsContainer.appendChild(rowEl);
      });
    };

    div.innerHTML = `
      <div class="expr-main-row">
        <div class="expr-color-bar" style="background:${item.color}"></div>
        <div class="expr-input-area">
          <div class="table-expr">
            <div class="table-header-row">
              <span class="table-col-label">x</span>
              <span class="table-col-label">y</span>
              <span style="width:20px"></span>
            </div>
            <div class="table-rows"></div>
            <button class="table-add-row">+ Add Row</button>
          </div>
        </div>
        <div class="expr-side-btns">
          <button class="expr-btn delete" title="Delete Table">✕</button>
        </div>
      </div>
      <div class="expr-settings">
        <div class="settings-row">
          <span class="settings-label">Color</span>
          <div class="color-swatches">
            ${COLORS.map(c => `<div class="color-swatch ${c === item.color ? 'selected' : ''}" style="background:${c}" data-c="${c}"></div>`).join('')}
          </div>
        </div>
      </div>
    `;

    renderRows();

    div.querySelector('.table-add-row').addEventListener('click', () => {
      item.tableRows.push({ x: '', y: '' });
      renderRows();
    });
    div.querySelector('.expr-btn.delete').addEventListener('click', () => {
      this._removeItem(item.id);
    });

    const colorBar = div.querySelector('.expr-color-bar');
    const settingsPanel = div.querySelector('.expr-settings');
    colorBar.addEventListener('click', () => {
      settingsPanel.classList.toggle('open');
    });

    div.querySelectorAll('.color-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        item.color = sw.dataset.c;
        colorBar.style.background = item.color;
        div.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        sw.classList.add('selected');
        this.dirty = true;
      });
    });

    return div;
  }

  // ---- Canvas rendering ----------------------------------------

  _render() {
    const { renderer } = this;
    const ev = new Evaluator(this.sliders);

    renderer.drawGrid();

    for (const item of this.items) {
      if (!item.visible) continue;

      if (item.isTable) {
        const pts = item.tableRows
          .map(r => [parseFloat(r.x), parseFloat(r.y)])
          .filter(([x, y]) => isFinite(x) && isFinite(y));
        for (const [x, y] of pts) renderer.plotPoint(x, y, item.color, `(${x},${y})`);
        continue;
      }

      const p = item.parsed;
      if (!p || p.kind === 'error' || p.kind === null) continue;

      switch (p.kind) {
        case 'function':
          renderer.plotFunction(p.expr, item.color, item.thickness, ev);
          break;
        case 'inequality':
          renderer.plotInequality(p.expr, p.op, item.color, ev);
          break;
        case 'vertical':
          renderer.plotVertical(p.value, item.color, item.thickness);
          break;
        case 'point':
          renderer.plotPoint(p.x, p.y, item.color, `(${p.x}, ${p.y})`);
          break;
        case 'polar':
          renderer.plotPolar(p.expr, item.color, item.thickness, ev);
          break;
        case 'parametric':
          renderer.plotParametric(p.xExpr, p.yExpr, item.color, item.thickness, ev);
          break;
        case 'implicit':
          renderer.plotImplicit(p.left, p.right, item.color, item.thickness, ev);
          break;
        case 'slider':
          // Sliders don't render on canvas
          break;
      }
    }

    // Calculus overlays
    if (this._calcOverlay) {
      const o = this._calcOverlay;
      if (o.type === 'tangent' && o.expr) {
        const slope = renderer.drawTangentAt(o.expr, o.x, '#ffd700', ev);
        const resultEl = document.getElementById('calc-result');
        if (resultEl && slope !== null) {
          const y0 = ev.eval(o.expr, { x: o.x });
          resultEl.textContent = `f(${o.x}) = ${y0.toFixed(6)}   f′(${o.x}) = ${slope.toFixed(6)}`;
        }
      }
      if (o.type === 'integral' && o.expr) {
        renderer.drawIntegral(o.expr, o.a, o.b, '#ffd700', ev);
        const area = ev.numericalIntegral(o.expr, o.a, o.b);
        const resultEl = document.getElementById('calc-result');
        if (resultEl) {
          resultEl.textContent = `∫[${o.a}, ${o.b}] f(x) dx ≈ ${area.toFixed(8)}`;
        }
      }
    }
  }

  _renderLoop() {
    if (this.dirty) {
      this._render();
      this.dirty = false;
    }
    requestAnimationFrame(() => this._renderLoop());
  }

  // ---- Events -------------------------------------------------

  _bindEvents() {
    const canvas = this.canvas;
    const vp = this.renderer.vp;

    // Pan
    canvas.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      canvas.classList.add('dragging');
    });

    canvas.addEventListener('mousemove', e => {
      // Coord display
      const rect = canvas.getBoundingClientRect();
      const [wx, wy] = vp.toWorld(e.clientX - rect.left, e.clientY - rect.top);
      document.getElementById('coord-display').textContent = `(${wx.toFixed(4)}, ${wy.toFixed(4)})`;

      if (!this.dragging) return;
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      vp.pan(dx, dy);
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this.dirty = true;
    });

    const stopDrag = () => {
      this.dragging = false;
      canvas.classList.remove('dragging');
    };
    canvas.addEventListener('mouseup', stopDrag);
    canvas.addEventListener('mouseleave', () => {
      stopDrag();
      document.getElementById('coord-display').textContent = '';
    });

    // Zoom (mouse wheel)
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = e.deltaY > 0 ? 1.12 : 0.89;
      vp.zoom(factor, e.clientX - rect.left, e.clientY - rect.top);
      this.dirty = true;
    }, { passive: false });

    // Touch: pan + pinch zoom
    let lastTouchDist = 0;
    canvas.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        this.dragging = true;
        this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2) {
        this.dragging = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastTouchDist = Math.hypot(dx, dy);
      }
    }, { passive: true });

    canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 1 && this.dragging) {
        const dx = e.touches[0].clientX - this.lastMouse.x;
        const dy = e.touches[0].clientY - this.lastMouse.y;
        vp.pan(dx, dy);
        this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this.dirty = true;
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        if (lastTouchDist > 0) {
          const factor = lastTouchDist / dist;
          const rect = canvas.getBoundingClientRect();
          const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
          const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
          vp.zoom(factor, mx, my);
          this.dirty = true;
        }
        lastTouchDist = dist;
      }
    }, { passive: false });

    canvas.addEventListener('touchend', () => { this.dragging = false; lastTouchDist = 0; }, { passive: true });

    // Toolbar
    document.getElementById('btn-add-expr').addEventListener('click', () => this._addItem());
    document.getElementById('btn-add-table').addEventListener('click', () => this._addItem(true));
    document.getElementById('btn-add-bottom').addEventListener('click', () => this._addItem());

    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      vp.zoom(0.8, vp.w / 2, vp.h / 2); this.dirty = true;
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      vp.zoom(1.25, vp.w / 2, vp.h / 2); this.dirty = true;
    });
    document.getElementById('btn-reset').addEventListener('click', () => {
      vp.reset(); this.dirty = true;
    });

    // Calculus panel toggle
    document.getElementById('btn-calc-toggle').addEventListener('click', () => {
      this.calcMode = !this.calcMode;
      document.getElementById('calc-panel').classList.toggle('hidden', !this.calcMode);
      document.getElementById('btn-calc-toggle').classList.toggle('active', this.calcMode);
      if (!this.calcMode) { this._calcOverlay = null; this.dirty = true; }
    });

    // Tangent button
    document.getElementById('btn-tangent').addEventListener('click', () => {
      const x0 = parseFloat(document.getElementById('tangent-x').value);
      const funcItem = this.items.find(i => i.parsed && i.parsed.kind === 'function');
      if (!funcItem) {
        document.getElementById('calc-result').textContent = 'No function found. Add y = f(x) first.';
        return;
      }
      this._calcOverlay = { type: 'tangent', expr: funcItem.parsed.expr, x: x0 };
      this.dirty = true;
    });

    // Integral button
    document.getElementById('btn-integral').addEventListener('click', () => {
      const a = parseFloat(document.getElementById('int-a').value);
      const b = parseFloat(document.getElementById('int-b').value);
      const funcItem = this.items.find(i => i.parsed && i.parsed.kind === 'function');
      if (!funcItem) {
        document.getElementById('calc-result').textContent = 'No function found. Add y = f(x) first.';
        return;
      }
      this._calcOverlay = { type: 'integral', expr: funcItem.parsed.expr, a, b };
      this.dirty = true;
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault(); vp.zoom(0.8, vp.w / 2, vp.h / 2); this.dirty = true;
        } else if (e.key === '-') {
          e.preventDefault(); vp.zoom(1.25, vp.w / 2, vp.h / 2); this.dirty = true;
        } else if (e.key === '0') {
          e.preventDefault(); vp.reset(); this.dirty = true;
        } else if (e.shiftKey && e.key === 'A') {
          e.preventDefault(); orbitAI.toggle();
        }
      }
      if (e.key === 'Escape') orbitAI.close();
    });

    // Secret AI button (subtle ✦ in header)
    document.getElementById('ai-secret-btn').addEventListener('click', () => orbitAI.toggle());

    // Logo triple-click to open AI
    let logoClickCount = 0, logoClickTimer = null;
    document.getElementById('logo').addEventListener('click', () => {
      logoClickCount++;
      clearTimeout(logoClickTimer);
      logoClickTimer = setTimeout(() => { logoClickCount = 0; }, 600);
      if (logoClickCount >= 3) {
        logoClickCount = 0;
        orbitAI.toggle();
      }
    });
  }
}

// ================================================================
//  Utilities
// ================================================================
function niceStep(range, n = 10) {
  if (range <= 0) return 1;
  const rough = range / n;
  const p = Math.pow(10, Math.floor(Math.log10(rough)));
  const r = rough / p;
  if (r < 1.5) return p;
  if (r < 3.5) return 2 * p;
  if (r < 7.5) return 5 * p;
  return 10 * p;
}

function fmt(n) {
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 10000 || (abs < 0.01 && abs > 0)) return n.toExponential(1);
  const s = parseFloat(n.toPrecision(4)).toString();
  return s;
}

// ================================================================
//  OrbitAI  —  secret AI chat panel
//  Calls the server-side /api/chat endpoint (Vercel serverless)
//  which proxies to the Anthropic Claude API.
// ================================================================
class OrbitAI {
  constructor() {
    this.isOpen = false;
    this.messages = []; // { role: 'user'|'assistant', content: string }
    this.loading = false;

    this.panel    = document.getElementById('ai-panel');
    this.backdrop = document.getElementById('ai-backdrop');
    this.msgsEl   = document.getElementById('ai-messages');
    this.inputEl  = document.getElementById('ai-input');
    this.sendBtn  = document.getElementById('ai-send-btn');

    this._bindEvents();
  }

  _bindEvents() {
    document.getElementById('ai-close-btn').addEventListener('click', () => this.close());
    document.getElementById('ai-clear-btn').addEventListener('click', () => this.clearChat());
    this.backdrop.addEventListener('click', () => this.close());

    this.sendBtn.addEventListener('click', () => this._send());

    this.inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });

    // Auto-resize textarea
    this.inputEl.addEventListener('input', () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
    });
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  open() {
    this.isOpen = true;
    this.panel.classList.remove('hidden');
    this.backdrop.classList.remove('hidden');
    // Re-trigger animation
    this.panel.style.animation = 'none';
    requestAnimationFrame(() => {
      this.panel.style.animation = '';
    });
    setTimeout(() => this.inputEl.focus(), 100);
  }

  close() {
    this.isOpen = false;
    this.panel.classList.add('hidden');
    this.backdrop.classList.add('hidden');
  }

  clearChat() {
    this.messages = [];
    // Reset to just the welcome message
    this.msgsEl.innerHTML = `
      <div class="ai-msg assistant">
        <div class="ai-msg-bubble">
          Hey! I'm Orbit AI. Ask me anything — math, graphs, equations, or anything else.
        </div>
      </div>`;
  }

  _addMessage(role, text) {
    this.messages.push({ role, content: text });

    const div = document.createElement('div');
    div.className = `ai-msg ${role}`;
    div.innerHTML = `<div class="ai-msg-bubble">${this._escapeHtml(text)}</div>`;
    this.msgsEl.appendChild(div);
    this._scrollBottom();
    return div;
  }

  _showTyping() {
    const div = document.createElement('div');
    div.className = 'ai-msg assistant ai-typing';
    div.id = 'ai-typing-indicator';
    div.innerHTML = `
      <div class="ai-msg-bubble">
        <div class="ai-typing-dot"></div>
        <div class="ai-typing-dot"></div>
        <div class="ai-typing-dot"></div>
      </div>`;
    this.msgsEl.appendChild(div);
    this._scrollBottom();
  }

  _hideTyping() {
    const el = document.getElementById('ai-typing-indicator');
    if (el) el.remove();
  }

  async _send() {
    const text = this.inputEl.value.trim();
    if (!text || this.loading) return;

    this.inputEl.value = '';
    this.inputEl.style.height = 'auto';
    this.sendBtn.disabled = true;
    this.loading = true;

    this._addMessage('user', text);
    this._showTyping();

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: this.messages })
      });

      this._hideTyping();

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Server error ${response.status}`);
      }

      const data = await response.json();
      const reply = data.content?.[0]?.text || data.choices?.[0]?.message?.content || 'No response.';
      this._addMessage('assistant', reply);

    } catch (err) {
      this._hideTyping();
      const errDiv = document.createElement('div');
      errDiv.className = 'ai-msg assistant';
      errDiv.innerHTML = `<div class="ai-msg-bubble" style="color:#ff5757;border-color:#3a1a1a">
        ${this._escapeHtml(err.message || 'Something went wrong. Check your API key in Vercel env vars.')}
      </div>`;
      this.msgsEl.appendChild(errDiv);
      this._scrollBottom();
    } finally {
      this.loading = false;
      this.sendBtn.disabled = false;
      this.inputEl.focus();
    }
  }

  _scrollBottom() {
    requestAnimationFrame(() => {
      this.msgsEl.scrollTop = this.msgsEl.scrollHeight;
    });
  }

  _escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/\n/g, '<br>');
  }
}

// ================================================================
//  Bootstrap
// ================================================================
window.addEventListener('DOMContentLoaded', () => {
  window.orbitApp = new OrbitApp();
  window.orbitAI  = new OrbitAI();
});
