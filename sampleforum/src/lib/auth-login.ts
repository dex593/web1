export const AUTH_PROVIDER_DIALOG_EVENT = "bfang:open-auth-provider-dialog";

const buildCurrentNextPath = (): string => {
  const path = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const normalized = (path || "").trim();
  return normalized || "/forum";
};

export const openAuthProviderDialog = (nextPath?: string): void => {
  if (typeof window === "undefined") return;

  const candidate = typeof nextPath === "string" ? nextPath.trim() : "";
  const next = candidate || buildCurrentNextPath();

  window.dispatchEvent(
    new CustomEvent(AUTH_PROVIDER_DIALOG_EVENT, {
      detail: {
        next,
      },
    })
  );
};
