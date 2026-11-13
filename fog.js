/* Lil Prompt — living fog, shared by index.html and learn.html */
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* living fog: a small real-time fluid simulation (approach after Pavel Dobryakov's
     WebGL-Fluid-Simulation, MIT licence). Soft emitters near the ground keep the fog
     creeping; the mouse or a finger pushes the air, so the fog swirls and billows.
     Without WebGL + half-float textures the static smoke pictures stay in place. */
  (function () {
    var canvases = Array.prototype.slice.call(document.querySelectorAll('canvas[data-fog]'));
    if (!canvases.length) return;
    var small = Math.min(window.innerWidth, window.innerHeight) < 600;

    var CFG = {
      SIM: small ? 96 : 128,          /* velocity grid (short side) */
      DYE: small ? 384 : 640,         /* fog density grid (short side) */
      ITER: small ? 14 : 20,          /* pressure solver iterations */
      PRESSURE: 0.8,
      CURL: 10,                       /* how eagerly small eddies curl up */
      VEL_DISS: 0.35,
      DENS_DISS: 0.42,
      EMIT_EVERY: 0.05,               /* seconds between ambient puffs */
      TIME: 0.5,                      /* the whole fog lives at half speed */
      OPACITY: 0.45,                  /* calm fog: light and see-through */
      TOUCH: 1 / 3,                   /* on touch: a third thicker and faster */
      GATHER: 0.62,                   /* on touch: how fast the fog is drawn to the point */
      GATHER_R: 0.32,                 /* ...and from how far around it */
      FORCE: 1600,                    /* gentle push along the pointer's path */
      MAX_PUSH: 220                   /* cap, so a fast flick cannot tear the fog apart */
    };

    var VS = [
      'precision highp float;',
      'attribute vec2 aPosition;',
      'varying vec2 vUv, vL, vR, vT, vB;',
      'uniform vec2 texelSize;',
      'void main(){',
      ' vUv=aPosition*.5+.5;',
      ' vL=vUv-vec2(texelSize.x,0.); vR=vUv+vec2(texelSize.x,0.);',
      ' vT=vUv+vec2(0.,texelSize.y); vB=vUv-vec2(0.,texelSize.y);',
      ' gl_Position=vec4(aPosition,0.,1.);',
      '}'].join('\n');
    var P = 'precision highp float; precision highp sampler2D;\nvarying vec2 vUv, vL, vR, vT, vB;\n';
    var FS = {
      clear: P + 'uniform sampler2D uTexture; uniform float value;' +
        'void main(){gl_FragColor=value*texture2D(uTexture,vUv);}',
      splat: P + 'uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius;' +
        'void main(){vec2 p=vUv-point; p.x*=aspectRatio; vec3 s=exp(-dot(p,p)/radius)*color;' +
        'gl_FragColor=vec4(texture2D(uTarget,vUv).xyz+s,1.);}',
      advect: P + 'uniform sampler2D uVelocity; uniform sampler2D uSource; uniform vec2 texelSize; uniform vec2 dyeTexelSize; uniform float dt; uniform float dissipation;' +
        'vec4 bilerp(sampler2D sam, vec2 uv, vec2 tsize){vec2 st=uv/tsize-.5; vec2 iuv=floor(st); vec2 fuv=fract(st);' +
        'vec4 a=texture2D(sam,(iuv+vec2(.5,.5))*tsize), b=texture2D(sam,(iuv+vec2(1.5,.5))*tsize),' +
        'c=texture2D(sam,(iuv+vec2(.5,1.5))*tsize), d=texture2D(sam,(iuv+vec2(1.5,1.5))*tsize);' +
        'return mix(mix(a,b,fuv.x),mix(c,d,fuv.x),fuv.y);}' +
        'void main(){\n' +
        '#ifdef MANUAL_FILTERING\n' +
        ' vec2 coord=vUv-dt*bilerp(uVelocity,vUv,texelSize).xy*texelSize; vec4 r=bilerp(uSource,coord,dyeTexelSize);\n' +
        '#else\n' +
        ' vec2 coord=vUv-dt*texture2D(uVelocity,vUv).xy*texelSize; vec4 r=texture2D(uSource,coord);\n' +
        '#endif\n' +
        ' gl_FragColor=r/(1.+dissipation*dt);}',
      divergence: P + 'uniform sampler2D uVelocity;' +
        'void main(){float L=texture2D(uVelocity,vL).x, R=texture2D(uVelocity,vR).x, T=texture2D(uVelocity,vT).y, B=texture2D(uVelocity,vB).y;' +
        'vec2 C=texture2D(uVelocity,vUv).xy; if(vL.x<0.)L=-C.x; if(vR.x>1.)R=-C.x; if(vT.y>1.)T=-C.y; if(vB.y<0.)B=-C.y;' +
        'gl_FragColor=vec4(.5*(R-L+T-B),0.,0.,1.);}',
      curl: P + 'uniform sampler2D uVelocity;' +
        'void main(){float L=texture2D(uVelocity,vL).y, R=texture2D(uVelocity,vR).y, T=texture2D(uVelocity,vT).x, B=texture2D(uVelocity,vB).x;' +
        'gl_FragColor=vec4(.5*(R-L-T+B),0.,0.,1.);}',
      vorticity: P + 'uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;' +
        'void main(){float L=texture2D(uCurl,vL).x, R=texture2D(uCurl,vR).x, T=texture2D(uCurl,vT).x, B=texture2D(uCurl,vB).x, C=texture2D(uCurl,vUv).x;' +
        'vec2 f=.5*vec2(abs(T)-abs(B),abs(R)-abs(L)); f/=length(f)+.0001; f*=curl*C; f.y*=-1.;' +
        'vec2 v=texture2D(uVelocity,vUv).xy+f*dt; gl_FragColor=vec4(clamp(v,-1000.,1000.),0.,1.);}',
      pressure: P + 'uniform sampler2D uPressure; uniform sampler2D uDivergence;' +
        'void main(){float L=texture2D(uPressure,vL).x, R=texture2D(uPressure,vR).x, T=texture2D(uPressure,vT).x, B=texture2D(uPressure,vB).x;' +
        'gl_FragColor=vec4((L+R+B+T-texture2D(uDivergence,vUv).x)*.25,0.,0.,1.);}',
      gradient: P + 'uniform sampler2D uPressure; uniform sampler2D uVelocity;' +
        'void main(){float L=texture2D(uPressure,vL).x, R=texture2D(uPressure,vR).x, T=texture2D(uPressure,vT).x, B=texture2D(uPressure,vB).x;' +
        'vec2 v=texture2D(uVelocity,vUv).xy-vec2(R-L,T-B); gl_FragColor=vec4(v,0.,1.);}',
      /* draws the fog in towards a point (sampling from further out pulls it inwards) */
      gather: P + 'uniform sampler2D uSource; uniform vec2 point; uniform float aspectRatio; uniform float radius; uniform float amount;' +
        'void main(){vec2 d=vUv-point; vec2 e=d; e.x*=aspectRatio; float f=exp(-dot(e,e)/(radius*radius));' +
        'gl_FragColor=texture2D(uSource,vUv+d*amount*f);}',
      /* colour the density: deep magenta veils, pink body, a hot pink core.
         uShape: x = how high the fog may reach, y = fade at the bottom edge, z = thickness, w = opacity */
      display: P + 'uniform sampler2D uTexture; uniform vec4 uShape; uniform vec4 uTouch; uniform float uTouchR;' +
        'void main(){float v=max(texture2D(uTexture,vUv).r,0.);' +
        'float d=1.-exp(-v*uShape.z);' +
        'd*=1.-smoothstep(uShape.x*.45,uShape.x,vUv.y);' +
        'if(uShape.y>0.) d*=smoothstep(0.,uShape.y,vUv.y);' +
        'vec3 deep=vec3(.42,.09,.30), pink=vec3(.95,.36,.63), hot=vec3(1.,.64,.82);' +
        'vec3 col=mix(deep,pink,smoothstep(.04,.5,d)); col=mix(col,hot,smoothstep(.55,1.,d)*.45);' +
        'vec2 e=vUv-uTouch.xy; e.x*=uTouch.w; float near=exp(-dot(e,e)/(uTouchR*uTouchR));' +
        'float a=d*uShape.w*(1.+uTouch.z*near); gl_FragColor=vec4(col*a,a);}'
    };

    function makeFog(canvas) {
      var opts = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, premultipliedAlpha: true };
      var gl = canvas.getContext('webgl2', opts), gl2 = !!gl;
      if (!gl) gl = canvas.getContext('webgl', opts);
      if (!gl) throw new Error('no webgl');
      var linear, type;
      if (gl2) { gl.getExtension('EXT_color_buffer_float'); linear = gl.getExtension('OES_texture_float_linear'); type = gl.HALF_FLOAT; }
      else {
        var hf = gl.getExtension('OES_texture_half_float');
        linear = gl.getExtension('OES_texture_half_float_linear');
        type = hf && hf.HALF_FLOAT_OES;
      }
      if (!type) throw new Error('no half float');

      function renderable(internal, format) {
        var t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, format, type, null);
        var f = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(f); gl.deleteTexture(t);
        return ok;
      }
      function format(internal, fmt) {
        if (renderable(internal, fmt)) return { internal: internal, format: fmt };
        if (gl2 && internal === gl.R16F) return format(gl.RG16F, gl.RG);
        if (gl2 && internal === gl.RG16F) return format(gl.RGBA16F, gl.RGBA);
        return null;
      }
      var fRGBA = gl2 ? format(gl.RGBA16F, gl.RGBA) : format(gl.RGBA, gl.RGBA);
      var fRG = gl2 ? format(gl.RG16F, gl.RG) : fRGBA;
      var fR = gl2 ? format(gl.R16F, gl.RED) : fRGBA;
      if (!fRGBA || !fRG || !fR) throw new Error('no renderable half float');

      function compile(kind, src, defs) {
        var s = gl.createShader(kind);
        gl.shaderSource(s, (defs ? defs + '\n' : '') + src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      }
      var vs = compile(gl.VERTEX_SHADER, VS);
      function program(fs, defs) {
        var p = gl.createProgram();
        gl.attachShader(p, vs);
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs, defs));
        gl.bindAttribLocation(p, 0, 'aPosition');
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (var i = 0; i < n; i++) { var name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
        return { p: p, u: u };
      }
      var prg = {};
      Object.keys(FS).forEach(function (k) {
        prg[k] = program(FS[k], (k === 'advect' && !linear) ? '#define MANUAL_FILTERING' : '');
      });

      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(0);

      function blit(target) {
        if (target) { gl.viewport(0, 0, target.w, target.h); gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); }
        else { gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); gl.bindFramebuffer(gl.FRAMEBUFFER, null); }
        gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
      }
      function fbo(w, h, f, filter) {
        gl.activeTexture(gl.TEXTURE0);
        var t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, f.internal, w, h, 0, f.format, type, null);
        var b = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, b);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        return { tex: t, fbo: b, w: w, h: h, attach: function (id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, t); return id; } };
      }
      function dbl(w, h, f, filter) {
        var a = fbo(w, h, f, filter), b = fbo(w, h, f, filter);
        return { w: w, h: h, read: a, write: b, swap: function () { var t = this.read; this.read = this.write; this.write = t; } };
      }
      function res(n) {
        var cw = gl.drawingBufferWidth, ch = gl.drawingBufferHeight, ar = cw / ch;
        if (ar < 1) ar = 1 / ar;
        var lo = Math.round(n), hi = Math.round(n * ar);
        return cw > ch ? { w: hi, h: lo } : { w: lo, h: hi };
      }

      var top = parseFloat(canvas.getAttribute('data-top') || '0.8');
      var fade = parseFloat(canvas.getAttribute('data-fade') || '0');
      var thick = parseFloat(canvas.getAttribute('data-density') || '2');
      var spread = parseFloat(canvas.getAttribute('data-spread') || '0.35');
      var middle = parseFloat(canvas.getAttribute('data-middle') || '0.2');
      var vel, dye, div, curlT, pres, emitAcc = 0;

      function init() {
        var filter = linear ? gl.LINEAR : gl.NEAREST;
        var s = res(CFG.SIM), d = res(CFG.DYE);
        vel = dbl(s.w, s.h, fRG, filter);
        dye = dbl(d.w, d.h, fR, filter);
        div = fbo(s.w, s.h, fR, gl.NEAREST);
        curlT = fbo(s.w, s.h, fR, gl.NEAREST);
        pres = dbl(s.w, s.h, fR, gl.NEAREST);
      }

      function splat(x, y, dx, dy, amount, radius) {
        var ar = canvas.width / canvas.height;
        var r = radius * (ar > 1 ? ar : 1);
        var p = prg.splat; gl.useProgram(p.p);
        gl.uniform1i(p.u.uTarget, vel.read.attach(0));
        gl.uniform1f(p.u.aspectRatio, ar);
        gl.uniform2f(p.u.point, x, y);
        gl.uniform3f(p.u.color, dx, dy, 0);
        gl.uniform1f(p.u.radius, r);
        blit(vel.write); vel.swap();
        if (amount) {
          gl.uniform1i(p.u.uTarget, dye.read.attach(0));
          gl.uniform3f(p.u.color, amount, 0, 0);
          blit(dye.write); dye.swap();
        }
      }

      /* ambient fog: soft puffs low over the ground, mostly from the corners,
         drifting sideways towards the middle and only slightly upwards */
      function emit() {
        var x, dir;
        if (Math.random() < middle) { x = 0.2 + Math.random() * 0.6; dir = Math.random() < 0.5 ? -1 : 1; }
        else if (Math.random() < 0.5) { x = Math.random() * spread; dir = 1; }
        else { x = 1 - Math.random() * spread; dir = -1; }
        var y = fade * 0.9 + 0.02 + Math.random() * 0.14;
        /* wide, thin puffs: the fog spreads far and stays light */
        splat(x, y, dir * (18 + Math.random() * 40), 4 + Math.random() * 14,
              0.13 + Math.random() * 0.17, 0.0038 + Math.random() * 0.0052);
      }

      function gather(u, v, amount) {
        var p = prg.gather; gl.useProgram(p.p);
        gl.uniform1i(p.u.uSource, dye.read.attach(0));
        gl.uniform2f(p.u.point, u, v);
        gl.uniform1f(p.u.aspectRatio, canvas.width / canvas.height);
        gl.uniform1f(p.u.radius, CFG.GATHER_R);
        gl.uniform1f(p.u.amount, amount);
        blit(dye.write); dye.swap();
      }

      function step(dt) {
        gl.disable(gl.BLEND);
        var tx = 1 / vel.w, ty = 1 / vel.h, p;
        p = prg.curl; gl.useProgram(p.p);
        gl.uniform2f(p.u.texelSize, tx, ty);
        gl.uniform1i(p.u.uVelocity, vel.read.attach(0));
        blit(curlT);

        p = prg.vorticity; gl.useProgram(p.p);
        gl.uniform2f(p.u.texelSize, tx, ty);
        gl.uniform1i(p.u.uVelocity, vel.read.attach(0));
        gl.uniform1i(p.u.uCurl, curlT.attach(1));
        gl.uniform1f(p.u.curl, CFG.CURL);
        gl.uniform1f(p.u.dt, dt);
        blit(vel.write); vel.swap();

        p = prg.divergence; gl.useProgram(p.p);
        gl.uniform2f(p.u.texelSize, tx, ty);
        gl.uniform1i(p.u.uVelocity, vel.read.attach(0));
        blit(div);

        p = prg.clear; gl.useProgram(p.p);
        gl.uniform1i(p.u.uTexture, pres.read.attach(0));
        gl.uniform1f(p.u.value, CFG.PRESSURE);
        blit(pres.write); pres.swap();

        p = prg.pressure; gl.useProgram(p.p);
        gl.uniform2f(p.u.texelSize, tx, ty);
        gl.uniform1i(p.u.uDivergence, div.attach(0));
        for (var i = 0; i < CFG.ITER; i++) {
          gl.uniform1i(p.u.uPressure, pres.read.attach(1));
          blit(pres.write); pres.swap();
        }

        p = prg.gradient; gl.useProgram(p.p);
        gl.uniform2f(p.u.texelSize, tx, ty);
        gl.uniform1i(p.u.uPressure, pres.read.attach(0));
        gl.uniform1i(p.u.uVelocity, vel.read.attach(1));
        blit(vel.write); vel.swap();

        p = prg.advect; gl.useProgram(p.p);
        gl.uniform2f(p.u.texelSize, tx, ty);
        if (!linear) gl.uniform2f(p.u.dyeTexelSize, tx, ty);
        var v = vel.read.attach(0);
        gl.uniform1i(p.u.uVelocity, v);
        gl.uniform1i(p.u.uSource, v);
        gl.uniform1f(p.u.dt, dt);
        gl.uniform1f(p.u.dissipation, CFG.VEL_DISS);
        blit(vel.write); vel.swap();

        if (!linear) gl.uniform2f(p.u.dyeTexelSize, 1 / dye.w, 1 / dye.h);
        gl.uniform1i(p.u.uVelocity, vel.read.attach(0));
        gl.uniform1i(p.u.uSource, dye.read.attach(1));
        gl.uniform1f(p.u.dissipation, CFG.DENS_DISS);
        blit(dye.write); dye.swap();
      }

      function render(act) {
        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        var p = prg.display; gl.useProgram(p.p);
        gl.uniform1i(p.u.uTexture, dye.read.attach(0));
        gl.uniform4f(p.u.uShape, top, fade, thick, CFG.OPACITY);
        /* around the touch the fog gets a third thicker */
        gl.uniform4f(p.u.uTouch, gu, gv, (act || 0) * CFG.TOUCH, canvas.width / canvas.height);
        gl.uniform1f(p.u.uTouchR, CFG.GATHER_R * 0.9);
        blit(null);
      }

      function size() {
        var r = canvas.getBoundingClientRect();
        var q = small ? 0.6 : 0.75;     /* fog is soft; a lighter canvas is plenty */
        return { w: Math.max(2, Math.round(r.width * q)), h: Math.max(2, Math.round(r.height * q)) };
      }
      function warm(n) {
        for (var i = 0; i < n; i++) {
          emitAcc += 1 / 60;
          while (emitAcc > CFG.EMIT_EVERY) { emitAcc -= CFG.EMIT_EVERY; emit(); }
          step(1 / 60);
        }
      }

      var gu = 0.5, gv = 0.5;  /* last touch point (uv) */
      var sz = size();
      canvas.width = sz.w; canvas.height = sz.h;
      init();
      warm(small ? 150 : 210);           /* start with fog already lying there */
      render();

      var pend = null;   /* pointer motion gathered since the last frame */
      var act = 0;       /* 0 = calm, 1 = being touched; eases between the two */
      var touchUntil = -1;
      return {
        canvas: canvas, visible: false,
        tick: function (dt) {
          var now = performance.now();
          var target = now < touchUntil ? 1 : 0;
          act += (target - act) * Math.min(1, dt * (target ? 5 : 1.4));
          /* calm: half speed; touched: a third faster than that */
          var sdt = dt * CFG.TIME * (1 + act * CFG.TOUCH);
          if (pend) {
            var m = Math.sqrt(pend.dx * pend.dx + pend.dy * pend.dy);
            var k = m > CFG.MAX_PUSH ? CFG.MAX_PUSH / m : 1;
            splat(pend.u, pend.v, pend.dx * k, pend.dy * k, 0, 0.003);
            pend = null;
          }
          emitAcc += sdt;
          while (emitAcc > CFG.EMIT_EVERY) { emitAcc -= CFG.EMIT_EVERY; emit(); }
          step(sdt);
          if (act > 0.01) gather(gu, gv, CFG.GATHER * sdt * act);   /* fog flocks to the touch */
          render(act);
        },
        release: function () { if (touchUntil > performance.now()) touchUntil = performance.now() + 250; },
        resize: function () {
          var s = size();
          if (Math.abs(s.w - canvas.width) < 8 && Math.abs(s.h - canvas.height) < 8) return;
          canvas.width = s.w; canvas.height = s.h;
          init(); warm(90); render();
        },
        /* x, y, mx, my in page pixels */
        poke: function (x, y, mx, my, burst) {
          var r = canvas.getBoundingClientRect();
          if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
          var u = (x - r.left) / r.width, v = 1 - (y - r.top) / r.height;
          gu = u; gv = v;
          /* a finger stays "touching" until it lifts; the mouse while it keeps moving */
          touchUntil = performance.now() + (burst ? 600000 : 300);
          if (burst) return;
          var dx = mx / r.width * CFG.FORCE, dy = -my / r.height * CFG.FORCE;
          if (pend) { pend.u = u; pend.v = v; pend.dx += dx; pend.dy += dy; }
          else pend = { u: u, v: v, dx: dx, dy: dy };
        }
      };
    }

    var fogs = [];
    document.documentElement.classList.add('fog-on');    /* canvases must be visible to be measured */
    try {
      canvases.forEach(function (c) { fogs.push(makeFog(c)); });
    } catch (err) {
      document.documentElement.classList.remove('fog-on'); /* keep the static smoke pictures */
      if (window.console) console.warn('fog disabled:', err && err.message);
      return;
    }
    if (reduce) return;                                  /* calm, still fog only */

    var last = performance.now(), raf = 0;
    function frame(now) {
      raf = 0;
      var dt = Math.min(1 / 30, (now - last) / 1000); last = now;
      var any = false;
      fogs.forEach(function (f) { if (f.visible) { f.tick(dt); any = true; } });
      if (any && !document.hidden) raf = requestAnimationFrame(frame);
    }
    function kick() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        fogs.forEach(function (f) { if (f.canvas === en.target) f.visible = en.isIntersecting; });
      });
      kick();
    });
    fogs.forEach(function (f) { io.observe(f.canvas); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) kick(); });
    var rz;
    function resizeAll() { clearTimeout(rz); rz = setTimeout(function () { fogs.forEach(function (f) { f.resize(); }); kick(); }, 150); }
    window.addEventListener('resize', resizeAll);

    function stir(x, y, mx, my, burst) {
      fogs.forEach(function (f) { if (f.visible) f.poke(x, y, mx, my, burst); });
    }
    var lx = null, ly = null;
    document.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') return;
      var mx = lx === null ? 0 : e.clientX - lx, my = ly === null ? 0 : e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      if (mx || my) stir(e.clientX, e.clientY, mx, my, 0);
    }, { passive: true });
    var tx = null, ty = null;
    document.addEventListener('touchstart', function (e) {
      var p = e.touches[0]; tx = p.clientX; ty = p.clientY;
      stir(tx, ty, 0, 0, 1);
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      var p = e.touches[0];
      var mx = p.clientX - tx, my = p.clientY - ty;
      tx = p.clientX; ty = p.clientY;
      stir(p.clientX, p.clientY, mx, my, 0);
      fogs.forEach(function (f) { f.poke(p.clientX, p.clientY, 0, 0, 1); });   /* keep holding */
    }, { passive: true });
    function lift() { fogs.forEach(function (f) { f.release(); }); }
    document.addEventListener('touchend', lift, { passive: true });
    document.addEventListener('touchcancel', lift, { passive: true });
  })();
})();
