export function subscribeToSerialPortDiscoveryRefresh(refresh: () => void): () => void {
  let refreshQueued = false;
  let disposed = false;

  const queueRefresh = () => {
    if (refreshQueued || disposed) {
      return;
    }
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      if (!disposed) {
        refresh();
      }
    });
  };
  const handleFocus = () => {
    if (document.visibilityState === "visible") {
      queueRefresh();
    }
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      queueRefresh();
    }
  };

  window.addEventListener("focus", handleFocus);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    disposed = true;
    window.removeEventListener("focus", handleFocus);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
