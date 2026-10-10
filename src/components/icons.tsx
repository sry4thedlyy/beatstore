import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement> & {
  name: "play" | "pause" | "search" | "arrow" | "close" | "music";
};

export function Icon({ name, ...props }: Props) {
  const paths = {
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
