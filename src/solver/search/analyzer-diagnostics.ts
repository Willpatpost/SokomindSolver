import type { CompiledSearchBoard } from "./compiled-board.ts";
import type { DenseBox } from "./model.ts";
import type { Room } from "./topology.ts";

export interface PushEvent {
  readonly boxIndex: number;
  readonly fromCell: number;
  readonly toCell: number;
  readonly keeperCell: number;
}

export interface BoxEpisode {
  readonly boxIndex: number;
  readonly startPush: number;
  readonly endPush: number;
  readonly pushCount: number;
  readonly startCell: number;
  readonly endCell: number;
}

export interface BoxEpisodeAnalysis {
  readonly boxIndex: number;
  readonly label: string;
  readonly episodes: readonly BoxEpisode[];
  readonly totalPushes: number;
  readonly onGoalAtEnd: boolean;
}

export interface EpisodeReport {
  readonly boxAnalyses: readonly BoxEpisodeAnalysis[];
  readonly totalEpisodes: number;
  readonly totalPushes: number;
  readonly averageEpisodesPerBox: number;
  readonly maxEpisodesForAnyBox: number;
}

export interface RegionEpisode {
  readonly roomIndex: number;
  readonly startPush: number;
  readonly endPush: number;
  readonly pushCount: number;
}

export interface RegionEpisodeReport {
  readonly episodes: readonly RegionEpisode[];
  readonly totalRegionSwitches: number;
  readonly roomVisitCounts: ReadonlyMap<number, number>;
}

export interface BoxFlexibility {
  readonly cell: number;
  readonly pushDirections: number;
  readonly supportDirections: number;
  readonly onGoal: boolean;
  readonly goalDistance: number;
}

export function analyzeBoxEpisodes(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
  pushEvents: readonly PushEvent[],
): EpisodeReport {
  const episodesByBox = new Map<number, BoxEpisode[]>();
  for (let i = 0; i < boxes.length; i++) {
    episodesByBox.set(i, []);
  }

  if (pushEvents.length > 0) {
    let currentBoxIndex = pushEvents[0].boxIndex;
    let episodeStart = 0;

    for (let i = 1; i <= pushEvents.length; i++) {
      if (i === pushEvents.length || pushEvents[i].boxIndex !== currentBoxIndex) {
        const episode = Object.freeze({
          boxIndex: currentBoxIndex,
          startPush: episodeStart,
          endPush: i,
          pushCount: i - episodeStart,
          startCell: pushEvents[episodeStart].fromCell,
          endCell: pushEvents[i - 1].toCell,
        });
        episodesByBox.get(currentBoxIndex)!.push(episode);

        if (i < pushEvents.length) {
          currentBoxIndex = pushEvents[i].boxIndex;
          episodeStart = i;
        }
      }
    }
  }

  let totalEpisodes = 0;
  let maxEpisodesForAnyBox = 0;

  const boxAnalyses = boxes.map((box, boxIndex) => {
    const episodes = Object.freeze(episodesByBox.get(boxIndex)!);
    let totalPushes = 0;
    for (const ep of episodes) {
      totalPushes += ep.pushCount;
    }
    totalEpisodes += episodes.length;
    if (episodes.length > maxEpisodesForAnyBox) {
      maxEpisodesForAnyBox = episodes.length;
    }

    const lastCell = episodes.length > 0
      ? episodes[episodes.length - 1].endCell
      : box.cell;

    const goalCells = board.goalCellsByLabel.get(box.label);
    const onGoalAtEnd = goalCells !== undefined && goalCells.includes(lastCell);

    return Object.freeze({
      boxIndex,
      label: box.label,
      episodes,
      totalPushes,
      onGoalAtEnd,
    });
  });

  return Object.freeze({
    boxAnalyses: Object.freeze(boxAnalyses),
    totalEpisodes,
    totalPushes: pushEvents.length,
    averageEpisodesPerBox: boxes.length > 0 ? totalEpisodes / boxes.length : 0,
    maxEpisodesForAnyBox,
  });
}

function findRoomIndex(
  rooms: readonly Room[],
  cell: number,
): number {
  for (let i = 0; i < rooms.length; i++) {
    if (rooms[i].cells.has(cell)) return i;
  }
  return -1;
}

export function analyzeRegionEpisodes(
  board: CompiledSearchBoard,
  pushEvents: readonly PushEvent[],
): RegionEpisodeReport {
  const rooms = board.topology.rooms;
  const episodes: RegionEpisode[] = [];
  const roomVisitCounts = new Map<number, number>();

  if (pushEvents.length === 0) {
    return Object.freeze({
      episodes: Object.freeze(episodes),
      totalRegionSwitches: 0,
      roomVisitCounts,
    });
  }

  let currentRoom = findRoomIndex(rooms, pushEvents[0].toCell);
  let episodeStart = 0;

  for (let i = 1; i <= pushEvents.length; i++) {
    const nextRoom = i < pushEvents.length
      ? findRoomIndex(rooms, pushEvents[i].toCell)
      : -2; // sentinel to force final episode close

    if (nextRoom !== currentRoom) {
      const episode = Object.freeze({
        roomIndex: currentRoom,
        startPush: episodeStart,
        endPush: i,
        pushCount: i - episodeStart,
      });
      episodes.push(episode);
      roomVisitCounts.set(
        currentRoom,
        (roomVisitCounts.get(currentRoom) ?? 0) + 1,
      );

      if (i < pushEvents.length) {
        currentRoom = nextRoom;
        episodeStart = i;
      }
    }
  }

  // Region switches = number of episode transitions = episodes.length - 1
  const totalRegionSwitches = episodes.length > 0 ? episodes.length - 1 : 0;

  return Object.freeze({
    episodes: Object.freeze(episodes),
    totalRegionSwitches,
    roomVisitCounts,
  });
}

const DIRECTION_COUNT = 4;
const OPPOSITE = new Int32Array([1, 0, 3, 2]);

export function computeBoxFlexibility(
  board: CompiledSearchBoard,
  cell: number,
  label: string,
): BoxFlexibility {
  const neighbors = board.neighbors[cell];
  let pushDirections = 0;
  let supportDirections = 0;

  for (let dir = 0; dir < DIRECTION_COUNT; dir++) {
    const target = neighbors[dir];
    const support = neighbors[OPPOSITE[dir]];
    if (target >= 0 && support >= 0) {
      pushDirections++;
    }
    if (support >= 0) {
      supportDirections++;
    }
  }

  const onGoal = board.goalLabelByCell[cell] === label;

  let goalDistance = -1;
  const goalCells = board.goalCellsByLabel.get(label);
  if (goalCells !== undefined) {
    for (const goalCell of goalCells) {
      const distances = board.reversePushDistancesByGoal.get(goalCell);
      if (distances === undefined) continue;
      const d = distances[cell];
      if (d >= 0 && (goalDistance < 0 || d < goalDistance)) {
        goalDistance = d;
      }
    }
  }

  return Object.freeze({
    cell,
    pushDirections,
    supportDirections,
    onGoal,
    goalDistance,
  });
}

export function computeFlexibilityMap(
  board: CompiledSearchBoard,
  boxes: readonly DenseBox[],
): readonly BoxFlexibility[] {
  const result = boxes.map((box) =>
    computeBoxFlexibility(board, box.cell, box.label),
  );
  return Object.freeze(result);
}
