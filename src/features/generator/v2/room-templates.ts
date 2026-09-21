export interface RoomTemplate {
  readonly name: string;
  readonly mask: readonly (readonly boolean[])[];
  readonly minSize: number;
  readonly maxSize: number;
  readonly canRotate: boolean;
  readonly canMirror: boolean;
}

export interface StampedRoom {
  readonly template: RoomTemplate;
  readonly mask: readonly (readonly boolean[])[];
  readonly width: number;
  readonly height: number;
}

const RECTANGLE: RoomTemplate = {
  name: "rectangle",
  mask: [
    [true, true, true],
    [true, true, true],
    [true, true, true],
  ],
  minSize: 3,
  maxSize: 7,
  canRotate: false,
  canMirror: false,
};

const L_SHAPE: RoomTemplate = {
  name: "L-shape",
  mask: [
    [true,  true,  false],
    [true,  true,  false],
    [true,  true,  true ],
    [true,  true,  true ],
  ],
  minSize: 3,
  maxSize: 6,
  canRotate: true,
  canMirror: true,
};

const T_SHAPE: RoomTemplate = {
  name: "T-shape",
  mask: [
    [true, true, true, true, true],
    [false, false, true, false, false],
    [false, false, true, false, false],
  ],
  minSize: 3,
  maxSize: 6,
  canRotate: true,
  canMirror: false,
};

const U_SHAPE: RoomTemplate = {
  name: "U-shape",
  mask: [
    [true,  false, true ],
    [true,  false, true ],
    [true,  true,  true ],
  ],
  minSize: 3,
  maxSize: 5,
  canRotate: true,
  canMirror: false,
};

const CROSS: RoomTemplate = {
  name: "cross",
  mask: [
    [false, true, false],
    [true,  true, true ],
    [false, true, false],
  ],
  minSize: 3,
  maxSize: 5,
  canRotate: false,
  canMirror: false,
};

const NOTCH: RoomTemplate = {
  name: "notch",
  mask: [
    [true, true, true, true],
    [true, true, true, true],
    [true, false, true, true],
    [true, true, true, true],
  ],
  minSize: 4,
  maxSize: 6,
  canRotate: true,
  canMirror: true,
};

const CHAMBER: RoomTemplate = {
  name: "chamber",
  mask: [
    [true,  true,  true, true ],
    [true,  true,  true, true ],
    [false, false, true, false],
    [true,  true,  true, true ],
    [true,  true,  true, true ],
  ],
  minSize: 4,
  maxSize: 6,
  canRotate: true,
  canMirror: true,
};

const ZIGZAG: RoomTemplate = {
  name: "zigzag",
  mask: [
    [true,  true,  false, false],
    [false, true,  true,  false],
    [false, false, true,  true ],
  ],
  minSize: 3,
  maxSize: 5,
  canRotate: true,
  canMirror: true,
};

const ALCOVE: RoomTemplate = {
  name: "alcove",
  mask: [
    [true,  true,  true ],
    [true,  true,  true ],
    [true,  true,  false],
  ],
  minSize: 3,
  maxSize: 5,
  canRotate: true,
  canMirror: true,
};

const WIDE_CORRIDOR: RoomTemplate = {
  name: "wide-corridor",
  mask: [
    [true, true],
    [true, true],
    [true, true],
    [true, true],
    [true, true],
  ],
  minSize: 3,
  maxSize: 6,
  canRotate: true,
  canMirror: false,
};

export const ROOM_TEMPLATES: readonly RoomTemplate[] = [
  RECTANGLE,
  RECTANGLE,
  L_SHAPE,
  T_SHAPE,
  U_SHAPE,
  CROSS,
  NOTCH,
  CHAMBER,
  ZIGZAG,
  ALCOVE,
  WIDE_CORRIDOR,
];

function rotateMask90(mask: readonly (readonly boolean[])[]): boolean[][] {
  const rows = mask.length;
  const cols = mask[0].length;
  const rotated: boolean[][] = [];
  for (let c = 0; c < cols; c++) {
    const row: boolean[] = [];
    for (let r = rows - 1; r >= 0; r--) {
      row.push(mask[r][c]);
    }
    rotated.push(row);
  }
  return rotated;
}

function mirrorMaskH(mask: readonly (readonly boolean[])[]): boolean[][] {
  return mask.map((row) => [...row].reverse());
}

function applyTransform(
  mask: readonly (readonly boolean[])[],
  rotations: number,
  mirror: boolean,
): boolean[][] {
  let result: boolean[][] = mask.map((row) => [...row]);
  for (let i = 0; i < rotations; i++) {
    result = rotateMask90(result);
  }
  if (mirror) {
    result = mirrorMaskH(result);
  }
  return result;
}

function scaleMask(
  mask: readonly (readonly boolean[])[],
  targetWidth: number,
  targetHeight: number,
): boolean[][] {
  const srcH = mask.length;
  const srcW = mask[0].length;
  const result: boolean[][] = [];
  for (let r = 0; r < targetHeight; r++) {
    const row: boolean[] = [];
    const srcR = Math.min(Math.floor((r / targetHeight) * srcH), srcH - 1);
    for (let c = 0; c < targetWidth; c++) {
      const srcC = Math.min(Math.floor((c / targetWidth) * srcW), srcW - 1);
      row.push(mask[srcR][srcC]);
    }
    result.push(row);
  }
  return result;
}

export function pickTemplate(
  rng: () => number,
  targetWidth: number,
  targetHeight: number,
): StampedRoom {
  const eligible = ROOM_TEMPLATES.filter(
    (t) =>
      targetWidth >= t.minSize &&
      targetHeight >= t.minSize &&
      targetWidth <= t.maxSize &&
      targetHeight <= t.maxSize,
  );

  const template =
    eligible.length > 0
      ? eligible[Math.floor(rng() * eligible.length)]
      : RECTANGLE;

  const rotations = template.canRotate ? Math.floor(rng() * 4) : 0;
  const mirror = template.canMirror && rng() > 0.5;

  const transformed = applyTransform(template.mask, rotations, mirror);
  const scaled = scaleMask(transformed, targetWidth, targetHeight);

  return {
    template,
    mask: scaled,
    width: targetWidth,
    height: targetHeight,
  };
}

export function rasterizeTemplate(
  stamped: StampedRoom,
  x: number,
  y: number,
  grid: string[][],
  boardWidth: number,
  boardHeight: number,
): void {
  for (let dy = 0; dy < stamped.height; dy++) {
    for (let dx = 0; dx < stamped.width; dx++) {
      if (!stamped.mask[dy][dx]) continue;
      const gy = y + dy;
      const gx = x + dx;
      if (gy > 0 && gy < boardHeight - 1 && gx > 0 && gx < boardWidth - 1) {
        grid[gy][gx] = " ";
      }
    }
  }
}
