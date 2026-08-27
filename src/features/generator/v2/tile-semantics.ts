const WALL = "O";
const ROBOT = "R";
const GENERIC_BOX = "X";
const GENERIC_GOAL = "S";

export function isWallChar(ch: string): boolean {
  return ch === WALL;
}

export function isRobotChar(ch: string): boolean {
  return ch === ROBOT;
}

export function isGenericBoxChar(ch: string): boolean {
  return ch === GENERIC_BOX;
}

export function isTypedBoxChar(ch: string): boolean {
  return ch >= "A" && ch <= "Z" && ch !== WALL && ch !== ROBOT && ch !== GENERIC_GOAL && ch !== GENERIC_BOX;
}

export function isBoxChar(ch: string): boolean {
  return ch === GENERIC_BOX || isTypedBoxChar(ch);
}

export function isGenericGoalChar(ch: string): boolean {
  return ch === GENERIC_GOAL;
}

export function isTypedGoalChar(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

export function isGoalChar(ch: string): boolean {
  return ch === GENERIC_GOAL || isTypedGoalChar(ch);
}

export function isFloorChar(ch: string): boolean {
  return ch === " ";
}

export function isWalkableChar(ch: string): boolean {
  return ch !== WALL;
}
