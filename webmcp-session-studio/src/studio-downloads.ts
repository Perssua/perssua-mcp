export const STUDIO_MIN_DESKTOP_VERSION = "0.27.0";

export const STUDIO_COMPATIBLE_DOWNLOADS = [
  {
    platform: "windows",
    label: "Windows",
    href: "https://downloads.perssua.com/Perssua-0.27.0.exe",
  },
  {
    platform: "mac-arm64",
    label: "Mac · Apple silicon",
    href: "https://downloads.perssua.com/Perssua-0.27.0-arm64.dmg",
  },
  {
    platform: "mac-intel",
    label: "Mac · Intel",
    href: "https://downloads.perssua.com/Perssua-0.27.0.dmg",
  },
  {
    platform: "linux-appimage-x86_64",
    label: "Linux · x64",
    href: "https://downloads.perssua.com/Perssua-0.27.0-x86_64.AppImage",
  },
  {
    platform: "linux-appimage-arm64",
    label: "Linux · ARM",
    href: "https://downloads.perssua.com/Perssua-0.27.0-arm64.AppImage",
  },
] as const;

export type StudioCompatibleDownload =
  (typeof STUDIO_COMPATIBLE_DOWNLOADS)[number];
