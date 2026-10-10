import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement> & {
  name:
    | "play"
    | "pause"
    | "search"
    | "arrow"
    | "close"
    | "music"
    | "user"
    | "lock"
    | "eye"
    | "eye-off";
};

export function Icon({ name, ...props }: Props) {
  const paths = {
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    "eye-off": (
      <>
        <path d="m3 3 18 18M10 5c.7-.1 1.3-.2 2-.2 6 0 10 7.2 10 7.2a18 18 0 0 1-4 4M6 6a20 20 0 0 0-4 6s4 7 10 7c1.6 0 3-.5 4.5-1.3" />
      </>
    ),
    play: <path d="m8 5 11 7-11 7V5Z" fill="currentColor" stroke="none" />,
    pause: (
      <>
        <path d="M8 5v14M16 5v14" strokeWidth="4" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    music: (
      <>
        <path d="M9 18V5l12-2v13M9 9l12-2" />
        <ellipse cx="5.5" cy="18.5" rx="3.5" ry="2.5" />
        <ellipse cx="17.5" cy="16.5" rx="3.5" ry="2.5" />
      </>
    ),
  };
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
