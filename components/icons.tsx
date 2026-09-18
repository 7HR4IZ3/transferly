type IconProps = {
  size?: number;
  strokeWidth?: number;
};

function Icon({
  children,
  size = 20,
  strokeWidth = 1.8,
  viewBox = "0 0 24 24",
}: IconProps & { children: React.ReactNode; viewBox?: string }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox={viewBox}
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={strokeWidth}>
        {children}
      </g>
    </svg>
  );
}

export function ArrowRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h13" />
      <path d="m13 6 6 6-6 6" />
    </Icon>
  );
}

export function ArrowLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19 12H6" />
      <path d="m11 18-6-6 6-6" />
    </Icon>
  );
}

export function ArrowUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </Icon>
  );
}

export function ArrowDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14" />
      <path d="m6 13 6 6 6-6" />
    </Icon>
  );
}

export function Camera(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 8.5h3l1.5-2h7l1.5 2h3v9.25A1.25 1.25 0 0 1 18.75 19h-13.5A1.25 1.25 0 0 1 4 17.75z" />
      <circle cx="12" cy="13.5" r="3.25" />
    </Icon>
  );
}

export function Check(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 12.5 4.25 4L19 7" />
    </Icon>
  );
}

export function Copy(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="12" rx="2" width="12" x="8" y="8" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </Icon>
  );
}

export function Download(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4v11" />
      <path d="m7 11 5 5 5-5" />
      <path d="M5 20h14" />
    </Icon>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 3.5h7l4 4v13h-11z" />
      <path d="M13.5 3.5v4h4" />
      <path d="M9 12h5.5M9 15h5.5" />
    </Icon>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M7.25 17.75H6a4 4 0 0 1 0-8h3" />
      <path d="M16.75 6.25H18a4 4 0 0 1 0 8h-3" />
    </Icon>
  );
}

export function Lock(props: IconProps) {
  return (
    <Icon {...props}>
      <rect height="10" rx="2" width="14" x="5" y="10" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <path d="M12 14v2" />
    </Icon>
  );
}

export function Plus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function Shield(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3.5 19 6v5.5c0 4.5-2.9 7.7-7 9-4.1-1.3-7-4.5-7-9V6z" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  );
}

export function Wifi(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 8.5a13.4 13.4 0 0 1 17 0" />
      <path d="M6.5 12a8.6 8.6 0 0 1 11 0" />
      <path d="M9.5 15.5a4 4 0 0 1 5 0" />
      <circle cx="12" cy="19" fill="currentColor" r="1" stroke="none" />
    </Icon>
  );
}

export function XIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Icon>
  );
}
