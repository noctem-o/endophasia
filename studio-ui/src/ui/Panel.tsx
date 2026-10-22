import { Component, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import { Note } from "./text.tsx";

/**
 * A panel that fails says so in its own place and leaves the rest of the page working. What failed is not shown: an error can carry
 * text of a record. (The view models are built whole before a read is accepted, so this is the last line, not the first.) It is tried
 * again whenever what it draws changes (`resetKey`): a panel that failed once is not left saying so after a good read.
 */
export class PanelBoundary extends Component<
	{ children: ReactNode; resetKey?: unknown },
	{ failed: boolean; key: unknown }
> {
	override state = { failed: false, key: this.props.resetKey };
	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}
	static getDerivedStateFromProps(
		props: { resetKey?: unknown },
		state: { failed: boolean; key: unknown },
	): { failed: boolean; key: unknown } | null {
		return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
	}
	override componentDidCatch(_error: Error, _info: ErrorInfo): void {
		// Nothing is logged: the page sends nothing anywhere and prints no record text.
	}
	override render(): ReactNode {
		return this.state.failed ? <Note tone="error">This panel could not be displayed.</Note> : this.props.children;
	}
}

export function Panel({
	id,
	title,
	subtitle,
	tools,
	className,
	resetKey,
	children,
}: {
	id: string;
	title: string;
	subtitle?: string;
	tools?: ReactNode;
	className?: string;
	/** Passed to the panel's boundary: when it changes, a panel that failed is drawn again. */
	resetKey?: unknown;
	children: ReactNode;
}): ReactElement {
	return (
		<section
			className={className === undefined ? "panel" : `panel ${className}`}
			id={id}
			aria-labelledby={`${id}-title`}
		>
			<header className="panel-head">
				<div className="panel-titles">
					<h2 id={`${id}-title`}>{title}</h2>
					{subtitle === undefined ? null : <p className="panel-sub">{subtitle}</p>}
				</div>
				<div className="panel-tools">{tools}</div>
			</header>
			<div className="panel-body">
				<PanelBoundary resetKey={resetKey}>{children}</PanelBoundary>
			</div>
		</section>
	);
}
