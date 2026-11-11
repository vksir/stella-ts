/** 共享图标（几何与线宽对齐 dsh：16/14px 槽位、1.5–1.8 线宽、round cap）。 */
import type { ReactNode, SVGProps } from "react";

function Svg({ width = 16, height = 16, children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }): ReactNode {
	return (
		<svg
			viewBox="0 0 24 24"
			width={width}
			height={height}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.6"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			{...rest}
		>
			{children}
		</svg>
	);
}

export const StarIcon = ({ width = 18, height = 18 }: { width?: number; height?: number }): ReactNode => (
	<svg viewBox="0 0 24 24" width={width} height={height} fill="currentColor" aria-hidden="true">
		<path d="M12 2.6l2.5 6.6 6.9 2.8-6.9 2.8L12 21.4l-2.5-6.6-6.9-2.8 6.9-2.8z" />
	</svg>
);

export const PanelCollapseIcon = (): ReactNode => (
	<Svg strokeWidth="1.5">
		<rect x="3" y="4" width="18" height="16" rx="3" />
		<path d="M9.5 4v16M15.5 10l-2 2 2 2" />
	</Svg>
);

export const PanelExpandIcon = (): ReactNode => (
	<Svg strokeWidth="1.5">
		<rect x="3" y="4" width="18" height="16" rx="3" />
		<path d="M9.5 4v16M14.5 10l2 2-2 2" />
	</Svg>
);

export const PlusIcon = (): ReactNode => (
	<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
		<path d="M8 3v10M3 8h10" />
	</svg>
);

export const MenuIcon = (): ReactNode => (
	<Svg width={18} height={18} strokeWidth="1.8">
		<path d="M4 6h16M4 12h16M4 18h16" />
	</Svg>
);

export const SunIcon = (): ReactNode => (
	<Svg strokeWidth="1.8">
		<circle cx="12" cy="12" r="4" />
		<path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
	</Svg>
);

export const MoonIcon = (): ReactNode => (
	<Svg strokeWidth="1.8">
		<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
	</Svg>
);

export const SystemIcon = (): ReactNode => (
	<Svg strokeWidth="1.8">
		<rect x="2" y="4" width="20" height="13" rx="2" />
		<path d="M8 21h8m-4-4v4" />
	</Svg>
);

export const FolderIcon = (): ReactNode => (
	<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 6v5A1.5 1.5 0 0 1 13 12.5H3A1.5 1.5 0 0 1 1.5 11z" />
	</svg>
);

export const ChevronDownIcon = ({ width = 12, height = 12 }: { width?: number; height?: number }): ReactNode => (
	<svg viewBox="0 0 12 12" width={width} height={height} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d="M3 4.5L6 7.5L9 4.5" />
	</svg>
);

export const SendIcon = (): ReactNode => (
	<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d="M10 16V4M4.5 9.5 10 4l5.5 5.5" />
	</svg>
);

export const StopIcon = (): ReactNode => (
	<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
		<rect x="3" y="3" width="10" height="10" rx="2.5" fill="currentColor" />
	</svg>
);

export const TrashIcon = ({ width = 14, height = 14 }: { width?: number; height?: number }): ReactNode => (
	<Svg width={width} height={height}>
		<path d="M4 7h16M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13" />
	</Svg>
);

export const CopyIcon = (): ReactNode => (
	<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<rect x="7" y="7" width="9" height="9" rx="2" />
		<path d="M13 4.5A1.5 1.5 0 0 0 11.5 3h-6A2.5 2.5 0 0 0 3 5.5v6A1.5 1.5 0 0 0 4.5 13" />
	</svg>
);

export const CheckIcon = (): ReactNode => (
	<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d="M4 10.5l4 4 8-8.5" />
	</svg>
);

export const StarOutlineIcon = ({ width = 14, height = 14 }: { width?: number; height?: number }): ReactNode => (
	<Svg width={width} height={height}>
		<path d="M12 3.6l2.5 5.1 5.6 0.8-4 4 0.9 5.6-5-2.6-5 2.6 0.9-5.6-4-4 5.6-0.8z" />
	</Svg>
);

export const StarFilledIcon = ({ width = 14, height = 14 }: { width?: number; height?: number }): ReactNode => (
	<svg viewBox="0 0 24 24" width={width} height={height} fill="currentColor" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
		<path d="M12 3.6l2.5 5.1 5.6 0.8-4 4 0.9 5.6-5-2.6-5 2.6 0.9-5.6-4-4 5.6-0.8z" />
	</svg>
);

export const SpinnerIcon = ({ width = 14, height = 14 }: { width?: number; height?: number }): ReactNode => (
	<svg viewBox="0 0 24 24" width={width} height={height} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
		<path d="M12 3a9 9 0 1 0 9 9" />
	</svg>
);

export const CheckCircleIcon = ({ width = 14, height = 14 }: { width?: number; height?: number }): ReactNode => (
	<Svg width={width} height={height} strokeWidth="1.8">
		<circle cx="12" cy="12" r="9" />
		<path d="M8.5 12.5l2.5 2.5 4.5-5" />
	</Svg>
);

export const XCircleIcon = ({ width = 14, height = 14 }: { width?: number; height?: number }): ReactNode => (
	<Svg width={width} height={height} strokeWidth="1.8">
		<circle cx="12" cy="12" r="9" />
		<path d="M9 9l6 6M15 9l-6 6" />
	</Svg>
);

export const PendingIcon = ({ width = 14, height = 14 }: { width?: number; height?: number }): ReactNode => (
	<Svg width={width} height={height} strokeWidth="1.8">
		<circle cx="12" cy="12" r="9" />
		<path d="M12 7v5l3 2" />
	</Svg>
);

export const MinusCircleIcon = ({ width = 14, height = 14 }: { width?: number; height?: number }): ReactNode => (
	<Svg width={width} height={height} strokeWidth="1.8">
		<circle cx="12" cy="12" r="9" />
		<path d="M8.5 12h7" />
	</Svg>
);

export const ChevronRightIcon = ({ width = 14, height = 14 }: { width?: number; height?: number }): ReactNode => (
	<svg viewBox="0 0 24 24" width={width} height={height} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d="M9 6l6 6-6 6" />
	</svg>
);

export const QuoteIcon = ({ width = 15, height = 15 }: { width?: number; height?: number }): ReactNode => (
	<Svg width={width} height={height}>
		<path d="M9 6H5.5A2.5 2.5 0 0 0 3 8.5v0A2.5 2.5 0 0 0 5.5 11H7v1a3 3 0 0 1-3 3" />
		<path d="M20 6h-3.5A2.5 2.5 0 0 0 14 8.5v0A2.5 2.5 0 0 0 16.5 11H18v1a3 3 0 0 1-3 3" />
	</Svg>
);

export const SearchIcon = ({ width = 15, height = 15 }: { width?: number; height?: number }): ReactNode => (
	<Svg width={width} height={height}>
		<circle cx="10.5" cy="10.5" r="6.5" />
		<path d="M15.5 15.5L21 21" />
	</Svg>
);
