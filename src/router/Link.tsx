import { useCallback, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { useRouter } from "./use-router";

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  readonly href: string;
  readonly replace?: boolean;
}

export function Link({ href, replace, onClick, children, ...rest }: LinkProps) {
  const { navigate } = useRouter();

  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        event.shiftKey
      ) {
        onClick?.(event);
        return;
      }
      event.preventDefault();
      onClick?.(event);
      navigate(href, { replace });
    },
    [href, navigate, onClick, replace],
  );

  return (
    <a href={href} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
