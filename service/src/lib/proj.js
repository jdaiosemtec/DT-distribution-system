// Copied from Avaris2 CS app/renderer/js/proj.js (keep in sync); wrapped as a Node module.
// Minimal map projection engine (Snyder, "Map Projections - A Working Manual", USGS PP 1395)
// Geographic, Transverse Mercator (UTM, State Plane TM), Lambert Conformal Conic 1SP/2SP (incl. Michigan), Hotine Oblique
// Mercator A/B (e.g. Michigan GeoRef), Mercator / Web Mercator; WKT1 (OGC / ESRI) and WKT2.
'use strict';
(function (AV) {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const P = {};

  P.presetWKT = (k) => {
    if (k === 'GEO') return 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]';
    if (k === 'WEBM') return 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0],PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",0],UNIT["Meter",1]]';
    const z = +k.slice(3);
    return 'PROJCS["UTM_Zone_' + z + 'N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000],PARAMETER["False_Northing",0],PARAMETER["Central_Meridian",' + (-183 + 6 * z) + '],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0],UNIT["Meter",1]]';
  };

  // WKT1 (OGC / ESRI) and WKT2 (PROJCRS ... METHOD ... PARAMETER with units); compound systems use their projected part
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  P.parse = function (wkt) {
    wkt = String(wkt || '').replace(/^﻿/, '').trim();
    if (!wkt) throw new Error('empty coordinate system');
    if (/^\s*(COMPD_CS|COMPOUNDCRS)\b/i.test(wkt)) { const i = wkt.search(/(PROJCS|PROJCRS|PROJECTEDCRS|GEOGCS|GEOGCRS|GEODCRS)\s*\[/i); if (i > 0) wkt = wkt.slice(i); }
    const sph = /(?:SPHEROID|ELLIPSOID)\s*\[\s*"[^"]*"\s*,\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)/i.exec(wkt);
    const a = sph ? +sph[1] : 6378137, rf = sph ? +sph[2] : 298.257223563;
    const f = rf > 0 ? 1 / rf : 0, e2 = 2 * f - f * f;
    const isProj = /^\s*(PROJCS|PROJCRS|PROJECTEDCRS)\b/i.test(wkt);
    const S = { a, e2, e: Math.sqrt(e2) };
    if (!isProj) { if (!/^\s*(GEOGCS|GEOGCRS|GEODCRS|GEOGRAPHICCRS|GEODETICCRS)\b/i.test(wkt)) throw new Error('not a coordinate system (WKT must start with PROJCS / PROJCRS / GEOGCS / GEOGCRS)'); S.type = 'geographic'; return S; }
    // projection length unit: the last length unit of the string (WKT1 UNIT / WKT2 LENGTHUNIT)
    const units = [...wkt.matchAll(/(?:LENGTHUNIT|UNIT)\s*\[\s*"([^"]*)"\s*,\s*([\d.eE+-]+)/gi)].filter(u => !/degree|radian|grad|unity|arc|second|minute|ppm/i.test(u[1]));
    S.unit = units.length ? +units[units.length - 1][2] : 1;
    const PR = new Map();
    for (const m of wkt.matchAll(/PARAMETER\s*\[\s*"([^"]+)"\s*,\s*([-\d.eE+]+)(?:\s*,\s*(LENGTHUNIT|ANGLEUNIT|SCALEUNIT|UNIT)\s*\[\s*"([^"]*)"\s*,\s*([\d.eE+-]+))?/gi))
      PR.set(norm(m[1]), { v: +m[2], kind: (m[3] || '').toUpperCase(), uf: m[5] ? +m[5] : null, un: m[4] || '' });
    const get = (names, d) => { for (const n of names) { const p = PR.get(n); if (p) return p; } return d === undefined ? null : { v: d }; };
    const ang = (names, d) => { const p = get(names, d); if (!p || p.v === null || p.v === undefined) return NaN; return (p.kind === 'ANGLEUNIT' && p.uf && !/degree/i.test(p.un) ? p.v * p.uf * R2D : p.v) * D2R; };
    const lin = (names, d) => { const p = get(names, d); if (!p) return 0; return p.kind === 'LENGTHUNIT' && p.uf ? p.v * p.uf : p.v * S.unit; };
    const method = norm((/(?:PROJECTION|METHOD)\s*\[\s*"([^"]+)"/i.exec(wkt) || [, ''])[1]);
    S.x0 = lin(['false_easting', 'easting_at_false_origin', 'easting_at_projection_centre'], 0);
    S.y0 = lin(['false_northing', 'northing_at_false_origin', 'northing_at_projection_centre'], 0);
    S.lon0 = ang(['central_meridian', 'longitude_of_origin', 'longitude_of_center', 'longitude_of_centre', 'longitude_of_natural_origin', 'longitude_of_false_origin', 'longitude_of_projection_centre', 'longitude_of_projection_center'], 0);
    S.lat0 = ang(['latitude_of_origin', 'latitude_of_center', 'latitude_of_centre', 'latitude_of_natural_origin', 'latitude_of_false_origin', 'latitude_of_projection_centre', 'latitude_of_projection_center'], 0);
    S.k0 = (get(['scale_factor', 'scale_factor_at_natural_origin', 'ellipsoid_scaling_factor', 'scale_factor_on_initial_line', 'scale_factor_at_projection_centre'], 1) || { v: 1 }).v;
    S.method = method;
    if (/transverse_mercator|gauss_kruger/.test(method)) S.type = 'tm';
    else if (/lambert_conformal_conic|lambert_conic_conformal/.test(method)) {
      S.type = 'lcc';
      S.lat1 = ang(['standard_parallel_1', 'latitude_of_1st_standard_parallel']); S.lat2 = ang(['standard_parallel_2', 'latitude_of_2nd_standard_parallel']);
      if (!isFinite(S.lat1)) S.lat1 = S.lat0; if (!isFinite(S.lat2)) S.lat2 = S.lat1;
    } else if (/oblique_mercator|rectified_skew/.test(method)) {
      S.type = 'hom'; S.variantB = !/natural_origin|variant_a/.test(method);
      S.alpha = ang(['azimuth', 'azimuth_of_initial_line', 'azimuth_at_projection_centre']); S.gammaC = ang(['rectified_grid_angle', 'angle_from_rectified_to_skew_grid', 'angle_from_rectified_to_skewed_grid']);
      if (!isFinite(S.gammaC)) S.gammaC = S.alpha; if (!isFinite(S.alpha)) throw new Error('oblique mercator without azimuth');
    } else if (/mercator_auxiliary_sphere|pseudo_mercator|popular_visualisation/.test(method) || /3857|web_mercator/i.test(wkt)) { S.type = 'merc'; S.sphere = true; }
    else if (/mercator/.test(method)) { S.type = 'merc'; S.lat1 = ang(['standard_parallel_1', 'latitude_of_1st_standard_parallel'], 0); if (!isFinite(S.lat1)) S.lat1 = 0; }
    else throw new Error('projection "' + (method || '?') + '" is not supported (supported: Transverse Mercator / UTM, Lambert Conformal Conic, Oblique Mercator, Mercator)');
    if (S.type === 'tm') { const e2 = S.e2; S.ep2 = e2 / (1 - e2); S.M0 = M(S, S.lat0); }
    if (S.type === 'lcc') {
      const m = (p) => Math.cos(p) / Math.sqrt(1 - S.e2 * Math.sin(p) ** 2);
      const t = (p) => Math.tan(Math.PI / 4 - p / 2) / Math.pow((1 - S.e * Math.sin(p)) / (1 + S.e * Math.sin(p)), S.e / 2);
      const m1 = m(S.lat1), m2 = m(S.lat2), t1 = t(S.lat1), t2 = t(S.lat2), t0 = t(S.lat0);
      S.n = Math.abs(S.lat1 - S.lat2) < 1e-10 ? Math.sin(S.lat1) : (Math.log(m1) - Math.log(m2)) / (Math.log(t1) - Math.log(t2));
      S.F = m1 / (S.n * Math.pow(t1, S.n)); S.rho0 = S.a * S.F * Math.pow(t0, S.n) * S.k0; S.tf = t;
    }
    if (S.type === 'hom') {   // EPSG Guidance Note 7-2, Hotine Oblique Mercator variants A and B
      const e2 = S.e2, e = S.e, pc = S.lat0, sp = Math.sin(pc);
      const B = Math.sqrt(1 + e2 * Math.cos(pc) ** 4 / (1 - e2)), A = S.a * B * S.k0 * Math.sqrt(1 - e2) / (1 - e2 * sp * sp);
      const t0 = Math.tan(Math.PI / 4 - pc / 2) / Math.pow((1 - e * sp) / (1 + e * sp), e / 2);
      let D = B * Math.sqrt(1 - e2) / (Math.cos(pc) * Math.sqrt(1 - e2 * sp * sp)); if (D < 1) D = 1;
      const F = D + Math.sqrt(D * D - 1) * (pc < 0 ? -1 : 1), H = F * Math.pow(t0, B), G = (F - 1 / F) / 2;
      const g0 = Math.asin(Math.sin(S.alpha) / D), l0 = S.lon0 - Math.asin(G * Math.tan(g0)) / B;
      const uc = S.variantB ? (Math.abs(S.alpha - Math.PI / 2) < 1e-12 ? A * (S.lon0 - l0) : (A / B) * Math.atan(Math.sqrt(D * D - 1) / Math.cos(S.alpha)) * (pc < 0 ? -1 : 1)) : 0;
      Object.assign(S, { hB: B, hA: A, hH: H, hg0: g0, hl0: l0, huc: uc });
    }
    return S;
  };
  function M(S, phi) {
    const e2 = S.e2, e4 = e2 * e2, e6 = e4 * e2;
    return S.a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi) + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
  }
  P.fromGeo = function (S, lon, lat) {
    if (S.type === 'geographic') return [lon, lat];
    const phi = lat * D2R, lam = lon * D2R;
    let x, y;
    if (S.type === 'tm') {
      const N = S.a / Math.sqrt(1 - S.e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = S.ep2 * Math.cos(phi) ** 2, A = (lam - S.lon0) * Math.cos(phi);
      const Mv = M(S, phi);
      x = S.k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * S.ep2) * A ** 5 / 120);
      y = S.k0 * (Mv - S.M0 + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * S.ep2) * A ** 6 / 720));
    } else if (S.type === 'lcc') {
      const rho = S.a * S.F * Math.pow(S.tf(phi), S.n) * S.k0, th = S.n * (lam - S.lon0);
      x = rho * Math.sin(th); y = S.rho0 - rho * Math.cos(th);
    } else if (S.type === 'hom') {
      const e = S.e, B = S.hB, A = S.hA, sp = Math.sin(phi);
      const tt = Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - e * sp) / (1 + e * sp), e / 2);
      const Q = S.hH / Math.pow(tt, B), Ss = (Q - 1 / Q) / 2, Tt = (Q + 1 / Q) / 2, V = Math.sin(B * (lam - S.hl0));
      const U = (-V * Math.cos(S.hg0) + Ss * Math.sin(S.hg0)) / Tt;
      const v = A * Math.log((1 - U) / (1 + U)) / (2 * B);
      let u = A * Math.atan2(Ss * Math.cos(S.hg0) + V * Math.sin(S.hg0), Math.cos(B * (lam - S.hl0))) / B;
      if (S.variantB) u -= Math.abs(S.huc) * (S.lat0 < 0 ? -1 : 1);
      x = v * Math.cos(S.gammaC) + u * Math.sin(S.gammaC); y = u * Math.cos(S.gammaC) - v * Math.sin(S.gammaC);
    } else if (S.type === 'merc') {
      if (S.sphere) { x = S.a * (lam - S.lon0); y = S.a * Math.log(Math.tan(Math.PI / 4 + phi / 2)); }
      else { const k = Math.cos(S.lat1 || 0) / Math.sqrt(1 - S.e2 * Math.sin(S.lat1 || 0) ** 2); x = S.a * k * (lam - S.lon0); y = S.a * k * Math.log(Math.tan(Math.PI / 4 + phi / 2) * Math.pow((1 - S.e * Math.sin(phi)) / (1 + S.e * Math.sin(phi)), S.e / 2)); }
    }
    return [(x + S.x0) / S.unit, (y + S.y0) / S.unit];
  };
  P.toGeo = function (S, X, Y) {
    if (S.type === 'geographic') return [X, Y];
    const x = X * S.unit - S.x0, y = Y * S.unit - S.y0;
    let phi, lam;
    if (S.type === 'tm') {
      const e2 = S.e2, Mv = S.M0 + y / S.k0, mu = Mv / (S.a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
      const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
      const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
      const C1 = S.ep2 * Math.cos(p1) ** 2, T1 = Math.tan(p1) ** 2, N1 = S.a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), R1 = S.a * (1 - e2) / Math.pow(1 - e2 * Math.sin(p1) ** 2, 1.5), Dd = x / (N1 * S.k0);
      phi = p1 - (N1 * Math.tan(p1) / R1) * (Dd * Dd / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * S.ep2) * Dd ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * S.ep2 - 3 * C1 * C1) * Dd ** 6 / 720);
      lam = S.lon0 + (Dd - (1 + 2 * T1 + C1) * Dd ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * S.ep2 + 24 * T1 * T1) * Dd ** 5 / 120) / Math.cos(p1);
    } else if (S.type === 'lcc') {
      const sgn = S.n < 0 ? -1 : 1; const rho = sgn * Math.hypot(x, S.rho0 - y); const th = Math.atan2(sgn * x, sgn * (S.rho0 - y));
      const t = Math.pow(rho / (S.a * S.F * S.k0), 1 / S.n);
      phi = Math.PI / 2 - 2 * Math.atan(t);
      for (let i = 0; i < 15; i++) { const es = S.e * Math.sin(phi); const np = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - es) / (1 + es), S.e / 2)); if (Math.abs(np - phi) < 1e-12) { phi = np; break; } phi = np; }
      lam = th / S.n + S.lon0;
    } else if (S.type === 'hom') {
      const e2 = S.e2, B = S.hB, A = S.hA;
      const v = x * Math.cos(S.gammaC) - y * Math.sin(S.gammaC);
      let u = y * Math.cos(S.gammaC) + x * Math.sin(S.gammaC); if (S.variantB) u += Math.abs(S.huc) * (S.lat0 < 0 ? -1 : 1);
      const Q = Math.exp(-B * v / A), Ss = (Q - 1 / Q) / 2, Tt = (Q + 1 / Q) / 2, V = Math.sin(B * u / A);
      const U = (V * Math.cos(S.hg0) + Ss * Math.sin(S.hg0)) / Tt;
      const tt = Math.pow(S.hH / Math.sqrt((1 + U) / (1 - U)), 1 / B);
      const chi = Math.PI / 2 - 2 * Math.atan(tt), e4 = e2 * e2, e6 = e4 * e2, e8 = e6 * e2;
      phi = chi + Math.sin(2 * chi) * (e2 / 2 + 5 * e4 / 24 + e6 / 12 + 13 * e8 / 360) + Math.sin(4 * chi) * (7 * e4 / 48 + 29 * e6 / 240 + 811 * e8 / 11520) + Math.sin(6 * chi) * (7 * e6 / 120 + 81 * e8 / 1120) + Math.sin(8 * chi) * (4279 * e8 / 161280);
      lam = S.hl0 - Math.atan2(Ss * Math.cos(S.hg0) - V * Math.sin(S.hg0), Math.cos(B * u / A)) / B;
    } else {
      if (S.sphere) { lam = x / S.a + S.lon0; phi = Math.PI / 2 - 2 * Math.atan(Math.exp(-y / S.a)); }
      else {
        const k = Math.cos(S.lat1 || 0) / Math.sqrt(1 - S.e2 * Math.sin(S.lat1 || 0) ** 2); lam = x / (S.a * k) + S.lon0; const t = Math.exp(-y / (S.a * k));
        phi = Math.PI / 2 - 2 * Math.atan(t); for (let i = 0; i < 15; i++) { const es = S.e * Math.sin(phi); phi = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - es) / (1 + es), S.e / 2)); }
      }
    }
    return [lam * R2D, phi * R2D];
  };
  AV.Proj = P;
})(module.exports.AV = {});
module.exports = module.exports.AV.Proj;
