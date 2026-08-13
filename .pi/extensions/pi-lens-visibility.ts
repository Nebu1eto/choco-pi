import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const LENS_STATUS_KEY = "pi-lens-lsp";
const LENS_WIDGET_KEY = "pi-lens";
const INSTALLATION = Symbol.for("choco-pi.pi-lens-visibility");

type Ui = ExtensionContext["ui"];
type SetWidget = Ui["setWidget"];
type WidgetArguments = [key: string, content: unknown, options?: unknown];

type Installation = {
	reset(): void;
};

type PatchedUi = Ui & {
	[INSTALLATION]?: Installation;
};

function isLspActive(status: string | undefined): boolean {
	return status !== undefined && /\bLSP Active(?=\s|:|\()/.test(stripTerminalSequences(status));
}

function isLspInactive(status: string | undefined): boolean {
	return status !== undefined && /\bLSP Inactive\b/.test(stripTerminalSequences(status));
}

export function installPiLensVisibility(ui: Ui): Installation {
	const patchedUi = ui as PatchedUi;
	const installed = patchedUi[INSTALLATION];
	if (installed) {
		installed.reset();
		return installed;
	}

	const originalSetStatus = ui.setStatus.bind(ui);
	const originalSetWidget = ui.setWidget.bind(ui) as unknown as (...args: WidgetArguments) => void;
	let active = false;
	let lensWidget: WidgetArguments | undefined;

	const setLensWidgetVisibility = (): void => {
		if (active && lensWidget) {
			originalSetWidget(...lensWidget);
		} else {
			originalSetWidget(LENS_WIDGET_KEY, undefined);
		}
	};

	ui.setStatus = (key, status) => {
		if (key !== LENS_STATUS_KEY) {
			originalSetStatus(key, status);
			return;
		}

		active = isLspActive(status);
		originalSetStatus(key, isLspInactive(status) ? undefined : status);
		setLensWidgetVisibility();
	};

	ui.setWidget = ((key: string, content: unknown, options?: unknown) => {
		if (key !== LENS_WIDGET_KEY) {
			originalSetWidget(key, content, options);
			return;
		}

		lensWidget = content === undefined ? undefined : [key, content, options];
		setLensWidgetVisibility();
	}) as SetWidget;

	const installation: Installation = {
		reset: () => {
			active = false;
			lensWidget = undefined;
			originalSetStatus(LENS_STATUS_KEY, undefined);
			originalSetWidget(LENS_WIDGET_KEY, undefined);
		},
	};
	Object.defineProperty(patchedUi, INSTALLATION, { value: installation });
	return installation;
}

export default function piLensVisibility(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") installPiLensVisibility(ctx.ui);
	});
}
