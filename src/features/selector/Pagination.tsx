import { Link } from "@/src/router";
import styles from "./PuzzleSelectorPage.module.css";

export interface PaginationProps {
  readonly ariaLabel: string;
  readonly currentPage: number;
  readonly pageCount: number;
  readonly pageHash: (page: number) => string;
}

export function Pagination({
  ariaLabel,
  currentPage,
  pageCount,
  pageHash,
}: PaginationProps) {
  if (pageCount <= 1) return null;

  return (
    <nav aria-label={ariaLabel} className={styles.pagination}>
      {currentPage === 1 ? (
        <span aria-disabled="true" className={styles.pageLink}>
          Previous
        </span>
      ) : (
        <Link className={styles.pageLink} href={pageHash(currentPage - 1)}>
          Previous
        </Link>
      )}
      <span className={styles.pageNumbers}>
        {Array.from({ length: pageCount }, (_, index) => index + 1).map(
          (number) => (
            <Link
              aria-current={number === currentPage ? "page" : undefined}
              className={styles.pageLink}
              href={pageHash(number)}
              key={number}
            >
              {number}
            </Link>
          ),
        )}
      </span>
      {currentPage === pageCount ? (
        <span aria-disabled="true" className={styles.pageLink}>
          Next
        </span>
      ) : (
        <Link className={styles.pageLink} href={pageHash(currentPage + 1)}>
          Next
        </Link>
      )}
    </nav>
  );
}
