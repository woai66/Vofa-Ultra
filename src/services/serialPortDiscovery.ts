export function subscribeToSerialPortDiscoveryRefresh(refresh: () => void): () => void {
  let refreshQueued = false;

  const queueRefresh = () => {
    if (refreshQueued) {
      return;
    }
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      refresh();
    });
  };
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      queueRefresh();
    }
  };

  window.addEventListener("focus", queueRefresh);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    window.removeEventListener("focus", queueRefresh);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}
