export function getHorizontalTabTarget<T>(
  tabs: readonly T[],
  current: T,
  key: string,
): T | undefined {
  const currentIndex = tabs.indexOf(current);
  if (currentIndex < 0 || tabs.length === 0) {
    return undefined;
  }

  switch (key) {
    case "ArrowLeft":
      return tabs[(currentIndex - 1 + tabs.length) % tabs.length];
    case "ArrowRight":
      return tabs[(currentIndex + 1) % tabs.length];
    case "Home":
      return tabs[0];
    case "End":
      return tabs[tabs.length - 1];
    default:
      return undefined;
  }
}

export function getVerticalNavigationTarget<T>(
  items: readonly T[],
  current: T,
  key: string,
): T | undefined {
  const currentIndex = items.indexOf(current);
  if (currentIndex < 0 || items.length === 0) {
    return undefined;
  }

  switch (key) {
    case "ArrowUp":
      return items[(currentIndex - 1 + items.length) % items.length];
    case "ArrowDown":
      return items[(currentIndex + 1) % items.length];
    case "Home":
      return items[0];
    case "End":
      return items[items.length - 1];
    default:
      return undefined;
  }
}
