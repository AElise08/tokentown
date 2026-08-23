/* TOKENTOWN — original profile isometric city.
   Low-resolution pixel scene: compact buildings, floating urban base, small
   3/4 roof planes and one central tower. The profile page mounts this file;
   the classic demo renderer remains available for the left rail.
*/
(function () {
  "use strict";

  var W = 320;
  var H = 180;
  var BASE = 150;
  var COLORS = {
    sky0: "#070817",
    sky1: "#0b0b20",
    sky2: "#11132b",
    platform: "#17162d",
    road: "#111326",
    roadHi: "#29223d",
    edge0: "#473b5d",
    edge1: "#302a49",
    edge2: "#1c1b35",
    face: "#1d2942",
    faceHi: "#263650",
    side: "#11182d",
    sideHi: "#1a263d",
    roof: "#493a50",
    roofHi: "#62495f",
    brick: "#3a2c3d",
    brickHi: "#694353",
    teal: "#2c5c63",
    tealHi: "#4b9291",
    warm: "#ffb84a",
    gold: "#ffc65c",
    orange: "#ff914d",
    cyan: "#41c7c7",
    tree: "#1b4140",
    treeHi: "#2b5b53"
  };

  function px(v) { return Math.round(v); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function fill(ctx, color, x, y, w, h) {
    ctx.fillStyle = color;
    ctx.fillRect(px(x), px(y), Math.max(1, px(w)), Math.max(1, px(h)));
  }
  function poly(ctx, color, points) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(px(points[0][0]), px(points[0][1]));
    for (var i = 1; i < points.length; i++) ctx.lineTo(px(points[i][0]), px(points[i][1]));
    ctx.closePath();
    ctx.fill();
  }
  function line(ctx, color, points, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 1;
    ctx.beginPath();
    ctx.moveTo(px(points[0][0]), px(points[0][1]));
    for (var i = 1; i < points.length; i++) ctx.lineTo(px(points[i][0]), px(points[i][1]));
    ctx.stroke();
  }
  function hashSeed(value) {
    var h = 2166136261;
    var s = String(value || "city");
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function rng(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function mount(canvas, data) {
    if (!canvas) return;
    canvas.width = W;
    canvas.height = H;
    canvas.style.imageRendering = "pixelated";
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    var seed = (Number(data && data.seed) || hashSeed(data && data.username)) >>> 0;
    var random = rng(seed);
    var buildings = clamp(Math.floor(Number(data && data.buildings) || 0), 0, 9999);
    var sponsorName = String((data && data.sponsorName) || "").replace(/[<>]/g, "").trim().slice(0, 18);
    var sponsorUrl = "";
    try {
      var sponsorParsed = new URL(String((data && data.sponsorUrl) || ""));
      if (sponsorParsed.protocol === "https:") sponsorUrl = sponsorParsed.toString();
    } catch (e) {}
    var activity = clamp((Number(data && data.tokens) || 0) / 12000000, 0.25, 1);
    var plan = cityPlan({
      seed: seed,
      buildings: buildings,
      era: data && data.era,
      types: data && data.types,
      marcos: data && data.marcos
    });

    // Render the city once to a low-resolution backing canvas. The moving
    // airship is composited over it each frame, so the buildings themselves
    // stay perfectly deterministic and crisp.
    var still = document.createElement("canvas");
    still.width = W;
    still.height = H;
    var stillCtx = still.getContext("2d");
    stillCtx.imageSmoothingEnabled = false;
    drawSky(stillCtx, random);
    drawPlatform(stillCtx, plan);
    drawStreetSurface(stillCtx, plan);
    for (var i = 0; i < plan.background.length; i++) drawBuilding(stillCtx, plan.background[i], activity);
    for (var j = 0; j < plan.middle.length; j++) drawBuilding(stillCtx, plan.middle[j], activity);
    drawLandmark(stillCtx, activity, plan.family, plan.towerX, plan.towerTop);
    for (var k = 0; k < plan.foreground.length; k++) drawBuilding(stillCtx, plan.foreground[k], activity);
    drawTrees(stillCtx, plan);
    drawStreetDetails(stillCtx, plan);
    drawPlatformFront(stillCtx, plan);

    var airshipCycle = sponsorName ? 2 * 60 * 1000 : 30 * 60 * 1000;
    var airshipFlight = 26000;
    var mountedAt = performance.now();
    var activeAirship = null;
    canvas.addEventListener("click", function (event) {
      if (!sponsorUrl || !activeAirship) return;
      var rect = canvas.getBoundingClientRect();
      var x = ((event.clientX - rect.left) * W) / rect.width;
      var y = ((event.clientY - rect.top) * H) / rect.height;
      if (x >= activeAirship.x && x <= activeAirship.x + activeAirship.w && y >= activeAirship.y && y <= activeAirship.y + activeAirship.h)
        window.open(sponsorUrl, "_blank", "noopener,noreferrer");
    });
    function frame(now) {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(still, 0, 0);
      // Use wall-clock time instead of page-load time: opening a profile does
      // not reset the schedule or force a new arrival.
      var phase = sponsorName ? (now - mountedAt) % airshipCycle : Date.now() % airshipCycle;
      if (phase < airshipFlight) {
        var x = -82 + phase * 0.019;
        drawBlimp(ctx, x, 43, sponsorName || "TOKENTOWN");
        activeAirship = { x: x, y: 42, w: 72, h: 14 };
        if (sponsorUrl) canvas.style.cursor = "pointer";
      } else { activeAirship = null; canvas.style.cursor = "default"; }
      window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);
  }

  function drawSky(ctx, random) {
    fill(ctx, COLORS.sky0, 0, 0, W, H);
    fill(ctx, COLORS.sky1, 0, 40, W, 43);
    fill(ctx, COLORS.sky2, 0, 83, W, 48);
    for (var i = 0; i < 22; i++) {
      var x = 12 + Math.floor(random() * 296);
      var y = 9 + Math.floor(random() * 80);
      fill(ctx, i % 6 === 0 ? "#aeb8ca" : "#15152d", x, y, i % 5 === 0 ? 2 : 1, 1);
    }
  }

  function drawBlimp(ctx, x, y, label) {
    var width = 72;
    var body = "#52425e";
    fill(ctx, body, x, y, width, 9);
    fill(ctx, "#6c5066", x + 5, y - 1, width - 10, 1);
    fill(ctx, "#3d314e", x + 7, y + 2, width - 14, 6);
    fill(ctx, "#6b5265", x - 1, y + 3, 1, 3);
    fill(ctx, "#6b5265", x + width, y + 3, 1, 3);
    fill(ctx, "#302840", x + 19, y + 9, 12, 2);
    ctx.font = "bold 5px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = COLORS.gold;
    ctx.fillText(label || "TOKENTOWN", px(x + width / 2), px(y + 2));
    ctx.textBaseline = "alphabetic";
  }

  var CITY_TEMPLATES = [
    {
      background: [[57,16,43,"residential"],[79,14,56,"office"],[101,16,39,"brick"],[181,14,45,"office"],[201,16,56,"residential-tower"],[224,14,39,"brick"],[244,13,47,"office"]],
      middle: [[48,20,35,"warehouse"],[72,18,52,"apartment"],[94,24,46,"brick"],[121,19,67,"residential-tower"],[176,22,53,"office"],[199,20,45,"apartment"],[220,22,60,"office"],[245,17,38,"brick"]],
      foreground: [[44,26,29,"warehouse"],[69,19,38,"shop"],[91,24,26,"brick"],[116,27,36,"shop"],[171,25,32,"shop"],[194,24,43,"apartment"],[218,22,29,"shop"],[240,27,24,"warehouse"]]
    },
    {
      background: [[42,13,48,"brick"],[63,18,37,"office"],[88,14,61,"residential"],[176,18,43,"office"],[201,14,33,"brick"],[224,19,55,"office"],[251,13,39,"residential"]],
      middle: [[34,24,40,"shop"],[62,20,55,"apartment"],[88,18,33,"brick"],[111,23,68,"residential-tower"],[174,18,37,"office"],[196,26,58,"apartment"],[225,18,45,"office"],[247,22,31,"brick"]],
      foreground: [[29,30,24,"warehouse"],[62,22,35,"shop"],[87,21,45,"brick"],[111,24,28,"shop"],[174,27,31,"shop"],[200,22,38,"apartment"],[226,20,26,"shop"],[249,30,21,"warehouse"]]
    },
    {
      background: [[52,15,60,"office"],[74,12,32,"brick"],[92,18,44,"apartment"],[184,14,31,"office"],[203,13,58,"residential-tower"],[222,21,34,"brick"],[249,16,55,"office"]],
      middle: [[40,18,30,"warehouse"],[62,25,48,"office"],[93,18,63,"residential-tower"],[115,20,35,"brick"],[175,24,54,"office"],[204,17,32,"apartment"],[226,25,67,"office"],[256,16,40,"brick"]],
      foreground: [[36,21,32,"shop"],[59,25,22,"warehouse"],[89,20,38,"shop"],[113,29,26,"brick"],[173,21,44,"shop"],[198,23,28,"apartment"],[223,25,37,"shop"],[254,25,23,"warehouse"]]
    }
  ];

  function cityPlan(data) {
    var seed = (Number(data && data.seed) || hashSeed(data && data.username)) >>> 0;
    var buildingCount = clamp(Math.floor(Number(data && data.buildings) || 0), 0, 9999);
    var era = clamp(Math.floor(Number(data && data.era) || 0), 0, 12);
    var types = data && data.types ? data.types : {};
    var marcos = data && Array.isArray(data.marcos) ? data.marcos : [];
    // Eight macro-families sit on top of the three hand-authored city plans.
    // The family controls composition; the independent streams below control
    // the actual lot geometry, so 10k users do not collapse into three images.
    var family = hashSeed(seed + ":family") % 8;
    var style = family % CITY_TEMPLATES.length;
    var template = CITY_TEMPLATES[style];
    var mirror = family === 1 || family === 4 || family === 6;
    var spread = 0.86 + (hashSeed(seed + ":spread") % 28) / 100;
    var heightBias = (hashSeed(seed + ":height") % 15) - 7;
    var all = [];
    ["background", "middle", "foreground"].forEach(function (depthName, depth) {
      template[depthName].forEach(function (spec, index) {
        all.push({
          id: depthName.slice(0, 2) + "-" + String.fromCharCode(97 + index),
          x: spec[0], w: spec[1], h: spec[2], type: spec[3], depth: depth,
          base: depth === 0 ? 137 : depth === 1 ? 145 : 153
        });
      });
    });

    // Density affects occupied lots in steps that are visible at profile size.
    var desired = buildingCount > 0
      ? clamp(10 + Math.floor(buildingCount / 4) + (family % 3), 10, all.length)
      : 12 + (family % 3);
    var ranked = all.slice().sort(function (a, b) {
      var ar = hashSeed(seed + ":slot:" + a.id);
      var br = hashSeed(seed + ":slot:" + b.id);
      return ar === br ? 0 : ar < br ? -1 : 1;
    });
    var selected = ranked.slice(0, desired);
    // Never let a sparse city lose one of its three depth layers.
    [0, 1, 2].forEach(function (depth) {
      if (!selected.some(function (b) { return b.depth === depth; })) {
        var replacement = all.find(function (b) { return b.depth === depth; });
        if (replacement) selected[selected.length - 1 - depth] = replacement;
      }
    });
    selected.sort(function (a, b) { return a.depth - b.depth || a.x - b.x; });
    var localTypes = Object.keys(types).reduce(function (out, key) {
      out[key] = Math.min(4, Math.max(0, Math.floor(Number(types[key]) || 0)));
      return out;
    }, {});
    if (marcos.indexOf("garden") >= 0 && !localTypes.parque) localTypes.parque = 1;
    if (marcos.indexOf("ferry") >= 0 && !localTypes.cais) localTypes.cais = 1;
    var specialQueue = [];
    Object.keys(localTypes).forEach(function (key) {
      for (var n = 0; n < localTypes[key]; n++) specialQueue.push(key);
    });
    var specialCandidates = selected.filter(function (b) { return b.depth > 0; });
    var specialCursor = 0;
    for (var s = 0; s < specialQueue.length && specialCursor < specialCandidates.length; s++) {
      specialCandidates[specialCursor++].special = specialQueue[s];
    }

    var groups = {
      background: [],
      middle: [],
      foreground: [],
      style: style,
      family: family,
      marcos: marcos,
      towerX: 128 + (hashSeed(seed + ":tower-x") % 65),
      towerTop: 22 + (hashSeed(seed + ":tower-height") % 23),
      roadStyle: hashSeed(seed + ":roads") % 4,
      treeStyle: hashSeed(seed + ":trees") % 4
    };
    selected.forEach(function (source, index) {
      var b = Object.assign({}, source);
      var local = rng(hashSeed(seed + ":layout:" + b.id));
      b.cityStyle = style;
      b.cityFamily = family;
      var x = mirror ? 320 - b.x - b.w : b.x;
      x = 160 + (x - 160) * spread + Math.floor(local() * 13) - 6;
      b.x = clamp(Math.round(x), 28, 263);
      b.h = Math.max(16, b.h + heightBias + Math.floor(local() * 15) - 7);
      b.h += b.depth === 1 ? family % 5 : b.depth === 2 ? (family + 2) % 4 : 0;
      b.h = Math.round(b.h * (0.86 + era * 0.035));
      b.w = Math.max(14, b.w + Math.floor(local() * 7) - 3);
      // Macro-family changes the actual district silhouette, not just color.
      // These transformations are deliberately large enough to remain visible
      // after the 320x180 backing canvas is scaled inside the profile card.
      if (family === 0) { // financial core: narrow offices, strong verticals
        if (b.depth < 2) b.type = index % 3 === 0 ? "residential-tower" : "office";
        b.w = Math.max(12, b.w - 3);
        b.h += b.depth < 2 ? 14 : 2;
      } else if (family === 1) { // residential terraces: broad apartment blocks
        b.type = b.depth === 2 && index % 3 === 0 ? "shop" : "apartment";
        b.w += 5;
        b.h -= b.depth === 2 ? 5 : 1;
      } else if (family === 2) { // old brick quarter: stepped, low foreground
        b.type = b.depth === 2 ? (index % 2 ? "shop" : "brick") : (index % 3 ? "brick" : "office");
        b.h -= b.depth === 2 ? 9 : 3;
      } else if (family === 3) { // needle city: compressed, tall central canyon
        b.w = Math.max(12, b.w - 4);
        b.h += b.depth === 1 ? 18 : b.depth === 0 ? 8 : 0;
        if (b.depth === 1) b.type = index % 2 ? "office" : "residential-tower";
      } else if (family === 4) { // industrial waterfront
        if (b.depth === 2) b.type = index % 3 ? "warehouse" : "shop";
        b.w += b.depth === 2 ? 7 : 1;
        b.h -= b.depth === 2 ? 10 : 2;
      } else if (family === 5) { // civic campus, open and asymmetric
        if (index % 5 === 0) b.type = "civic";
        b.x += b.x < 160 ? -7 : 7;
        b.h += b.depth === 0 ? 5 : -3;
      } else if (family === 6) { // twin clusters with a lower center valley
        var centerDistance = Math.abs((b.x + b.w / 2) - 160);
        b.h += centerDistance > 45 ? 12 : -10;
        if (centerDistance > 45 && b.depth < 2) b.type = "office";
      } else { // mixed metropolitan ridge, intentionally irregular
        b.h += (index % 4) * 6 - 7;
        b.w += index % 2 ? 4 : -2;
        b.type = ["office", "brick", "apartment", "residential-tower", "shop"][index % 5];
      }
      b.x = clamp(Math.round(b.x), 24, 270);
      b.w = clamp(Math.round(b.w), 12, 34);
      b.h = clamp(Math.round(b.h), 14, b.depth === 2 ? 58 : 82);
      b.roof = b.type === "shop" ? "awning" : ["flat", "parapet", "antenna", "tank", "chimney"][Math.floor(local() * 5)];
      b.variant = Math.floor(local() * 4);
      b.seed = hashSeed(seed + ":windows:" + b.id);
      applySpecial(b);
      groups[b.depth === 0 ? "background" : b.depth === 1 ? "middle" : "foreground"].push(b);
    });
    return groups;
  }

  function applySpecial(b) {
    if (!b.special) return;
    if (b.special === "torre" || b.special === "tower") {
      b.type = "residential-tower";
      b.h = Math.max(b.h, b.depth === 1 ? 61 : 44);
    } else if (b.special === "parque" || b.special === "jardim" || b.special === "garden") {
      b.type = "park";
      b.h = 8;
      b.w = Math.max(b.w, 16);
    } else if (b.special === "cais" || b.special === "dock") {
      b.type = "warehouse";
      b.h = Math.min(b.h, 23);
      b.w = Math.max(b.w, 24);
    } else if (b.special === "biblioteca" || b.special === "library") {
      b.type = "civic";
      b.h = Math.max(b.h, 35);
    } else if (b.special === "mercado" || b.special === "market") {
      b.type = "shop";
    }
  }

  function palette(b) {
    var far = b.depth === 0;
    var front = b.depth === 2;
    if (b.type === "brick") return {
      face: far ? "#1c263b" : front ? "#302b3d" : "#352e43",
      side: "#171a2c", roof: far ? "#3d3044" : "#584052", edge: "#704758"
    };
    if (b.type === "office") return {
      face: far ? "#17233b" : front ? "#1f3048" : "#253650",
      side: "#121a2f", roof: "#39485c", edge: COLORS.tealHi
    };
    if (b.type === "warehouse") return {
      face: far ? "#141c31" : "#1b263c", side: "#10162a",
      roof: "#29354b", edge: "#3f4d60"
    };
    if (b.type === "shop") return {
      face: front ? "#2a2c3d" : "#26324a", side: "#151b2e",
      roof: "#425067", edge: "#674051"
    };
    if (b.type === "residential-tower") return {
      face: "#20304a", side: "#111a30", roof: "#3a4b60", edge: "#4f6374"
    };
    if (b.type === "civic") return {
      face: "#26364b", side: "#172238", roof: "#43556a", edge: "#d08a58"
    };
    return {
      face: far ? "#17233b" : front ? "#1d2b45" : "#23334c",
      side: "#121a2e", roof: "#36485c", edge: "#45586a"
    };
  }

  function drawBuilding(ctx, b, activity) {
    if (b.type === "park") {
      drawPark(ctx, b);
      return;
    }
    var p = palette(b);
    if (b.cityStyle === 1) {
      p.roof = b.depth === 0 ? "#33485b" : "#3d5869";
      p.edge = COLORS.tealHi;
    } else if (b.cityStyle === 2) {
      p.roof = b.depth === 0 ? "#44354c" : "#604253";
      p.edge = "#805061";
    }
    var top = b.base - b.h;
    var side = b.depth === 0 ? 2 : 3;
    // A compact front elevation with a crisp right plane: the original
    // TokenTown profile city had this readable miniature diorama shape.
    poly(ctx, p.side, [
      [b.x + b.w, b.base], [b.x + b.w + side + 2, b.base - 2],
      [b.x + b.w + side + 2, top + 3], [b.x + b.w, top + 1]
    ]);
    fill(ctx, p.face, b.x, top + 2, b.w, Math.max(2, b.base - top - 2));
    fill(ctx, p.edge, b.x + 1, top + 2, 1, Math.max(2, b.base - top - 6));
    // Small roof plane, offset in 3/4 perspective rather than a large eave.
    poly(ctx, p.roof, [
      [b.x - 3, top + 2], [b.x + b.w, top - 1],
      [b.x + b.w + side + 4, top + 2], [b.x + 3, top + 5]
    ]);
    line(ctx, p.edge, [[b.x - 3, top + 2], [b.x + b.w, top - 1], [b.x + b.w + side + 4, top + 2]], 1);
    drawFacade(ctx, b, p, activity, top);
    drawRoofEquipment(ctx, b, p, top);
  }

  function drawPark(ctx, b) {
    var y = b.base;
    fill(ctx, "#1d403d", b.x, y - 5, b.w, 5);
    fill(ctx, "#2a554c", b.x + 2, y - 6, Math.max(2, b.w - 5), 1);
    fill(ctx, "#172c31", b.x + Math.floor(b.w * 0.55), y - 10, 2, 5);
    fill(ctx, COLORS.tree, b.x + Math.floor(b.w * 0.55) - 3, y - 14, 7, 4);
    fill(ctx, COLORS.treeHi, b.x + Math.floor(b.w * 0.55) - 2, y - 15, 4, 2);
    fill(ctx, "#39475b", b.x + 3, y - 3, Math.max(4, b.w - 8), 1);
  }

  function drawFacade(ctx, b, p, activity, top) {
    var local = rng(b.seed);
    var rows = Math.max(1, Math.floor((b.h - 9) / 6));
    var cols = Math.max(2, Math.floor((b.w - 5) / 4));
    var litRate = clamp((b.depth === 0 ? 0.25 : b.depth === 1 ? 0.4 : 0.5) + activity * 0.1, 0.28, 0.6);
    var winW = b.w >= 20 ? 2 : 1;
    var winH = b.depth === 0 ? 1 : 2;
    if (b.type === "office") {
      fill(ctx, COLORS.teal, b.x + Math.floor(b.w / 2), top + 5, 1, Math.max(2, b.h - 10));
      fill(ctx, "#1d3650", b.x + 3, top + 5, 1, Math.max(2, b.h - 10));
    }
    if (b.type === "civic") {
      fill(ctx, "#d08a58", b.x + 2, top + 5, Math.max(3, b.w - 4), 1);
      fill(ctx, "#31536a", b.x + 4, b.base - 12, Math.max(3, b.w - 8), 2);
    }
    if (b.type === "brick") {
      for (var seam = top + 8; seam < b.base - 4; seam += 10) fill(ctx, p.edge, b.x + 2, seam, b.w - 3, 1);
    }
    if (b.type === "warehouse") {
      fill(ctx, "#29374a", b.x + 3, b.base - 8, Math.max(4, b.w - 7), 5);
      fill(ctx, "#11182a", b.x + 5, b.base - 7, Math.max(3, b.w - 11), 4);
    }
    for (var row = 0; row < rows; row++) {
      for (var col = 0; col < cols; col++) {
        var x = b.x + 3 + col * 4;
        var y = top + 6 + row * 6;
        if (x + winW >= b.x + b.w - 1 || y + winH >= b.base - 5) continue;
        var lit = local() < litRate;
        fill(ctx, lit ? (local() < 0.1 ? COLORS.cyan : local() < 0.56 ? COLORS.warm : COLORS.gold) : (b.depth === 0 ? "#1a263c" : "#172035"), x, y, winW, winH);
      }
    }
    if (b.type === "shop") {
      var awning = b.base - 8;
      fill(ctx, "#684151", b.x + 1, awning, b.w - 2, 2);
      for (var stripe = b.x + 2; stripe < b.x + b.w - 2; stripe += 4) fill(ctx, stripe % 8 === 2 ? COLORS.orange : "#754856", stripe, awning, 2, 2);
      fill(ctx, "#15243a", b.x + 3, b.base - 5, b.w - 6, 4);
    }
    if (b.type === "residential-tower") line(ctx, "#3d5b6c", [[b.x + b.w - 2, top + 6], [b.x + b.w - 2, b.base - 5]], 1);
  }

  function drawRoofEquipment(ctx, b, p, top) {
    var cx = b.x + Math.floor(b.w / 2);
    if (b.roof === "parapet") fill(ctx, p.edge, b.x + 1, top - 3, b.w - 1, 2);
    else if (b.roof === "antenna") {
      line(ctx, "#536276", [[cx, top], [cx, top - 6]], 1);
      fill(ctx, COLORS.orange, cx, top - 7, 1, 1);
    } else if (b.roof === "tank") {
      fill(ctx, "#26384c", cx - 2, top - 4, 5, 3);
      fill(ctx, "#3c4d5d", cx - 1, top - 5, 3, 1);
    } else if (b.roof === "chimney") {
      fill(ctx, "#2b3548", b.x + 3, top - 4, 2, 4);
      fill(ctx, "#475263", b.x + 3, top - 5, 2, 1);
    }
  }

  function drawLandmark(ctx, activity, family, towerX, towerTop) {
    var cx = towerX == null ? 160 : towerX;
    var towerKind = (family || 0) % 4;
    var top = towerTop == null ? 28 : towerTop;
    if (towerKind === 0) top -= 8;
    else if (towerKind === 2) top += 5;
    var shaft = towerKind === 1 ? "#1d384d" : towerKind === 2 ? "#292944" : "#1d2d48";
    var shaftHi = towerKind === 1 ? "#31566a" : towerKind === 2 ? "#4b3d58" : "#29415a";
    // narrow shaft
    var shaftW = towerKind === 3 ? 8 : towerKind === 0 ? 4 : 6;
    fill(ctx, shaft, cx - Math.floor(shaftW / 2), top + 18, shaftW, BASE - top - 18);
    fill(ctx, shaftHi, cx + Math.max(0, Math.floor(shaftW / 4)), top + 18, 2, BASE - top - 18);
    for (var mark = top + 40; mark < BASE - 5; mark += 24) fill(ctx, "#40566c", cx - 2, mark, 4, 1);
    // Four deterministic landmark silhouettes: needle, broadcast deck,
    // stacked observatory and heavy metropolitan mast.
    var deckW = towerKind === 0 ? 12 : towerKind === 1 ? 22 : towerKind === 2 ? 16 : 26;
    fill(ctx, "#465a70", cx - Math.floor(deckW / 2), top + 14, deckW, 2);
    fill(ctx, "#1a2b45", cx - (towerKind === 2 ? 5 : 3), top + 8, towerKind === 2 ? 10 : 6, 6);
    if (towerKind === 2) fill(ctx, "#5b4960", cx - 7, top + 22, 14, 2);
    if (towerKind === 3) {
      fill(ctx, "#263b54", cx - 6, top + 31, 12, 4);
      fill(ctx, "#40566c", cx - 9, top + 34, 18, 2);
    }
    fill(ctx, COLORS.cyan, cx - 1, top + 22, 2, 2);
    fill(ctx, activity > 0.5 ? COLORS.orange : "#734b54", cx - 1, top + 47, 2, 2);
    fill(ctx, COLORS.gold, cx - 1, top + 73, 2, 2);
    line(ctx, "#4c6177", [[cx, top + 8], [cx, top - 13]], 1);
    fill(ctx, COLORS.orange, cx, top - 15, 1, 2);
  }

  function drawPlatform(ctx, plan) {
    var family = plan && plan.family || 0;
    var far = [160, 128];
    var right = [family === 5 ? 286 : 294, 146];
    var front = [160, 164];
    var left = [family === 4 ? 18 : family === 5 ? 34 : 26, 146];
    poly(ctx, COLORS.edge1, [left, front, [front[0], front[1] + 6], [left[0], left[1] + 6]]);
    poly(ctx, COLORS.edge2, [front, right, [right[0], right[1] + 6], [front[0], front[1] + 6]]);
    poly(ctx, COLORS.platform, [far, right, front, left]);
    poly(ctx, COLORS.road, [[46, 147], [160, 134], [274, 147], [160, 158]]);
    poly(ctx, COLORS.roadHi, [[154, 136], [166, 136], [166, 160], [154, 160]]);
    poly(ctx, "#25203b", [[43, 146], [277, 146], [270, 150], [50, 150]]);
    line(ctx, COLORS.edge0, [left, front, right], 1);
  }

  function drawStreetSurface(ctx, plan) {
    var style = plan && plan.roadStyle || 0;
    var towerX = plan && plan.towerX || 160;

    if (style === 0) {
      line(ctx, "#302944", [[50, 148], [160, 158], [270, 148]], 1);
      line(ctx, "#292643", [[89, 143], [160, 158]], 1);
      line(ctx, "#292643", [[231, 143], [160, 158]], 1);
    } else if (style === 1) {
      line(ctx, "#302944", [[40, 149], [towerX - 17, 155], [160, 158], [278, 147]], 1);
      line(ctx, "#292643", [[78, 143], [160, 158]], 1);
      line(ctx, "#292643", [[214, 143], [160, 158]], 1);
    } else if (style === 2) {
      line(ctx, "#302944", [[58, 146], [160, 158], [262, 146]], 1);
      line(ctx, "#292643", [[105, 141], [160, 158], [201, 142]], 1);
      line(ctx, "#292643", [[towerX - 28, 146], [towerX, 158]], 1);
    } else {
      line(ctx, "#302944", [[43, 150], [160, 142], [277, 150]], 1);
      line(ctx, "#292643", [[91, 145], [160, 158], [228, 145]], 1);
      line(ctx, "#292643", [[towerX, 142], [160, 158]], 1);
    }
  }

  function drawTrees(ctx, plan) {
    var treeSpots = [
      [[48, 148], [91, 151], [224, 151], [265, 148], [184, 153]],
      [[36, 147], [75, 151], [108, 149], [235, 150], [278, 147]],
      [[54, 149], [122, 152], [201, 150], [244, 152], [281, 148]],
      [[40, 150], [84, 148], [173, 153], [225, 149], [270, 151]]
    ];
    var spots = treeSpots[plan && plan.treeStyle || 0];
    var count = plan.foreground.length > 6 ? spots.length : 4;
    for (var i = 0; i < count; i++) {
      var x = spots[i][0];
      var y = spots[i][1];
      fill(ctx, "#132a31", x, y - 5, 2, 5);
      fill(ctx, COLORS.tree, x - 2, y - 8, 6, 4);
      fill(ctx, COLORS.treeHi, x - 1, y - 9, 4, 2);
    }
  }

  function drawStreetDetails(ctx, plan) {
    var lampSets = [
      [[42, 149], [91, 153], [229, 153], [278, 149]],
      [[52, 148], [126, 155], [201, 153], [269, 146]],
      [[71, 145], [114, 153], [232, 153], [258, 148]],
      [[46, 150], [98, 146], [188, 154], [246, 149]]
    ];
    var lamps = lampSets[plan && plan.roadStyle || 0];
    for (var i = 0; i < lamps.length; i++) {
      fill(ctx, "#26334b", lamps[i][0], lamps[i][1] - 5, 1, 5);
      fill(ctx, COLORS.gold, lamps[i][0] - 1, lamps[i][1] - 6, 2, 1);
    }
  }

  function drawPlatformFront(ctx, plan) {
    var family = plan && plan.family || 0;
    var left = family === 4 ? 18 : family === 5 ? 34 : 26;
    var right = family === 5 ? 286 : 294;
    line(ctx, "#443b5b", [[left, 146], [160, 164], [right, 146]], 1);
    line(ctx, COLORS.edge0, [[40, 155], [160, 170], [280, 155]], 2);
    line(ctx, COLORS.edge1, [[54, 160], [160, 174], [266, 160]], 2);
    line(ctx, COLORS.edge2, [[70, 164], [160, 177], [250, 164]], 2);
  }

  window.TokentownIsoCity = { mount: mount };
})();
