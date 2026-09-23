import { expect, test, type Page } from "@playwright/test";

// Client coordinates of a cell centre, using the same padding-aware mapping
// as the board click handler.
async function cellCentre(page: Page, row: number, column: number) {
  return page.getByTestId("game-board").evaluate(
    (board, target) => {
      const rect = board.getBoundingClientRect();
      const style = getComputedStyle(board);
      const padLeft = parseFloat(style.paddingLeft) || 0;
      const padTop = parseFloat(style.paddingTop) || 0;
      const innerWidth = rect.width - padLeft - (parseFloat(style.paddingRight) || 0);
      const innerHeight = rect.height - padTop - (parseFloat(style.paddingBottom) || 0);
      return {
        x: rect.left + padLeft + ((target.column + 0.5) * innerWidth) / target.columns,
        y: rect.top + padTop + ((target.row + 0.5) * innerHeight) / target.rows,
      };
    },
    { row, column, columns: 9, rows: 6 },
  );
}

test("clicking a distant floor cell walks the whole route", async ({ page }) => {
  await page.goto("./#/play/beginner-typed-line");
  await expect(page.getByRole("heading", { name: "Color Line" })).toBeVisible();

  // Keeper starts at row 4, column 4; row 4, column 1 is three steps left.
  const { x, y } = await cellCentre(page, 4, 1);
  await page.mouse.click(x, y);

  await expect(page.getByTestId("moves-count")).toHaveText("3");
  await expect(page.getByTestId("game-board")).toHaveAttribute(
    "aria-label",
    /Keeper at row 5, column 2\..*3 moves and 0 pushes/,
  );
});
