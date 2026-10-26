# OSM-Building-Area

A Chrome/Edge extension that shows an estimated building footprint area directly
in the OpenStreetMap object sidebar — no QGIS, no separate website, no manual
tracing.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome, or `edge://extensions` in Edge.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select this folder (the one containing
   `manifest.json`).
5. Open any object, for example
   <https://www.openstreetmap.org/way/966679261>.

## What it does

When the page selects a way or a relation, a small panel appears under the
object title showing:

- the area in **square metres** and hectares,
- whether the object is tagged as a building,
- how many inner rings (courtyards or holes) were subtracted,
- a **Copy** button that copies the area in square metres.

## How the area is calculated

The extension reads the object's geometry from OpenStreetMap's own API and
computes the area on a local tangent plane, using the WGS84 ellipsoid's meridian
and prime-vertical radii of curvature.

For real buildings this agrees with a full geodesic (Karney) calculation to well
under one square metre. Multipolygon relations are assembled from their member
ways, including rings split across several ways, and inner rings are subtracted
from the outer rings so courtyards are not counted.

Some reference checks:

| Object | Shown | Geodesic reference |
| --- | --- | --- |
| Way 966679261 (building) | 656 m² | 655.9951 m² |
| Relation 56211 (2 outer, 24 inner rings) | 30,708 m² | 30,707.51 m² |
| Way 4256953 (park, closed but not a building) | 6,353 m² | 6,352.94 m² |

## Accuracy and limitations

- The result is the **flat mapped footprint** only. It is not floor area, not the
  sum over storeys, and not an official survey measurement.
- Accuracy is limited by how precisely the building is mapped in OpenStreetMap.
- Relations whose geometry cannot be closed into rings report that no area is
  available rather than showing a guess.
- Open ways (roads, fences) and plain nodes have no footprint, so the panel says
  so explicitly.
- Geometry is fetched from the public OSM API. If that returns an error or rate
  limits you, the panel shows the reason instead of a value.

## Permissions

None. The script only runs on `openstreetmap.org`, and it requests geometry from
that same site, so `fetch` stays within the page's own Content-Security-Policy.

## License

GPL-3.0 — see [LICENSE](LICENSE).
