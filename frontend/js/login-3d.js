/* SupplyIQ login + signup - 3D scene, depth effects and support widget.
   Shared by login.html and signup.html. Purely visual: it never touches the auth logic in auth.js.
   If Three.js or WebGL is unavailable the page still works (flat dark background). */
(function () {
  'use strict';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fine = window.matchMedia('(pointer: fine)').matches;
  var mx = 0, my = 0, sx = 0, sy = 0; // pointer (-1..1), smoothed

  window.addEventListener('pointermove', function (e) {
    mx = (e.clientX / window.innerWidth) * 2 - 1;
    my = -((e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });

  /* ---------------------------------------------------------- glass depth (CSS vars) */
  var card = document.querySelector('.right .card');
  if (card && fine && !reduce) {
    window.addEventListener('pointermove', function () {
      card.style.transform = 'perspective(1400px) rotateY(' + (mx * 2.6).toFixed(2) + 'deg) rotateX(' + (my * 2.2).toFixed(2) + 'deg)';
    }, { passive: true });
  }
  document.querySelectorAll('.feat, .step').forEach(function (el) {
    if (!fine || reduce) return;
    el.addEventListener('pointermove', function (e) {
      var r = el.getBoundingClientRect();
      el.style.setProperty('--ry', (((e.clientX - r.left) / r.width - 0.5) * 9).toFixed(2) + 'deg');
      el.style.setProperty('--rx', ((0.5 - (e.clientY - r.top) / r.height) * 9).toFixed(2) + 'deg');
    });
    el.addEventListener('pointerleave', function () {
      el.style.setProperty('--ry', '0deg'); el.style.setProperty('--rx', '0deg');
    });
  });

  /* ---------------------------------------------------------- support widget */
  var chat = document.getElementById('chatWidget');
  if (chat) {
    var toggle = chat.querySelector('.chat-toggle'), panel = chat.querySelector('.chat-panel');
    var setOpen = function (open) {
      chat.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open);
      panel.hidden = !open;
    };
    toggle.addEventListener('click', function () { setOpen(!chat.classList.contains('open')); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });
    chat.querySelectorAll('[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        setOpen(false);
        var a = b.dataset.act;
        var press = function (id) { var el = document.getElementById(id); if (el) el.click(); };
        if (a === 'reset') press('forgotLink');
        if (a === 'google') press('googleButton');
        if (a === 'microsoft') press('microsoftButton');
        if (a === 'register') window.location.href = 'signup.html';
        if (a === 'login') window.location.href = 'login.html';
      });
    });
  }

  /* ---------------------------------------------------------- Three.js scene */
  var cv = document.getElementById('scene3d');
  if (!cv || !window.THREE) { if (cv) cv.remove(); return; }
  var T = THREE, renderer;
  try {
    renderer = new T.WebGLRenderer({ canvas: cv, alpha: true, antialias: true, powerPreference: 'high-performance' });
  } catch (err) { cv.remove(); return; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.outputEncoding = T.sRGBEncoding;

  var scene = new T.Scene();
  var cam = new T.PerspectiveCamera(38, 1, 0.1, 100);
  cam.position.set(0, 0, 14);

  scene.add(new T.AmbientLight(0x9fd8b5, 0.6));
  var key = new T.DirectionalLight(0xfff2c0, 1.15); key.position.set(4, 6, 5); scene.add(key);
  var rim = new T.PointLight(0xc9dd45, 1.6, 34); rim.position.set(-5, 2, 4); scene.add(rim);

  var C = { dark: 0x0b3a2b, green: 0x1f6b47, mid: 0x2f9e58, lime: 0xc9dd45, cream: 0xf3efd8 };
  var mat = function (c, o) { return new T.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.45, metalness: 0.25 }, o || {})); };
  var hub = new T.Group(); scene.add(hub);
  var box = function (w, h, d, m, x, y, z, parent) {
    var b = new T.Mesh(new T.BoxGeometry(w, h, d), m); b.position.set(x, y, z); (parent || hub).add(b); return b;
  };

  // platform + lime rim
  var plat = new T.Mesh(new T.CylinderGeometry(3.3, 3.5, 0.2, 64), mat(C.dark, { metalness: 0.55, roughness: 0.3 }));
  plat.position.y = -1.1; hub.add(plat);
  var ring = new T.Mesh(new T.TorusGeometry(3.42, 0.03, 12, 110), new T.MeshBasicMaterial({ color: C.lime }));
  ring.rotation.x = Math.PI / 2; ring.position.y = -1.0; hub.add(ring);

  // warehouse
  var wh = new T.Group(); wh.position.set(-0.4, -0.45, -0.3); hub.add(wh);
  box(2.4, 0.95, 1.4, mat(C.mid), 0, 0, 0, wh);
  box(2.6, 0.12, 1.6, mat(C.cream, { roughness: 0.6 }), 0, 0.53, 0, wh);
  for (var i = 0; i < 3; i++) {
    box(0.5, 0.55, 0.05, mat(C.dark, { emissive: 0x6b7a1a, emissiveIntensity: 0.45 }), -0.75 + i * 0.75, -0.18, 0.72, wh);
  }

  // cargo boxes on the platform
  [[1.5, -0.85, 1.0, 0.5], [2.1, -0.9, 0.35, 0.4], [1.75, -0.9, -0.5, 0.45], [-2.0, -0.88, 0.9, 0.42]].forEach(function (p, k) {
    var b = box(p[3], p[3], p[3], mat(k % 2 ? C.cream : C.lime, { roughness: 0.55 }), p[0], p[1], p[2]);
    b.rotation.y = 0.4 + k;
  });

  // floating inventory cubes (animated)
  var floaters = [];
  [[-1.6, 1.2, 1.0], [2.3, 1.3, 1.2], [0.5, 2.3, -1.0], [-2.7, 0.3, -0.6], [3.0, 0.2, 0.2]].forEach(function (p, k) {
    var s = 0.28 + (k % 3) * 0.08;
    var m = box(s, s, s, mat(k % 2 ? C.lime : C.cream, { roughness: 0.4 }), p[0], p[1], p[2]);
    floaters.push({ m: m, y: p[1], ph: k * 1.3 });
  });

  // AI orb with orbit rings
  var orb = new T.Mesh(new T.SphereGeometry(0.5, 32, 24), mat(0x9be3b0, { emissive: 0x2f9e58, emissiveIntensity: 0.9, roughness: 0.2 }));
  orb.position.set(0.5, 0.75, 0.6); hub.add(orb);
  var glow = new T.PointLight(0x7ce0a0, 1.1, 6); orb.add(glow);
  var r1 = new T.Mesh(new T.TorusGeometry(0.85, 0.012, 8, 80), new T.MeshBasicMaterial({ color: C.lime, transparent: true, opacity: 0.8 }));
  var r2 = new T.Mesh(new T.TorusGeometry(1.1, 0.01, 8, 80), new T.MeshBasicMaterial({ color: 0xe6e250, transparent: true, opacity: 0.5 }));
  orb.add(r1); orb.add(r2);

  // analytics panel: glass plate + growing bars + forecast line
  var chart = new T.Group(); chart.position.set(-2.5, 1.7, -0.7); chart.rotation.y = 0.45; hub.add(chart);
  chart.add(new T.Mesh(new T.BoxGeometry(2.3, 1.45, 0.05), new T.MeshPhysicalMaterial({ color: 0x9be3b0, transparent: true, opacity: 0.16, roughness: 0.1, metalness: 0.1 })));
  var bars = [];
  [0.35, 0.55, 0.5, 0.8, 1.05].forEach(function (h, k) {
    var g = new T.BoxGeometry(0.26, h, 0.12); g.translate(0, h / 2, 0);
    var b = new T.Mesh(g, mat(k > 2 ? C.lime : C.mid, { emissive: 0x2f9e58, emissiveIntensity: 0.25 }));
    b.position.set(-0.85 + k * 0.42, -0.6, 0.1); chart.add(b); bars.push(b);
  });
  var curve = new T.CatmullRomCurve3([new T.Vector3(-1, -0.2, 0.2), new T.Vector3(-0.4, 0.05, 0.2), new T.Vector3(0.2, -0.05, 0.2), new T.Vector3(1, 0.5, 0.2)]);
  chart.add(new T.Mesh(new T.TubeGeometry(curve, 30, 0.018, 6), new T.MeshBasicMaterial({ color: C.lime })));

  // connected nodes
  var net = new T.Group(); net.position.set(2.3, 2.0, -0.8); hub.add(net);
  var pts = [], nm = new T.MeshBasicMaterial({ color: C.lime });
  for (var n = 0; n < 9; n++) {
    var v = new T.Vector3((Math.random() - 0.5) * 2.6, (Math.random() - 0.5) * 1.8, (Math.random() - 0.5) * 1.6);
    pts.push(v); var s = new T.Mesh(new T.SphereGeometry(0.07, 10, 10), nm); s.position.copy(v); net.add(s);
  }
  var lp = [];
  pts.forEach(function (a, i) { pts.forEach(function (b, j) { if (j > i && a.distanceTo(b) < 1.5) lp.push(a.x, a.y, a.z, b.x, b.y, b.z); }); });
  var lg = new T.BufferGeometry(); lg.setAttribute('position', new T.Float32BufferAttribute(lp, 3));
  net.add(new T.LineSegments(lg, new T.LineBasicMaterial({ color: 0xc9dd45, transparent: true, opacity: 0.4 })));

  // orbiting particles
  var pc = 240, pp = new Float32Array(pc * 3);
  for (var q = 0; q < pc; q++) {
    var a = Math.random() * Math.PI * 2, rr = 3.7 + Math.random() * 1.1;
    pp[q * 3] = Math.cos(a) * rr; pp[q * 3 + 1] = -0.9 + Math.random() * 2.6; pp[q * 3 + 2] = Math.sin(a) * rr;
  }
  var pg = new T.BufferGeometry(); pg.setAttribute('position', new T.BufferAttribute(pp, 3));
  var particles = new T.Points(pg, new T.PointsMaterial({ color: 0xe6e250, size: 0.045, transparent: true, opacity: 0.7, depthWrite: false }));
  hub.add(particles);

  // depth layer: slow cubes scattered across the page
  var bg = new T.Group(); scene.add(bg);
  var bgc = [];
  for (var k2 = 0; k2 < 14; k2++) {
    var sz = 0.25 + Math.random() * 0.55;
    var m2 = new T.Mesh(new T.BoxGeometry(sz, sz, sz), mat(k2 % 3 === 0 ? C.lime : C.green, { transparent: true, opacity: 0.55, roughness: 0.5 }));
    m2.position.set((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 12, -3 - Math.random() * 6);
    m2.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    bg.add(m2); bgc.push({ m: m2, s: 0.1 + Math.random() * 0.25 });
  }

  var baseY = 0;
  /* layout: keep the hub in the left panel on desktop, hide it on small screens */
  function place() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    cam.aspect = w / h; cam.updateProjectionMatrix();
    var hh = Math.tan(T.MathUtils.degToRad(cam.fov / 2)) * cam.position.z, hw = hh * cam.aspect;
    var wide = w > 900;
    hub.visible = wide;
    var s = Math.min(hh * 0.46 / 3.6, hw * 0.25 / 3.6);
    hub.scale.setScalar(s);
    hub.position.set((0.455 - 0.5) * 2 * hw, (0.5 - 0.42) * 2 * hh, 0);
    baseY = hub.position.y;
    bg.children.forEach(function (c, i) { c.visible = wide || i < 6; });
    if (reduce) renderer.render(scene, cam);
  }
  window.addEventListener('resize', place);
  place();

  var clock = new T.Clock(), raf = 0;
  function frame() {
    var t = clock.getElapsedTime();
    sx += (mx - sx) * 0.05; sy += (my - sy) * 0.05;
    var grow = reduce ? 1 : Math.min(1, t / 1.6), e = 1 - Math.pow(1 - grow, 3);
    hub.rotation.set(0.42 - sy * 0.08, -0.5 + Math.sin(t * 0.22) * 0.12 + sx * 0.28, 0);
    hub.position.y = baseY + Math.sin(t * 0.6) * 0.06;
    orb.position.y = 0.75 + Math.sin(t * 0.9) * 0.08;
    r1.rotation.set(t * 0.6, t * 0.3, 0); r2.rotation.set(1.2, t * 0.45, t * 0.2);
    net.rotation.y = t * 0.15; particles.rotation.y = -t * 0.06; ring.rotation.z = t * 0.1;
    bars.forEach(function (b, i) { b.scale.y = e * (1 + 0.05 * Math.sin(t * 1.1 + i)); });
    floaters.forEach(function (f) { f.m.position.y = f.y + Math.sin(t * 0.8 + f.ph) * 0.14; f.m.rotation.x = t * 0.3 + f.ph; f.m.rotation.y = t * 0.25; });
    bgc.forEach(function (c) { c.m.rotation.x += c.s * 0.004; c.m.rotation.y += c.s * 0.005; });
    bg.position.set(sx * 0.6, sy * 0.35, 0);
    rim.position.set(-5 + sx * 4, 2 + sy * 3, 4);
    renderer.render(scene, cam);
    raf = requestAnimationFrame(frame);
  }
  if (reduce) { renderer.render(scene, cam); }
  else {
    frame();
    document.addEventListener('visibilitychange', function () {
      cancelAnimationFrame(raf);
      if (!document.hidden) { clock.getDelta(); frame(); }
    });
  }
})();
