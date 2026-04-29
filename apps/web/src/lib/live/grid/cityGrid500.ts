/**
 * Deterministic 500 m city grid in WGS84. Cell corners are fixed world
 * coordinates — map zoom/rotation does not change them.
 */

export type CityGridSpecCompact = {
  cellMeters: number;
  swLat: number;
  swLng: number;
  dLat: number;
  dLng: number;
  nCols: number;
  nRows: number;
  cityLabel: string | null;
};

export type GridCellPublic = {
  id: string;
  label: string;
  row: number;
  col: number;
  polygon: Array<{ lat: number; lng: number }>;
};

const EARTH = 111_320;

/** Excel-style column: 0 → A, 25 → Z, 26 → AA */
export function columnLabelFromIndex(col: number): string {
  let n = col + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function cellLabel(row: number, col: number): string {
  return `${columnLabelFromIndex(col)}${row + 1}`;
}

export function cellId(row: number, col: number): string {
  return `grid:r${row}:c${col}`;
}

export function buildCityGrid500(
  swLat: number,
  swLng: number,
  neLat: number,
  neLng: number,
  cityLabel: string | null,
  cellMeters = 500,
  maxCells = 1800,
): { spec: CityGridSpecCompact; cells: GridCellPublic[] } | { error: string } {
  const refLat = (swLat + neLat) / 2;
  const cos = Math.cos((refLat * Math.PI) / 180);
  const dLat = cellMeters / EARTH;
  const dLng = cellMeters / (EARTH * Math.max(0.2, cos));

  const latSpan = neLat - swLat;
  const lngSpan = neLng - swLng;
  if (latSpan <= 0 || lngSpan <= 0) return { error: "invalid_bbox" };

  const nCols = Math.ceil(lngSpan / dLng);
  const nRows = Math.ceil(latSpan / dLat);
  if (nCols * nRows > maxCells) {
    return { error: "grid_too_large" };
  }

  const spec: CityGridSpecCompact = {
    cellMeters,
    swLat,
    swLng,
    dLat,
    dLng,
    nCols,
    nRows,
    cityLabel,
  };

  const cells: GridCellPublic[] = [];
  for (let col = 0; col < nCols; col += 1) {
    for (let row = 0; row < nRows; row += 1) {
      const w = swLat + row * dLat;
      const s = swLng + col * dLng;
      const n = w + dLat;
      const e = s + dLng;
      const polygon: Array<{ lat: number; lng: number }> = [
        { lat: w, lng: s },
        { lat: w, lng: e },
        { lat: n, lng: e },
        { lat: n, lng: s },
      ];
      cells.push({
        id: cellId(row, col),
        label: cellLabel(row, col),
        row,
        col,
        polygon,
      });
    }
  }
  return { spec, cells };
}

export function cellIdForPosition(
  spec: CityGridSpecCompact,
  lat: number,
  lng: number,
): string | null {
  const col = Math.floor((lng - spec.swLng) / spec.dLng);
  const row = Math.floor((lat - spec.swLat) / spec.dLat);
  if (col < 0 || col >= spec.nCols || row < 0 || row >= spec.nRows) return null;
  return cellId(row, col);
}

const GRID_ID = /^grid:r(\d+):c(\d+)$/;

export function parseGridOptionId(
  id: string,
): { row: number; col: number } | null {
  const m = GRID_ID.exec(id);
  if (!m) return null;
  return { row: Number(m[1]), col: Number(m[2]) };
}

export function isValidGridOptionForSpec(
  spec: CityGridSpecCompact,
  optionId: string,
): boolean {
  const p = parseGridOptionId(optionId);
  if (!p) return false;
  return (
    p.row >= 0 &&
    p.row < spec.nRows &&
    p.col >= 0 &&
    p.col < spec.nCols
  );
}

function oneCellPolygon(
  spec: CityGridSpecCompact,
  row: number,
  col: number,
): Array<{ lat: number; lng: number }> {
  const w = spec.swLat + row * spec.dLat;
  const s = spec.swLng + col * spec.dLng;
  const n = w + spec.dLat;
  const e = s + spec.dLng;
  return [
    { lat: w, lng: s },
    { lat: w, lng: e },
    { lat: n, lng: e },
    { lat: n, lng: s },
  ];
}

/** All cells (can be large — filter with `cellsInLatLngBounds` for the map). */
export function enumerateGridCells(spec: CityGridSpecCompact): GridCellPublic[] {
  const cells: GridCellPublic[] = [];
  for (let col = 0; col < spec.nCols; col += 1) {
    for (let row = 0; row < spec.nRows; row += 1) {
      cells.push({
        id: cellId(row, col),
        label: cellLabel(row, col),
        row,
        col,
        polygon: oneCellPolygon(spec, row, col),
      });
    }
  }
  return cells;
}

/** Cells whose bounding box intersects the given WGS84 rectangle (inclusive indices). */
export function cellsInLatLngBounds(
  spec: CityGridSpecCompact,
  south: number,
  west: number,
  north: number,
  east: number,
): GridCellPublic[] {
  const col0 = Math.max(0, Math.floor((west - spec.swLng) / spec.dLng));
  const col1 = Math.min(
    spec.nCols - 1,
    Math.ceil((east - spec.swLng) / spec.dLng) - 1,
  );
  const row0 = Math.max(0, Math.floor((south - spec.swLat) / spec.dLat));
  const row1 = Math.min(
    spec.nRows - 1,
    Math.ceil((north - spec.swLat) / spec.dLat) - 1,
  );
  if (col0 > col1 || row0 > row1) return [];
  const cells: GridCellPublic[] = [];
  for (let col = col0; col <= col1; col += 1) {
    for (let row = row0; row <= row1; row += 1) {
      cells.push({
        id: cellId(row, col),
        label: cellLabel(row, col),
        row,
        col,
        polygon: oneCellPolygon(spec, row, col),
      });
    }
  }
  return cells;
}
