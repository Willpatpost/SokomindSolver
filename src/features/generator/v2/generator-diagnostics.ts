import type { Difficulty } from "../../../core/model.ts";
import type { TopologyFamily } from "./blueprint-types.ts";
import type { ForgeGenerationMode } from "./forge-sampling.ts";
import type { RestartStats } from "./reverse-beam-search.ts";

// ---------------------------------------------------------------------------
// Per-stage funnel counters (Section 5, 0.2)
// ---------------------------------------------------------------------------

export interface GeneratorDiagnostics {
  readonly attempted: number;
  readonly blueprintSucceeded: number;
  readonly mechanismPlanSucceeded: number;
  readonly goalPlacementSucceeded: number;
  readonly reverseSearchSucceeded: number;
  readonly puzzleValidationSucceeded: number;
  readonly initialSolveSucceeded: number;
  readonly gatePassed: number;
  readonly finalistPassed: number;
  readonly qualityPassed: number;
  readonly difficultyPassed: number;
  readonly curated: number;
}

// ---------------------------------------------------------------------------
// Requested-vs-actual box count (Section 5, 0.3)
// ---------------------------------------------------------------------------

export interface BoxScaleDiagnostics {
  readonly requestedBoxes: number;
  readonly actualBoxes: number;
  readonly goalCount: number;
  readonly genericBoxes: number;
  readonly typedBoxes: number;
  readonly difference: number;
}

// ---------------------------------------------------------------------------
// Per-restart telemetry (Section 5, 0.4)
// ---------------------------------------------------------------------------

export interface RestartDiagnostics {
  readonly restartIndex: number;
  readonly expanded: number;
  readonly maxDepth: number;
  readonly archiveOffers: number;
  readonly archiveAccepts: number;
  readonly transpositionHits: number;
  readonly firstLayerGenerated: number;
  readonly firstLayerRejected: number;
}

// ---------------------------------------------------------------------------
// Rejection taxonomy breakdown
// ---------------------------------------------------------------------------

export interface RejectionBreakdown {
  readonly byTier: Readonly<Record<string, number>>;
  readonly byFamily: Readonly<Record<string, number>>;
  readonly byMode: Readonly<Record<string, number>>;
  readonly byRequestedBoxCount: Readonly<Record<number, number>>;
  readonly byActualBoxCount: Readonly<Record<number, number>>;
  readonly byMechanismType: Readonly<Record<string, number>>;
  readonly byReason: Readonly<Record<string, number>>;
}

// ---------------------------------------------------------------------------
// Full diagnostic report for a forge run
// ---------------------------------------------------------------------------

export interface ForgeDiagnosticReport {
  readonly funnel: GeneratorDiagnostics;
  readonly boxScaleIssues: readonly BoxScaleDiagnostics[];
  readonly rejectionBreakdown: RejectionBreakdown;
  readonly restartDiagnostics: readonly RestartDiagnostics[];
  readonly boxScaleMismatchCount: number;
}

// ---------------------------------------------------------------------------
// Mutable collector — accumulates diagnostics during a forge run
// ---------------------------------------------------------------------------

interface RejectionRecord {
  readonly reason: string;
  readonly tier: Difficulty;
  readonly family: TopologyFamily;
  readonly mode: ForgeGenerationMode;
  readonly requestedBoxCount: number;
  readonly actualBoxCount?: number;
  readonly mechanismType?: string;
}

export class DiagnosticCollector {
  private _attempted = 0;
  private _blueprintSucceeded = 0;
  private _mechanismPlanSucceeded = 0;
  private _goalPlacementSucceeded = 0;
  private _reverseSearchSucceeded = 0;
  private _puzzleValidationSucceeded = 0;
  private _initialSolveSucceeded = 0;
  private _gatePassed = 0;
  private _finalistPassed = 0;
  private _qualityPassed = 0;
  private _difficultyPassed = 0;
  private _curated = 0;

  private readonly _rejections: RejectionRecord[] = [];
  private readonly _boxScale: BoxScaleDiagnostics[] = [];
  private readonly _restarts: RestartDiagnostics[] = [];

  recordAttempt(): void {
    this._attempted++;
  }

  recordBlueprintSuccess(): void {
    this._blueprintSucceeded++;
  }

  recordMechanismPlanSuccess(): void {
    this._mechanismPlanSucceeded++;
  }

  recordGoalPlacementSuccess(): void {
    this._goalPlacementSucceeded++;
  }

  recordReverseSearchSuccess(): void {
    this._reverseSearchSucceeded++;
  }

  recordPuzzleValidationSuccess(): void {
    this._puzzleValidationSucceeded++;
  }

  recordInitialSolveSuccess(): void {
    this._initialSolveSucceeded++;
  }

  recordGatePassed(): void {
    this._gatePassed++;
  }

  recordFinalistPassed(): void {
    this._finalistPassed++;
  }

  recordQualityPassed(): void {
    this._qualityPassed++;
  }

  recordDifficultyPassed(): void {
    this._difficultyPassed++;
  }

  recordCurated(): void {
    this._curated++;
  }

  recordRejection(record: RejectionRecord): void {
    this._rejections.push(record);
  }

  recordBoxScale(diag: BoxScaleDiagnostics): void {
    this._boxScale.push(diag);
  }

  recordRestartDiagnostics(diag: RestartDiagnostics): void {
    this._restarts.push(diag);
  }

  addRestartStatsFromV4(
    perRestartStats: readonly RestartStats[],
  ): void {
    for (const rs of perRestartStats) {
      this._restarts.push({
        restartIndex: rs.restartIndex,
        expanded: rs.expanded,
        maxDepth: rs.maxDepth,
        archiveOffers: rs.archiveOffers ?? 0,
        archiveAccepts: rs.archiveContributions ?? 0,
        transpositionHits: rs.transpositionHits ?? 0,
        firstLayerGenerated: rs.firstLayerGenerated ?? 0,
        firstLayerRejected: rs.firstLayerRejected ?? 0,
      });
    }
  }

  build(): ForgeDiagnosticReport {
    const byTier: Record<string, number> = {};
    const byFamily: Record<string, number> = {};
    const byMode: Record<string, number> = {};
    const byRequestedBoxCount: Record<number, number> = {};
    const byActualBoxCount: Record<number, number> = {};
    const byMechanismType: Record<string, number> = {};
    const byReason: Record<string, number> = {};

    for (const r of this._rejections) {
      byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
      byFamily[r.family] = (byFamily[r.family] ?? 0) + 1;
      byMode[r.mode] = (byMode[r.mode] ?? 0) + 1;
      byRequestedBoxCount[r.requestedBoxCount] =
        (byRequestedBoxCount[r.requestedBoxCount] ?? 0) + 1;
      if (r.actualBoxCount !== undefined) {
        byActualBoxCount[r.actualBoxCount] =
          (byActualBoxCount[r.actualBoxCount] ?? 0) + 1;
      }
      if (r.mechanismType) {
        byMechanismType[r.mechanismType] =
          (byMechanismType[r.mechanismType] ?? 0) + 1;
      }
      byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
    }

    let boxScaleMismatchCount = 0;
    for (const bs of this._boxScale) {
      if (bs.difference !== 0) boxScaleMismatchCount++;
    }

    return {
      funnel: {
        attempted: this._attempted,
        blueprintSucceeded: this._blueprintSucceeded,
        mechanismPlanSucceeded: this._mechanismPlanSucceeded,
        goalPlacementSucceeded: this._goalPlacementSucceeded,
        reverseSearchSucceeded: this._reverseSearchSucceeded,
        puzzleValidationSucceeded: this._puzzleValidationSucceeded,
        initialSolveSucceeded: this._initialSolveSucceeded,
        gatePassed: this._gatePassed,
        finalistPassed: this._finalistPassed,
        qualityPassed: this._qualityPassed,
        difficultyPassed: this._difficultyPassed,
        curated: this._curated,
      },
      boxScaleIssues: this._boxScale,
      rejectionBreakdown: {
        byTier,
        byFamily,
        byMode,
        byRequestedBoxCount,
        byActualBoxCount,
        byMechanismType,
        byReason,
      },
      restartDiagnostics: [...this._restarts],
      boxScaleMismatchCount,
    };
  }
}

// ---------------------------------------------------------------------------
// Human-readable diagnostic report
// ---------------------------------------------------------------------------

export function formatDiagnosticReport(report: ForgeDiagnosticReport): string {
  const lines: string[] = [];
  const f = report.funnel;

  lines.push("╔══════════════════════════════════════════════════╗");
  lines.push("║         Generator Diagnostic Report             ║");
  lines.push("╚══════════════════════════════════════════════════╝");
  lines.push("");

  lines.push("Pipeline funnel:");
  lines.push(`  attempted                  ${f.attempted}`);
  lines.push(`  blueprintSucceeded         ${f.blueprintSucceeded}`);
  lines.push(`  mechanismPlanSucceeded     ${f.mechanismPlanSucceeded}`);
  lines.push(`  goalPlacementSucceeded     ${f.goalPlacementSucceeded}`);
  lines.push(`  reverseSearchSucceeded     ${f.reverseSearchSucceeded}`);
  lines.push(`  puzzleValidationSucceeded  ${f.puzzleValidationSucceeded}`);
  lines.push(`  initialSolveSucceeded      ${f.initialSolveSucceeded}`);
  lines.push(`  gatePassed                 ${f.gatePassed}`);
  lines.push(`  finalistPassed             ${f.finalistPassed}`);
  lines.push(`  qualityPassed              ${f.qualityPassed}`);
  lines.push(`  difficultyPassed           ${f.difficultyPassed}`);
  lines.push(`  curated                    ${f.curated}`);
  lines.push("");

  lines.push(`Box scale mismatches: ${report.boxScaleMismatchCount} / ${report.boxScaleIssues.length}`);
  if (report.boxScaleMismatchCount > 0) {
    lines.push("  Mismatched entries:");
    for (const bs of report.boxScaleIssues) {
      if (bs.difference !== 0) {
        lines.push(
          `    requested=${bs.requestedBoxes} actual=${bs.actualBoxes} ` +
          `goals=${bs.goalCount} generic=${bs.genericBoxes} typed=${bs.typedBoxes} ` +
          `diff=${bs.difference > 0 ? "+" : ""}${bs.difference}`,
        );
      }
    }
  }
  lines.push("");

  const rb = report.rejectionBreakdown;

  lines.push("Rejections by reason:");
  for (const [reason, count] of Object.entries(rb.byReason).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${reason.padEnd(32)} ${count}`);
  }
  lines.push("");

  lines.push("Rejections by tier:");
  for (const [tier, count] of Object.entries(rb.byTier).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${tier.padEnd(20)} ${count}`);
  }
  lines.push("");

  lines.push("Rejections by family:");
  for (const [family, count] of Object.entries(rb.byFamily).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${family.padEnd(20)} ${count}`);
  }
  lines.push("");

  lines.push("Rejections by mode:");
  for (const [mode, count] of Object.entries(rb.byMode).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${mode.padEnd(20)} ${count}`);
  }
  lines.push("");

  lines.push("Rejections by requested box count:");
  for (const [bc, count] of Object.entries(rb.byRequestedBoxCount).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    lines.push(`  boxes=${bc.padEnd(5)} ${count}`);
  }
  lines.push("");

  if (report.restartDiagnostics.length > 0) {
    lines.push("Reverse-search restart diagnostics:");
    lines.push(
      `  ${"idx".padStart(4)} ${"expanded".padStart(10)} ${"maxDepth".padStart(10)} ` +
      `${"archOffer".padStart(10)} ${"archAccept".padStart(11)} ` +
      `${"transHits".padStart(10)} ${"1stGen".padStart(8)} ${"1stRej".padStart(8)}`,
    );
    for (const rd of report.restartDiagnostics) {
      lines.push(
        `  ${String(rd.restartIndex).padStart(4)} ` +
        `${String(rd.expanded).padStart(10)} ` +
        `${String(rd.maxDepth).padStart(10)} ` +
        `${String(rd.archiveOffers).padStart(10)} ` +
        `${String(rd.archiveAccepts).padStart(11)} ` +
        `${String(rd.transpositionHits).padStart(10)} ` +
        `${String(rd.firstLayerGenerated).padStart(8)} ` +
        `${String(rd.firstLayerRejected).padStart(8)}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
