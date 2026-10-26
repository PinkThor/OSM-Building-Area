/**
 * OSM Building Area — shows an estimated building footprint area in the
 * OpenStreetMap object-details sidebar.
 *
 * Notes on the implementation choices:
 *  - Geometry is requested from the SAME ORIGIN (/api/0.6/...) because
 *    openstreetmap.org serves a Content-Security-Policy whose connect-src does
 *    not include api.openstreetmap.org. A cross-origin fetch is blocked there.
 *  - Area is computed on a local tangent plane using the WGS84 meridian and
 *    prime-vertical radii of curvature. For ordinary footprints this agrees
 *    with a full geodesic calculation to well under 0.01 m², and it stays
 *    within ~0.002 % even for kilometre-scale polygons.
 *  - Multipolygon relations are assembled from their member ways; inner rings
 *    (courtyards, holes) are subtracted from the outer rings.
 */
(() => {
  "use strict";

  const PANEL_ID = "osm-building-area-panel";
  const WGS84_A = 6378137.0;
  const WGS84_F = 1 / 298.257223563;
  const WGS84_E2 = WGS84_F * (2 - WGS84_F);

  let currentKey = null;
  let requestToken = 0;
  const areaCache = new Map();

  /* ------------------------------------------------------------------ */
  /* Which object is selected?                                           */
  /* ------------------------------------------------------------------ */

  function selectedObject() {
    if (!/^(www\.)?openstreetmap\.org$/.test(location.hostname)) return null;
    const match = location.pathname.match(/^\/(way|relation)\/(\d+)\/?$/);
    if (!match) return null;
    return { type: match[1], id: match[2], key: `${match[1]}/${match[2]}` };
  }

  /* ------------------------------------------------------------------ */
  /* Geometry maths                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Project a lat/lon ring onto a tangent plane at (lat0, lon0) and return the
   * signed shoelace area in square metres.
   */
  function planeArea(ring, lat0, lon0) {
    const radius = (lat) => {
      const sin = Math.sin((lat * Math.PI) / 180);
      const w = 1 - WGS84_E2 * sin * sin;
      return {
        // Prime-vertical radius of curvature (east-west scale).
        N: WGS84_A / Math.sqrt(w),
        // Meridian radius of curvature (north-south scale).
        M: (WGS84_A * (1 - WGS84_E2)) / Math.pow(w, 1.5)
      };
    };

    const at = radius(lat0);
    const cosLat0 = Math.cos((lat0 * Math.PI) / 180);
    const xs = new Float64Array(ring.length);
    const ys = new Float64Array(ring.length);

    for (let i = 0; i < ring.length; i++) {
      xs[i] = ((ring[i].lon - lon0) * Math.PI / 180) * at.N * cosLat0;
      ys[i] = ((ring[i].lat - lat0) * Math.PI / 180) * at.M;
    }

    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      sum += xs[i] * ys[i + 1] - xs[i + 1] * ys[i];
    }
    return sum / 2;
  }

  /**
   * Net area of a set of outer/inner rings, all projected about one origin so
   * that holes subtract consistently.
   */
  function ringsArea(outerRings, innerRings) {
    const all = outerRings.concat(innerRings);
    if (!all.length) return null;

    let latSum = 0;
    let lonSum = 0;
    let count = 0;
    for (const ring of all) {
      for (const p of ring) {
        latSum += p.lat;
        lonSum += p.lon;
        count++;
      }
    }
    const lat0 = latSum / count;
    const lon0 = lonSum / count;

    let outer = 0;
    let inner = 0;
    for (const ring of outerRings) outer += Math.abs(planeArea(ring, lat0, lon0));
    for (const ring of innerRings) inner += Math.abs(planeArea(ring, lat0, lon0));

    const net = outer - inner;
    return net > 0 ? { outer, inner, net } : null;
  }

  /* ------------------------------------------------------------------ */
  /* OSM XML parsing                                                     */
  /* ------------------------------------------------------------------ */

  function parseOsmXml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("could not parse OSM geometry");

    const nodes = new Map();
    for (const node of doc.querySelectorAll("node[id]")) {
      const lat = Number(node.getAttribute("lat"));
      const lon = Number(node.getAttribute("lon"));
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        nodes.set(node.getAttribute("id"), { lat, lon });
      }
    }

    const ways = new Map();
    for (const way of doc.querySelectorAll("way[id]")) {
      const refs = [];
      for (const nd of way.children) {
        if (nd.tagName === "nd") refs.push(nd.getAttribute("ref"));
      }
      ways.set(way.getAttribute("id"), { refs, element: way });
    }

    const relations = new Map();
    for (const rel of doc.querySelectorAll("relation[id]")) {
      const members = [];
      for (const member of rel.children) {
        if (member.tagName === "member" && member.getAttribute("type") === "way") {
          members.push({
            ref: member.getAttribute("ref"),
            role: member.getAttribute("role") || "outer"
          });
        }
      }
      relations.set(rel.getAttribute("id"), { members, element: rel });
    }

    return { doc, nodes, ways, relations };
  }

  function wayCoords(refs, nodes) {
    const coords = [];
    for (const ref of refs) {
      const node = nodes.get(ref);
      if (!node) return null;
      coords.push(node);
    }
    return coords;
  }

  /** Join way fragments into closed rings (multipolygons split rings freely). */
  function assembleRings(wayIds, ways, nodes) {
    const remaining = wayIds.slice();
    const rings = [];

    while (remaining.length) {
      let chain = wayCoords(ways.get(remaining.shift()).refs, nodes);
      if (!chain || chain.length < 2) continue;

      let joined = true;
      while (chain[0] !== chain[chain.length - 1] && joined) {
        joined = false;
        for (let i = 0; i < remaining.length; i++) {
          const next = wayCoords(ways.get(remaining[i]).refs, nodes);
          if (!next || next.length < 2) continue;

          const head = chain[0];
          const tail = chain[chain.length - 1];
          const nHead = next[0];
          const nTail = next[next.length - 1];

          if (nHead === tail) chain = chain.concat(next.slice(1));
          else if (nTail === tail) chain = chain.concat(next.slice().reverse().slice(1));
          else if (nTail === head) chain = next.slice(0, -1).concat(chain);
          else if (nHead === head) chain = next.slice().reverse().slice(0, -1).concat(chain);
          else continue;

          remaining.splice(i, 1);
          joined = true;
          break;
        }
      }

      if (chain.length >= 4 && chain[0] === chain[chain.length - 1]) rings.push(chain);
    }
    return rings;
  }

  function hasBuildingTag(element) {
    for (const tag of element.children) {
      if (tag.tagName === "tag" && tag.getAttribute("k") === "building") {
        return tag.getAttribute("v") !== "no";
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Area from an OSM API response                                       */
  /* ------------------------------------------------------------------ */

  function computeArea(parsed, target) {
    const { nodes, ways, relations } = parsed;

    if (target.type === "way") {
      const way = ways.get(target.id);
      if (!way) throw new Error("way not found in API response");

      const ring = wayCoords(way.refs, nodes);
      if (!ring) throw new Error("the way references nodes that are not present");
      if (ring.length < 4 || ring[0] !== ring[ring.length - 1]) {
        return { kind: "open", isBuilding: hasBuildingTag(way.element) };
      }

      const result = ringsArea([ring], []);
      if (!result) throw new Error("the polygon encloses no area");
      return { kind: "closed", isBuilding: hasBuildingTag(way.element), ...result };
    }

    // Relation: only multipolygon-style relations carry an area worth summing.
    const relation = relations.get(target.id);
    if (!relation) throw new Error("relation not found in API response");

    const tags = {};
    for (const tag of relation.element.children) {
      if (tag.tagName === "tag") tags[tag.getAttribute("k")] = tag.getAttribute("v");
    }

    const isBuilding = tags.building !== undefined && tags.building !== "no";
    if (tags.type !== "multipolygon" && tags.building === undefined) {
      return { kind: "unsupported", isBuilding };
    }

    const outerIds = [];
    const innerIds = [];
    for (const member of relation.members) {
      if (member.role === "inner") innerIds.push(member.ref);
      else outerIds.push(member.ref);
    }

    const outerRings = assembleRings(outerIds, ways, nodes);
    const innerRings = assembleRings(innerIds, ways, nodes);

    if (!outerRings.length) {
      return { kind: "open", isBuilding, detail: "no closed outer ring could be assembled" };
    }

    const result = ringsArea(outerRings, innerRings);
    if (!result) throw new Error("the relation encloses no net area");
    return {
      kind: "closed",
      isBuilding,
      outerRings: outerRings.length,
      innerRings: innerRings.length,
      ...result
    };
  }

  async function fetchGeometry(target) {
    // Same-origin: satisfies the page CSP connect-src 'self' directive.
    const url = `${location.origin}/api/0.6/${target.type}/${target.id}/full`;
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`OpenStreetMap API returned HTTP ${response.status}`);
    return parseOsmXml(await response.text());
  }

  /* ------------------------------------------------------------------ */
  /* Formatting                                                          */
  /* ------------------------------------------------------------------ */

  function fmt(value, digits) {
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits
    }).format(value);
  }

  function formatArea(m2) {
    const sqm = fmt(m2, m2 < 100 ? 1 : 0);
    const ha = fmt(m2 / 10000, 4);
    return { sqm, ha, plain: `${sqm} m²` };
  }

  /* ------------------------------------------------------------------ */
  /* Sidebar panel                                                        */
  /* ------------------------------------------------------------------ */

  function sidebar() {
    return document.getElementById("sidebar_content");
  }

  function buildPanel() {
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.dataset.state = "idle";
    panel.innerHTML = `
      <div class="oba-head">
        <span class="oba-heading">Estimated footprint area</span>
        <button type="button" class="oba-copy" hidden>Copy</button>
      </div>
      <div class="oba-value" aria-live="polite">Calculating…</div>
      <div class="oba-detail"></div>
      <div class="oba-note">Estimate from mapped OSM geometry — not an official survey or floor area.</div>
    `;
    return panel;
  }

  function place(panel) {
    const host = sidebar();
    if (!host) return false;

    const heading = host.querySelector("h2");
    // Prefer sitting directly below the object title, which is where a reader
    // looks for summary facts. Fall back to the top of the sidebar.
    if (heading && heading.parentElement) {
      if (heading.nextElementSibling !== panel) {
        heading.insertAdjacentElement("afterend", panel);
      }
    } else if (host.firstElementChild !== panel) {
      host.prepend(panel);
    }
    return host.contains(panel);
  }

  function render(panel, state) {
    const value = panel.querySelector(".oba-value");
    const detail = panel.querySelector(".oba-detail");
    const copy = panel.querySelector(".oba-copy");

    if (state.kind === "pending") {
      value.textContent = "Calculating…";
      detail.textContent = "";
      copy.hidden = true;
      copy.dataset.area = "";
      return;
    }

    if (state.error) {
      value.textContent = "Area unavailable";
      detail.textContent = state.error;
      copy.hidden = true;
      return;
    }

    if (state.kind === "open") {
      value.textContent = "Not a closed polygon";
      detail.textContent =
        "This object has no closed outline, so an enclosed footprint cannot be calculated.";
      copy.hidden = true;
      return;
    }

    if (state.kind === "unsupported") {
      value.textContent = "Area unavailable";
      detail.textContent = "This relation is not a multipolygon or building, so it has no simple footprint.";
      copy.hidden = true;
      return;
    }

    const f = formatArea(state.net);
    value.textContent = `${f.sqm} m² (${f.ha} ha)`;

    const bits = [];
    if (state.isBuilding) bits.push("Building footprint");
    else bits.push("Closed way — no building tag");

    if (state.innerRings) {
      bits.push(`${state.innerRings} inner ring${state.innerRings === 1 ? "" : "s"} subtracted`);
    }
    if (state.outerRings && state.outerRings > 1) {
      bits.push(`${state.outerRings} outer rings`);
    }
    detail.textContent = bits.join(" · ");

    copy.hidden = false;
    copy.dataset.area = f.plain;
  }

  function flash(button, label) {
    button.textContent = label;
    clearTimeout(button._resetTimer);
    button._resetTimer = setTimeout(() => {
      button.textContent = "Copy";
    }, 1400);
  }

  /**
   * Copy text, falling back to a hidden textarea for contexts where the async
   * Clipboard API is unavailable or refused. Returns true only on success so
   * the button never claims something that did not happen.
   */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path */
    }

    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.top = "-1000px";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function update() {
    const target = selectedObject();
    const existing = document.getElementById(PANEL_ID);

    if (!target) {
      if (existing) existing.remove();
      currentKey = null;
      return;
    }

    if (!sidebar()) return;

    const panel = existing || buildPanel();
    if (!existing) {
      const copy = panel.querySelector(".oba-copy");
      copy.addEventListener("click", async () => {
        const ok = await copyText(copy.dataset.area || "");
        flash(copy, ok ? "Copied" : "Copy failed");
      });
    }
    place(panel);

    // Done: keep the result. Failed: keep the message rather than re-fetching on
    // every DOM mutation, which would hammer the API for an object that will
    // not resolve until the user navigates away.
    // A request is already running, or this object already has an answer: do
    // not start another fetch on the next DOM mutation. Re-fetching here would
    // cancel the in-flight request via the token and loop forever.
    if (target.key === currentKey && panel.dataset.state !== "idle") return;

    render(panel, { kind: "pending" });
    panel.dataset.state = "pending";
    currentKey = target.key;

    const token = ++requestToken;
    try {
      let result = areaCache.get(target.key);
      if (!result) {
        result = computeArea(await fetchGeometry(target), target);
        areaCache.set(target.key, result);
      }
      if (token !== requestToken) return;
      if (selectedObject()?.key !== target.key) return;

      render(panel, result);
      panel.dataset.state = "done";
      place(panel);
    } catch (error) {
      if (token !== requestToken) return;
      render(panel, { error: error.message || "could not read the geometry" });
      panel.dataset.state = "error";
    }
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      update();
    });
  }

  // OSM is a Turbo application: the sidebar subtree and the URL both change
  // without a full page load, so watch the DOM and the history entries.
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function patched(...args) {
      const result = original.apply(this, args);
      schedule();
      return result;
    };
  }
  window.addEventListener("popstate", schedule);

  // Turbo replaces the sidebar subtree outright during in-page navigation, so
  // a cheap periodic re-check is the reliable safety net; update() no-ops
  // unless the selected object or the panel actually changed.
  setInterval(update, 800);

  update();
})();
