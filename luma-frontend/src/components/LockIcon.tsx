import { memo } from "react";

type LockIconProps = {
  size?: number;
  className?: string;
};

const LockIcon = memo(function LockIcon({
  size = 16,
  className,
}: LockIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M7 10V8.5C7 5.73858 9.23858 3.5 12 3.5C14.7614 3.5 17 5.73858 17 8.5V10"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="5"
        y="10"
        width="14"
        height="10"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M12 14V16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
});

export default LockIcon;
