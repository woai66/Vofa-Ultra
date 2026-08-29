export const APP_VERSION = __APP_VERSION__;
export const APP_BUILD_ID = __APP_BUILD_ID__;
export const APP_DISPLAY_VERSION = `v${APP_VERSION}`;
export const APP_DISPLAY_BUILD_ID =
  APP_BUILD_ID === "development"
    ? APP_BUILD_ID
    : `${APP_BUILD_ID.slice(0, 7)}${APP_BUILD_ID.endsWith("-dirty") ? "-dirty" : ""}`;
