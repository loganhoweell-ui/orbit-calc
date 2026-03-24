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
  'Number','Complex','BigNumber','Fraction','Unit','Matrix','DenseMatrix',
  'if','and','or','not','xor'
]);

// ================================================================
//  HistoryManager  —  undo/redo with max 100 states
// ================================================================
class HistoryManager {
  constructor() {
    this.stack = [];
    this.pointer = -1;
    this.MAX = 100;
  }

  push(stateJson) {
    // Drop any forward states
    this.stack = this.stack.slice(0, this.pointer + 1);
    this.stack.push(stateJson);
    if (this.stack.length > this.MAX) this.stack.shift();
    this.pointer = this.stack.length - 1;
  }

  canUndo() { return this.pointer > 0; }
  canRedo() { return this.pointer < this.stack.length - 1; }

  undo() {
    if (!this.canUndo()) return null;
    this.pointer--;
    return this.stack[this.pointer];
  }

  redo() {
    if (!this.canRedo()) return null;
    this.pointer++;
    return this.stack[this.pointer];
  }
}

// ================================================================
//  Viewport  —  world ↔ canvas coordinate system
// ================================================================
class Viewport {
  constructor() {
    this.cx = 0;
    this.cy = 0;
    this.ppu = 60;
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
function preprocessPiecewise(s) {
  // Detect { cond: val, cond: val, default } syntax
  // e.g. {x > 0: x, x < 0: -x, 0}
  const braceMatch = s.match(/^\{(.+)\}$/);
  if (!braceMatch) return null;

  const inner = braceMatch[1];
  // Split by commas, but be careful about nested parens
  const parts = splitByComma(inner);
  if (parts.length < 1) return null;

  // Each part is either "cond: val" or a bare "default"
  const parsed = [];
  for (const part of parts) {
    const colonIdx = part.indexOf(':');
    if (colonIdx !== -1) {
      const cond = part.slice(0, colonIdx).trim();
      const val  = part.slice(colonIdx + 1).trim();
      parsed.push({ cond, val });
    } else {
      parsed.push({ cond: null, val: part.trim() });
    }
  }

  // Build nested if(cond, val, ...) from back to front
  let result = null;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const { cond, val } = parsed[i];
    if (cond === null) {
      result = val;
    } else {
      result = result !== null
        ? `if(${cond}, ${val}, ${result})`
        : `if(${cond}, ${val}, NaN)`;
    }
  }
  return result;
}

function splitByComma(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function preprocess(expr) {
  let s = expr.trim();

  // Piecewise: if entire rhs is a {block}, convert it
  const pwResult = preprocessPiecewise(s);
  if (pwResult !== null) return pwResult;

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
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (v && typeof v.re === 'number') return v.re;
      return NaN;
    } catch {
      return NaN;
    }
  }

  evalBool(expr, vars = {}) {
    try {
      const v = math.evaluate(preprocess(expr), this._scope(vars));
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      return false;
    } catch {
      return false;
    }
  }

  evalBatch(expr, xs, domain = null) {
    try {
      const compiled = math.compile(preprocess(expr));
      const domainCompiled = domain ? math.compile(preprocess(domain)) : null;
      const scope = this._scope();
      return xs.map(x => {
        scope.x = x;
        try {
          // Check domain restriction first
          if (domainCompiled) {
            const d = domainCompiled.evaluate({ ...scope });
            if (typeof d === 'boolean' && !d) return NaN;
            if (typeof d === 'number' && d === 0) return NaN;
          }
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

    // ----- Note/comment: starts with " // or # -----
    if (s.startsWith('"') || s.startsWith('//') || s.startsWith('#')) {
      return { kind: 'note', text: s.replace(/^["\/\/#]+\s*/, '') };
    }

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

    // ----- y = expr {domain condition} -----
    const yDomainM = s.match(/^y\s*=\s*(.+?)\s*\{([^:]+)\}$/);
    if (yDomainM) {
      return { kind: 'function', expr: yDomainM[1].trim(), domain: yDomainM[2].trim() };
    }

    // ----- y = f(x) or y [<>] f(x) -----
    const yM = s.match(/^y\s*([=<>!]{1,2})\s*(.+)$/);
    if (yM) {
      const op = yM[1], exprPart = yM[2].trim();
      if (op === '=') {
        // Check for piecewise on RHS
        const pw = preprocessPiecewise(exprPart);
        if (pw) return { kind: 'function', expr: exprPart };
        return { kind: 'function', expr: exprPart };
      }
      if (['<', '>', '<=', '>='].includes(op)) return { kind: 'inequality', op, expr: exprPart };
    }

    // ----- Horizontal line: just a number -----
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
    this._calcOverlays = [];
    // Click-to-trace marker
    this.tracePoint = null; // { wx, wy }
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

    ctx.fillStyle = '#080808';
    ctx.fillRect(0, 0, w, h);

    const xRange = xMax - xMin;
    const yRange = yMax - yMin;
    const xStep = niceStep(xRange, 10);
    const yStep = niceStep(yRange, 10);

    ctx.strokeStyle = 'rgba(50, 50, 50, 0.7)';
    ctx.lineWidth = 0.5;
    this._drawGridLines(xStep, yStep);

    if (vp.ppu > 40) {
      ctx.strokeStyle = 'rgba(35, 35, 35, 0.6)';
      ctx.lineWidth = 0.3;
      this._drawGridLines(xStep / 5, yStep / 5);
    }

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

    ctx.fillStyle = 'rgba(100, 100, 100, 0.9)';
    if (ay >= 0 && ay <= h) {
      ctx.beginPath(); ctx.moveTo(w - 8, ay - 4); ctx.lineTo(w, ay); ctx.lineTo(w - 8, ay + 4); ctx.fill();
    }
    if (ax >= 0 && ax <= w) {
      ctx.beginPath(); ctx.moveTo(ax - 4, 8); ctx.lineTo(ax, 0); ctx.lineTo(ax + 4, 8); ctx.fill();
    }

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

    const labelY = Math.min(Math.max(axisY + 5, 5), h - 18);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xStart = Math.floor(xMin / xStep) * xStep;
    for (let x = xStart; x <= xMax; x += xStep) {
      if (Math.abs(x) < xStep * 1e-6) continue;
      const [cx] = vp.toCanvas(x, 0);
      if (cx > 20 && cx < w - 20) ctx.fillText(fmt(x), cx, labelY);
    }

    const labelX = Math.min(Math.max(axisX - 5, 30), w - 30);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yStart = Math.floor(yMin / yStep) * yStep;
    for (let y = yStart; y <= yMax; y += yStep) {
      if (Math.abs(y) < yStep * 1e-6) continue;
      const [, cy] = vp.toCanvas(0, y);
      if (cy > 15 && cy < h - 15) ctx.fillText(fmt(y), labelX, cy);
    }

    if (axisX > 20 && axisX < w - 20 && axisY > 15 && axisY < h - 15) {
      ctx.textAlign = 'right'; ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(70, 70, 70, 0.7)';
      ctx.fillText('0', axisX - 5, axisY + 5);
    }
  }

  // -- Line dash helper ------------------------------------------

  _applyLineDash(ctx, lineStyle) {
    if (lineStyle === 'dashed') ctx.setLineDash([10, 5]);
    else if (lineStyle === 'dotted') ctx.setLineDash([2, 5]);
    else ctx.setLineDash([]);
  }

  // -- Function plotting -----------------------------------------

  plotFunction(expr, color, thickness, evaluator, lineStyle, domain) {
    const { ctx, vp } = this;
    const N = Math.max(600, vp.w * 2);
    const dx = (vp.xMax - vp.xMin) / N;
    const xs = Array.from({ length: N + 1 }, (_, i) => vp.xMin + i * dx);
    const ys = evaluator.evalBatch(expr, xs, domain);

    const maxJump = (vp.yMax - vp.yMin) * 8;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.lineJoin = 'round';
    ctx.shadowBlur = 4;
    ctx.shadowColor = color;
    this._applyLineDash(ctx, lineStyle);
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

    this.plotFunction(expr, color, 2, evaluator, 'solid', null);
  }

  // -- Implicit function (marching squares) ----------------------

  plotImplicit(leftExpr, rightExpr, color, thickness, evaluator, lineStyle) {
    const { ctx, vp } = this;
    const RES = 120;
    const dx = (vp.xMax - vp.xMin) / RES;
    const dy = (vp.yMax - vp.yMin) / RES;

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
    this._applyLineDash(ctx, lineStyle);
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

  plotPolar(expr, color, thickness, evaluator, lineStyle) {
    const { ctx, vp } = this;
    const N = 2000;
    const thetaMax = 4 * Math.PI;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.shadowBlur = 4;
    ctx.shadowColor = color;
    this._applyLineDash(ctx, lineStyle);
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

  plotParametric(xExpr, yExpr, color, thickness, evaluator, lineStyle) {
    const { ctx, vp } = this;
    const N = 1000;
    const tMin = -2 * Math.PI, tMax = 2 * Math.PI;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.shadowBlur = 4;
    ctx.shadowColor = color;
    this._applyLineDash(ctx, lineStyle);
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

  // -- Vertical line ---------------------------------------------

  plotVertical(x, color, thickness, lineStyle) {
    const { ctx, vp } = this;
    const [cx] = vp.toCanvas(x, 0);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = thickness;
    ctx.shadowBlur = 4;
    ctx.shadowColor = color;
    this._applyLineDash(ctx, lineStyle);
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, vp.h);
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

  // -- Trace marker (click-to-trace) ----------------------------

  drawTraceMarker() {
    if (!this.tracePoint) return;
    const { ctx, vp } = this;
    const { wx, wy } = this.tracePoint;
    const [cx, cy] = vp.toCanvas(wx, wy);
    const { w, h } = vp;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    // Crosshair vertical
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
    // Crosshair horizontal
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
    ctx.setLineDash([]);

    // Dot
    ctx.fillStyle = '#fff';
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Coordinate badge
    const label = `(${wx.toFixed(3)}, ${wy.toFixed(3)})`;
    const px = Math.min(cx + 10, w - 130);
    const py = Math.max(cy - 24, 4);
    ctx.fillStyle = 'rgba(20,20,20,0.88)';
    ctx.strokeStyle = 'rgba(80,80,80,0.7)';
    ctx.lineWidth = 1;
    const tw = ctx.measureText(label).width;
    ctx.beginPath();
    ctx.roundRect(px - 4, py - 2, tw + 14, 20, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(label, px + 2, py + 2);
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
    this.sliderVal = 1;
    this.sliderMin = -10;
    this.sliderMax = 10;
    this.lineStyle = 'solid'; // 'solid' | 'dashed' | 'dotted'
  }

  toJSON() {
    return {
      id: this.id,
      color: this.color,
      raw: this.raw,
      thickness: this.thickness,
      visible: this.visible,
      isTable: this.isTable,
      tableRows: JSON.parse(JSON.stringify(this.tableRows)),
      sliderVal: this.sliderVal,
      sliderMin: this.sliderMin,
      sliderMax: this.sliderMax,
      lineStyle: this.lineStyle
    };
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
    this.sliders = {};
    this.dirty = true;
    this.dragging = false;
    this._dragMoved = false;
    this.lastMouse = { x: 0, y: 0 };
    this.calcMode = false;
    this._calcTangentExpr = null;
    this._calcIntExpr = null;
    this._calcOverlay = null;

    // Drag-to-reorder state
    this._dragSrcId = null;

    // History
    this.history = new HistoryManager();

    // Save debounce timer
    this._saveTimer = null;

    this._init();
  }

  // ================================================================
  //  State persistence
  // ================================================================

  _getState() {
    const vp = this.renderer.vp;
    return {
      items: this.items.map(i => i.toJSON()),
      sliders: { ...this.sliders },
      viewport: { cx: vp.cx, cy: vp.cy, ppu: vp.ppu }
    };
  }

  _getStateJson() {
    return JSON.stringify(this._getState());
  }

  _applyState(state, opts = {}) {
    const { skipHistory = false } = opts;

    _nextId = 1;
    _colorIdx = 0;
    this.items = [];
    this.sliders = state.sliders || {};

    for (const d of (state.items || [])) {
      const item = new ExprItem();
      // Override auto-assigned id/color so they match saved state
      item.id = d.id;
      item.color = d.color;
      item.raw = d.raw || '';
      item.thickness = d.thickness !== undefined ? d.thickness : 2.5;
      item.visible = d.visible !== false;
      item.isTable = !!d.isTable;
      item.tableRows = d.tableRows || [{ x: '', y: '' }, { x: '', y: '' }, { x: '', y: '' }];
      item.sliderVal = d.sliderVal !== undefined ? d.sliderVal : 1;
      item.sliderMin = d.sliderMin !== undefined ? d.sliderMin : -10;
      item.sliderMax = d.sliderMax !== undefined ? d.sliderMax : 10;
      item.lineStyle = d.lineStyle || 'solid';

      // Make sure _nextId stays above all loaded ids
      if (d.id >= _nextId) _nextId = d.id + 1;

      // Parse
      if (!item.isTable && item.raw) {
        const parser = new Parser(this.sliders);
        item.parsed = parser.parse(item.raw);
        if (item.parsed && item.parsed.kind === 'slider') {
          this.sliders[item.parsed.var] = item.sliderVal;
        }
      }

      this.items.push(item);
    }

    // Restore viewport
    if (state.viewport) {
      const vp = this.renderer.vp;
      vp.cx = state.viewport.cx;
      vp.cy = state.viewport.cy;
      vp.ppu = state.viewport.ppu;
    }

    this._rebuildSidebar();
    this.dirty = true;
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        localStorage.setItem('orbit-calc-state', this._getStateJson());
      } catch {}
    }, 500);
  }

  _pushHistory() {
    this.history.push(this._getStateJson());
    this._scheduleSave();
  }

  _undo() {
    const json = this.history.undo();
    if (json) {
      this._applyState(JSON.parse(json), { skipHistory: true });
      this._scheduleSave();
    }
    this._updateHistoryBtns();
  }

  _redo() {
    const json = this.history.redo();
    if (json) {
      this._applyState(JSON.parse(json), { skipHistory: true });
      this._scheduleSave();
    }
    this._updateHistoryBtns();
  }

  _updateHistoryBtns() {
    const undoBtn = document.getElementById('btn-undo');
    const redoBtn = document.getElementById('btn-redo');
    if (undoBtn) undoBtn.disabled = !this.history.canUndo();
    if (redoBtn) redoBtn.disabled = !this.history.canRedo();
  }

  // ================================================================
  //  Share via URL
  // ================================================================

  _shareUrl() {
    const state = this._getStateJson();
    const encoded = btoa(unescape(encodeURIComponent(state)));
    const url = window.location.href.split('#')[0] + '#' + encoded;
    try {
      navigator.clipboard.writeText(url).then(() => {
        showToast('Link copied!');
      }).catch(() => {
        window.location.hash = encoded;
        showToast('Link ready — copy from address bar');
      });
    } catch {
      window.location.hash = encoded;
      showToast('Link ready — copy from address bar');
    }
  }

  _loadFromHash() {
    const hash = window.location.hash.slice(1);
    if (!hash) return false;
    try {
      const json = decodeURIComponent(escape(atob(hash)));
      const state = JSON.parse(json);
      this._applyState(state);
      return true;
    } catch {
      return false;
    }
  }

  _loadFromStorage() {
    try {
      const json = localStorage.getItem('orbit-calc-state');
      if (!json) return false;
      const state = JSON.parse(json);
      this._applyState(state);
      return true;
    } catch {
      return false;
    }
  }

  // ================================================================
  //  Init
  // ================================================================

  _init() {
    this.renderer.resize();
    this.renderer.vp.reset();

    // Load state: hash > localStorage > fresh
    let loaded = this._loadFromHash();
    if (!loaded) loaded = this._loadFromStorage();
    if (!loaded) {
      this._addItem(false, true); // silent (no history push)
    }

    // Push initial history state
    this.history.push(this._getStateJson());
    this._updateHistoryBtns();

    this._bindEvents();
    this._renderLoop();

    window.addEventListener('resize', () => {
      this.renderer.resize();
      this.dirty = true;
    });
  }

  // ================================================================
  //  Item management
  // ================================================================

  _addItem(isTable = false, silent = false) {
    const item = new ExprItem();
    item.isTable = isTable;
    this.items.push(item);
    this._rebuildSidebar();
    this.dirty = true;

    if (!silent) {
      this._pushHistory();
      this._updateHistoryBtns();
    }

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
    this._pushHistory();
    this.items = this.items.filter(i => i.id !== id);
    this._rebuildSidebar();
    this.dirty = true;
    this._updateHistoryBtns();
  }

  _updateItem(id, raw) {
    const item = this.items.find(i => i.id === id);
    if (!item) return;
    item.raw = raw;

    const parser = new Parser(this.sliders);
    item.parsed = parser.parse(raw);

    if (item.parsed && item.parsed.kind === 'slider') {
      if (!(item.parsed.var in this.sliders)) {
        this.sliders[item.parsed.var] = item.parsed.value;
        item.sliderVal = item.parsed.value;
        item.sliderMin = item.parsed.min;
        item.sliderMax = item.parsed.max;
      }
    }

    this._refreshItemUI(id);
    this.dirty = true;
    this._scheduleSave();
  }

  _clearAll() {
    if (!confirm('Clear all expressions?')) return;
    this._pushHistory();
    this.items = [];
    this.sliders = {};
    this._addItem(false, true);
    this._rebuildSidebar();
    this.dirty = true;
    this._updateHistoryBtns();
  }

  // ================================================================
  //  Sidebar rendering
  // ================================================================

  _rebuildSidebar() {
    const list = document.getElementById('expression-list');
    list.innerHTML = '';
    for (const item of this.items) {
      list.appendChild(item.isTable ? this._buildTableEl(item) : this._buildExprEl(item));
    }
    this._updateHistoryBtns();
  }

  _refreshItemUI(id) {
    const item = this.items.find(i => i.id === id);
    if (!item) return;

    const el = document.querySelector(`.expr-item[data-id="${id}"]`);
    if (!el) return;

    const err = el.querySelector('.expr-error-msg');
    if (item.parsed && item.parsed.kind === 'error') {
      el.classList.add('has-error');
      if (err) err.textContent = item.parsed.message;
    } else {
      el.classList.remove('has-error');
    }

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

    // Note: refresh note styling if needed
    if (item.parsed && item.parsed.kind === 'note') {
      const ta = el.querySelector('.expr-input');
      if (ta) ta.classList.add('is-note');
    } else {
      const ta = el.querySelector('.expr-input');
      if (ta) ta.classList.remove('is-note');
    }
  }

  // -- Color swatches HTML helper --------------------------------

  _buildColorSwatchesHtml(item) {
    const swatches = COLORS.map(c =>
      `<div class="color-swatch ${c === item.color ? 'selected' : ''}" style="background:${c}" data-c="${c}"></div>`
    ).join('');
    return `
      <div class="color-swatches">
        ${swatches}
        <input type="color" class="color-custom" value="${item.color}" title="Custom color">
      </div>
    `;
  }

  // -- Build expression element ---------------------------------

  _buildExprEl(item) {
    const div = document.createElement('div');
    div.className = 'expr-item';
    div.dataset.id = item.id;

    // Drag-to-reorder
    div.setAttribute('draggable', 'true');

    div.innerHTML = `
      <div class="expr-main-row">
        <div class="drag-handle" title="Drag to reorder">⋮⋮</div>
        <div class="expr-color-bar" style="background:${item.color}" title="Click to change settings"></div>
        <div class="expr-input-area">
          <textarea class="expr-input${item.parsed && item.parsed.kind === 'note' ? ' is-note' : ''}" placeholder="y = sin(x)  or  x²+y²=9  …" rows="1" spellcheck="false">${item.raw}</textarea>
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
          ${this._buildColorSwatchesHtml(item)}
        </div>
        <div class="settings-row">
          <span class="settings-label">Style</span>
          <div class="line-style-btns">
            <button class="line-style-btn ${item.lineStyle === 'solid' ? 'active' : ''}" data-style="solid" title="Solid">—</button>
            <button class="line-style-btn ${item.lineStyle === 'dashed' ? 'active' : ''}" data-style="dashed" title="Dashed">- -</button>
            <button class="line-style-btn ${item.lineStyle === 'dotted' ? 'active' : ''}" data-style="dotted" title="Dotted">···</button>
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

    // Auto-resize textarea
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
        this._pushHistory();
        this._addItem();
      }
    });

    ta.addEventListener('blur', () => {
      this._pushHistory();
      this._updateHistoryBtns();
    });

    // Slider range
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
    range.addEventListener('change', () => {
      this._pushHistory();
      this._updateHistoryBtns();
    });

    div.querySelector('.slider-min-in').addEventListener('change', e => {
      item.sliderMin = parseFloat(e.target.value);
      range.min = item.sliderMin;
      range.step = (item.sliderMax - item.sliderMin) / 200;
      this._pushHistory();
      this._updateHistoryBtns();
    });
    div.querySelector('.slider-max-in').addEventListener('change', e => {
      item.sliderMax = parseFloat(e.target.value);
      range.max = item.sliderMax;
      range.step = (item.sliderMax - item.sliderMin) / 200;
      this._pushHistory();
      this._updateHistoryBtns();
    });

    // Settings panel
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

    // Delete
    div.querySelector('.expr-btn.delete').addEventListener('click', () => {
      this._removeItem(item.id);
    });

    // Color swatches
    const updateColor = (newColor) => {
      item.color = newColor;
      colorBar.style.background = item.color;
      div.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
      div.querySelectorAll('.color-swatch').forEach(s => {
        if (s.dataset.c === newColor) s.classList.add('selected');
      });
      range.style.setProperty('--fill', item.color);
      const customInput = div.querySelector('.color-custom');
      if (customInput) customInput.value = item.color;
      this.dirty = true;
      this._pushHistory();
      this._updateHistoryBtns();
    };

    div.querySelectorAll('.color-swatch').forEach(sw => {
      sw.addEventListener('click', () => updateColor(sw.dataset.c));
    });

    const customColorInput = div.querySelector('.color-custom');
    if (customColorInput) {
      customColorInput.addEventListener('input', () => {
        item.color = customColorInput.value;
        colorBar.style.background = item.color;
        div.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        range.style.setProperty('--fill', item.color);
        this.dirty = true;
      });
      customColorInput.addEventListener('change', () => {
        this._pushHistory();
        this._updateHistoryBtns();
      });
    }

    // Line style buttons
    div.querySelectorAll('.line-style-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        item.lineStyle = btn.dataset.style;
        div.querySelectorAll('.line-style-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.dirty = true;
        this._pushHistory();
        this._updateHistoryBtns();
      });
    });

    // Thickness
    const thRange = div.querySelector('.thickness-range');
    const thLabel = div.querySelector('.thickness-label');
    thRange.addEventListener('input', () => {
      item.thickness = parseFloat(thRange.value);
      thLabel.textContent = item.thickness + 'px';
      this.dirty = true;
    });
    thRange.addEventListener('change', () => {
      this._pushHistory();
      this._updateHistoryBtns();
    });

    // Visibility
    div.querySelector('.visibility-check').addEventListener('change', e => {
      item.visible = e.target.checked;
      this.dirty = true;
      this._pushHistory();
      this._updateHistoryBtns();
    });

    // Drag-to-reorder events
    div.addEventListener('dragstart', e => {
      this._dragSrcId = item.id;
      div.classList.add('drag-over');
      e.dataTransfer.effectAllowed = 'move';
    });
    div.addEventListener('dragend', () => {
      this._dragSrcId = null;
      document.querySelectorAll('.expr-item').forEach(el => el.classList.remove('drag-over'));
    });
    div.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.expr-item').forEach(el => el.classList.remove('drag-over'));
      div.classList.add('drag-over');
    });
    div.addEventListener('drop', e => {
      e.preventDefault();
      if (this._dragSrcId === null || this._dragSrcId === item.id) return;
      const srcIdx = this.items.findIndex(i => i.id === this._dragSrcId);
      const dstIdx = this.items.findIndex(i => i.id === item.id);
      if (srcIdx === -1 || dstIdx === -1) return;
      const [moved] = this.items.splice(srcIdx, 1);
      this.items.splice(dstIdx, 0, moved);
      this._rebuildSidebar();
      this.dirty = true;
      this._pushHistory();
      this._updateHistoryBtns();
    });

    return div;
  }

  _buildTableEl(item) {
    const div = document.createElement('div');
    div.className = 'expr-item';
    div.dataset.id = item.id;
    div.setAttribute('draggable', 'true');

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
          inp.addEventListener('change', () => {
            this._pushHistory();
            this._updateHistoryBtns();
          });
        });
        rowEl.querySelector('.table-row-del').addEventListener('click', e => {
          item.tableRows.splice(parseInt(e.target.dataset.idx), 1);
          if (item.tableRows.length === 0) item.tableRows.push({ x: '', y: '' });
          renderRows();
          this.dirty = true;
          this._pushHistory();
          this._updateHistoryBtns();
        });
        rowsContainer.appendChild(rowEl);
      });
    };

    div.innerHTML = `
      <div class="expr-main-row">
        <div class="drag-handle" title="Drag to reorder">⋮⋮</div>
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
          ${this._buildColorSwatchesHtml(item)}
        </div>
      </div>
    `;

    renderRows();

    div.querySelector('.table-add-row').addEventListener('click', () => {
      item.tableRows.push({ x: '', y: '' });
      renderRows();
      this._pushHistory();
      this._updateHistoryBtns();
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
        this._pushHistory();
        this._updateHistoryBtns();
      });
    });

    const customColorInput = div.querySelector('.color-custom');
    if (customColorInput) {
      customColorInput.addEventListener('input', () => {
        item.color = customColorInput.value;
        colorBar.style.background = item.color;
        div.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
        this.dirty = true;
      });
      customColorInput.addEventListener('change', () => {
        this._pushHistory();
        this._updateHistoryBtns();
      });
    }

    // Drag-to-reorder for table items
    div.addEventListener('dragstart', e => {
      this._dragSrcId = item.id;
      e.dataTransfer.effectAllowed = 'move';
    });
    div.addEventListener('dragend', () => {
      this._dragSrcId = null;
      document.querySelectorAll('.expr-item').forEach(el => el.classList.remove('drag-over'));
    });
    div.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.expr-item').forEach(el => el.classList.remove('drag-over'));
      div.classList.add('drag-over');
    });
    div.addEventListener('drop', e => {
      e.preventDefault();
      if (this._dragSrcId === null || this._dragSrcId === item.id) return;
      const srcIdx = this.items.findIndex(i => i.id === this._dragSrcId);
      const dstIdx = this.items.findIndex(i => i.id === item.id);
      if (srcIdx === -1 || dstIdx === -1) return;
      const [moved] = this.items.splice(srcIdx, 1);
      this.items.splice(dstIdx, 0, moved);
      this._rebuildSidebar();
      this.dirty = true;
      this._pushHistory();
      this._updateHistoryBtns();
    });

    return div;
  }

  // ================================================================
  //  Canvas rendering
  // ================================================================

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
      if (!p || p.kind === 'error' || p.kind === 'note' || p.kind === null) continue;

      switch (p.kind) {
        case 'function':
          renderer.plotFunction(p.expr, item.color, item.thickness, ev, item.lineStyle, p.domain || null);
          break;
        case 'inequality':
          renderer.plotInequality(p.expr, p.op, item.color, ev);
          break;
        case 'vertical':
          renderer.plotVertical(p.value, item.color, item.thickness, item.lineStyle);
          break;
        case 'point':
          renderer.plotPoint(p.x, p.y, item.color, `(${p.x}, ${p.y})`);
          break;
        case 'polar':
          renderer.plotPolar(p.expr, item.color, item.thickness, ev, item.lineStyle);
          break;
        case 'parametric':
          renderer.plotParametric(p.xExpr, p.yExpr, item.color, item.thickness, ev, item.lineStyle);
          break;
        case 'implicit':
          renderer.plotImplicit(p.left, p.right, item.color, item.thickness, ev, item.lineStyle);
          break;
        case 'slider':
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

    // Trace marker
    renderer.drawTraceMarker();
  }

  _renderLoop() {
    if (this.dirty) {
      this._render();
      this.dirty = false;
    }
    requestAnimationFrame(() => this._renderLoop());
  }

  // ================================================================
  //  Events
  // ================================================================

  _bindEvents() {
    const canvas = this.canvas;
    const vp = this.renderer.vp;

    // Pan + click-to-trace
    canvas.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      this.dragging = true;
      this._dragMoved = false;
      this.lastMouse = { x: e.clientX, y: e.clientY };
      canvas.classList.add('dragging');
    });

    canvas.addEventListener('mousemove', e => {
      const rect = canvas.getBoundingClientRect();
      const [wx, wy] = vp.toWorld(e.clientX - rect.left, e.clientY - rect.top);
      document.getElementById('coord-display').textContent = `(${wx.toFixed(4)}, ${wy.toFixed(4)})`;

      if (!this.dragging) return;
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this._dragMoved = true;
      vp.pan(dx, dy);
      this.lastMouse = { x: e.clientX, y: e.clientY };
      this.dirty = true;
    });

    canvas.addEventListener('mouseup', e => {
      if (!this._dragMoved && e.button === 0) {
        // Click-to-trace
        const rect = canvas.getBoundingClientRect();
        const [wx, wy] = vp.toWorld(e.clientX - rect.left, e.clientY - rect.top);
        if (this.renderer.tracePoint &&
            Math.abs(this.renderer.tracePoint.wx - wx) < (vp.xMax - vp.xMin) * 0.02 &&
            Math.abs(this.renderer.tracePoint.wy - wy) < (vp.yMax - vp.yMin) * 0.02) {
          // Close enough to existing marker — remove it
          this.renderer.tracePoint = null;
        } else {
          this.renderer.tracePoint = { wx, wy };
        }
        this.dirty = true;
      }
      this.dragging = false;
      this._dragMoved = false;
      canvas.classList.remove('dragging');
    });

    canvas.addEventListener('mouseleave', () => {
      this.dragging = false;
      this._dragMoved = false;
      canvas.classList.remove('dragging');
      document.getElementById('coord-display').textContent = '';
    });

    // Zoom
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
        this._dragMoved = false;
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
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this._dragMoved = true;
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

    canvas.addEventListener('touchend', () => {
      this.dragging = false;
      this._dragMoved = false;
      lastTouchDist = 0;
    }, { passive: true });

    // Toolbar buttons
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

    // Share button
    document.getElementById('btn-share').addEventListener('click', () => {
      this._shareUrl();
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

    // Undo/Redo buttons
    document.getElementById('btn-undo').addEventListener('click', () => this._undo());
    document.getElementById('btn-redo').addEventListener('click', () => this._redo());

    // Clear all
    document.getElementById('btn-clear-all').addEventListener('click', () => this._clearAll());

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
      const tag = document.activeElement ? document.activeElement.tagName : '';
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      if (e.key === 'Escape') {
        orbitAI.close();
        this.renderer.tracePoint = null;
        this.dirty = true;
        closeHelpModal();
        return;
      }

      if (e.key === '?' && !inInput) {
        e.preventDefault();
        toggleHelpModal();
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault(); vp.zoom(0.8, vp.w / 2, vp.h / 2); this.dirty = true;
        } else if (e.key === '-') {
          e.preventDefault(); vp.zoom(1.25, vp.w / 2, vp.h / 2); this.dirty = true;
        } else if (e.key === '0') {
          e.preventDefault(); vp.reset(); this.dirty = true;
        } else if (e.key === 's' || e.key === 'S') {
          e.preventDefault(); this._shareUrl();
        } else if (e.shiftKey && (e.key === 'Z' || e.key === 'z')) {
          e.preventDefault(); this._redo();
        } else if (!e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
          e.preventDefault(); this._undo();
        } else if (e.shiftKey && (e.key === 'A' || e.key === 'a')) {
          e.preventDefault(); orbitAI.toggle();
        }
      }
    });

    // Secret AI button
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

    // Help modal overlay click
    document.getElementById('help-modal-overlay').addEventListener('click', e => {
      if (e.target === document.getElementById('help-modal-overlay')) closeHelpModal();
    });
    document.getElementById('help-modal-close').addEventListener('click', closeHelpModal);
  }
}

// ================================================================
//  Toast notification
// ================================================================
function showToast(msg) {
  let toast = document.getElementById('orbit-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'orbit-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.remove('toast-hide');
  toast.classList.add('toast-show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('toast-show');
    toast.classList.add('toast-hide');
  }, 2500);
}

// ================================================================
//  Help modal
// ================================================================
function toggleHelpModal() {
  const overlay = document.getElementById('help-modal-overlay');
  if (overlay.classList.contains('hidden')) {
    overlay.classList.remove('hidden');
    overlay.style.animation = 'none';
    requestAnimationFrame(() => { overlay.style.animation = ''; });
  } else {
    closeHelpModal();
  }
}

function closeHelpModal() {
  document.getElementById('help-modal-overlay').classList.add('hidden');
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
// ================================================================
class OrbitAI {
  constructor() {
    this.isOpen = false;
    this.messages = [];
    this.loading = false;

    this.panel       = document.getElementById('ai-panel');
    this.backdrop    = document.getElementById('ai-backdrop');
    this.msgsEl      = document.getElementById('ai-messages');
    this.inputEl     = document.getElementById('ai-input');
    this.sendBtn     = document.getElementById('ai-send-btn');
    this.modelSelect = document.getElementById('ai-model-select');

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
      const model = this.modelSelect?.value || 'llama-3.3-70b-versatile';

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: this.messages, model })
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
      const msg = err.message || '';
      const isKeyError = msg.toLowerCase().includes('groq_api_key') || msg.toLowerCase().includes('not set');
      const errDiv = document.createElement('div');
      errDiv.className = 'ai-msg assistant';
      errDiv.innerHTML = `<div class="ai-msg-bubble" style="color:#ff5757;border-color:#3a1a1a;background:#110808">
        ${isKeyError
          ? '⚠ GROQ_API_KEY not set.<br><br>Go to <b>Vercel → your project → Settings → Environment Variables</b> and add:<br><code style="background:#1a0a0a;padding:2px 6px;border-radius:4px;font-size:11px">GROQ_API_KEY = gsk_...</code><br><br>Get a free key at <b>console.groq.com</b>'
          : this._escapeHtml(msg || 'Something went wrong.')}
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
