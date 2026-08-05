import { useCallback } from "react";
import { isShareableActionLog } from "@/src/core";
import { createShareUrl } from "@/src/router/navigation";

interface ShareableSession {
  readonly actionLog: string;
  readonly puzzle: {
    readonly id: string;
    readonly title: string;
  };
}

interface UseSharingResult {
  readonly share: () => Promise<void>;
}

export function useSharing(
  session: ShareableSession,
  onToast: (message: string) => void,
): UseSharingResult {
  const share = useCallback(async () => {
    const includeRoute = isShareableActionLog(session.actionLog);
    const url = createShareUrl(
      window.location,
      session.puzzle.id,
      includeRoute && session.actionLog ? session.actionLog : undefined,
    );
    const shareData = {
      title: `${session.puzzle.title} · Sokomind`,
      text: `Try ${session.puzzle.title} in Sokomind.`,
      url,
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
        onToast("Puzzle shared.");
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        onToast(
          includeRoute
            ? "Puzzle and current route copied."
            : "Puzzle link copied; this route is too long to include.",
        );
      } else {
        onToast("Copy the puzzle link from your browser's address bar.");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      onToast("Could not share automatically. Copy the address from your browser.");
    }
  }, [session.actionLog, session.puzzle.id, session.puzzle.title, onToast]);

  return { share };
}
