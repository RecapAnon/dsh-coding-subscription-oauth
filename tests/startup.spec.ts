import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CODING_OAUTH_STATUS_PATH } from "../src/auth-routes.ts";
import { CAPABILITY_SETTINGS_PATH } from "../src/capability-routes.ts";
import type {
	CapabilitySettingsPatch,
	CapabilitySettingsPathOp,
	CapabilitySettingsScope,
	CapabilitySettingsService,
} from "../src/capability-settings.ts";
import { GrokImagineClient } from "../src/grok-imagine.ts";
import { apply } from "../src/index.ts";
import { MediaStore } from "../src/media-store.ts";
import { OAuthProviderSession } from "../src/oauth-session.ts";
import { GrokBuildSession } from "../src/session.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

function runFiber(callback?: () => unknown) {
	let startupError: unknown;
	let cleanup: (() => void | Promise<void>) | undefined;
	const startup = Promise.resolve()
		.then(async () => {
			const result = await callback?.();
			if (typeof result === "function") cleanup = result as () => void | Promise<void>;
		})
		.catch((error) => {
			startupError = error;
		});
	return {
		async await() {
			await startup;
			if (startupError !== undefined) throw startupError;
		},
		async dispose() {
			await startup;
			await cleanup?.();
		},
	};
}

function requiredWebContext(): Context {
	return {
		webServer: { register: vi.fn(() => vi.fn()) },
		get: vi.fn(() => undefined),
		effect: vi.fn((setup: () => unknown) => setup()),
	} as unknown as Context;
}

function liveSettings(initial: CapabilitySettingsPatch): {
	service: CapabilitySettingsService;
	set(next: CapabilitySettingsPatch): void;
	watcherCount(): number;
} {
	let value: CapabilitySettingsPatch = initial;
	const watchers = new Set<(next: unknown, prev: unknown) => void | Promise<void>>();
	const scope: CapabilitySettingsScope = {
		get: () => value,
		watch: (callback) => {
			watchers.add(callback);
			return () => {
				watchers.delete(callback);
			};
		},
		update: async () => undefined,
		replace: async () => undefined,
	};
	return {
		service: {
			writable: true,
			register: () => scope,
		},
		set(next) {
			const previous = value;
			value = next;
			for (const watcher of [...watchers]) void watcher(next, previous);
		},
		watcherCount: () => watchers.size,
	};
}

describe("plugin startup catalog initialization", () => {
	it("keeps owner Web routes alive across optional LLM activation, unload, and reload", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockResolvedValue(undefined);
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockResolvedValue(undefined);
		vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
		const routeDisposers: Array<() => void | Promise<void>> = [];
		const llmDisposers: Array<() => void | Promise<void>> = [];
		const registeredPaths = new Set<string>();
		const register = vi.fn((route: { path: string }) => {
			if (registeredPaths.has(route.path)) throw new Error(`duplicate route ${route.path}`);
			registeredPaths.add(route.path);
			return () => {
				registeredPaths.delete(route.path);
			};
		});
		const registration = Object.assign(vi.fn(), { replace: vi.fn() });
		const registerAdapter = vi.fn(() => registration);
		let activateLlm: ((ctx: Context) => unknown) | undefined;
		const webCtx = {
			webServer: { register },
			effect: vi.fn((setup: () => (() => void | Promise<void>) | undefined) => {
				const dispose = setup();
				if (dispose !== undefined) routeDisposers.push(dispose);
			}),
		} as unknown as Context;
		const llmCtx = {
			llm: { registerAdapter, resolveModelInfo: vi.fn() },
			get: vi.fn(() => undefined),
			logger: () => ({ warn: vi.fn() }),
			effect: vi.fn((setup: () => (() => void | Promise<void>) | undefined) => {
				const dispose = setup();
				if (dispose !== undefined) llmDisposers.push(dispose);
			}),
			inject: vi.fn(),
		} as unknown as Context;
		const ownerCtx = {
			webServer: webCtx.webServer,
			logger: () => ({ warn: vi.fn() }),
			emit: vi.fn(),
			effect: vi.fn((setup: () => (() => void | Promise<void>) | undefined) => setup()),
			get: vi.fn(() => undefined),
			inject: vi.fn((services: readonly string[], callback: (ctx: Context) => unknown) => {
				if (services.length === 1 && services[0] === "llm") {
					activateLlm = callback;
					return runFiber();
				}
				if (services.length === 1 && services[0] === "webServer") return runFiber(() => callback(webCtx));
				return runFiber();
			}),
		} as unknown as Context;
		const context = {
			...ownerCtx,
			inject: vi.fn((services: readonly string[], callback: (ctx: Context) => unknown) => {
				return services.length === 0 ? runFiber(() => callback(ownerCtx)) : runFiber();
			}),
		} as unknown as Context;

		apply(context, {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(registeredPaths).toContain(CODING_OAUTH_STATUS_PATH);
		expect(registeredPaths).toContain(CAPABILITY_SETTINGS_PATH);
		expect(registerAdapter).not.toHaveBeenCalled();
		const webRouteCount = registeredPaths.size;

		activateLlm?.(llmCtx);
		expect(registerAdapter).toHaveBeenCalledOnce();
		expect(registeredPaths.size).toBe(webRouteCount);

		await Promise.all(llmDisposers.map((dispose) => dispose()));
		expect(registration).toHaveBeenCalledOnce();
		expect(registeredPaths.size).toBe(webRouteCount);

		llmDisposers.length = 0;
		activateLlm?.(llmCtx);
		expect(registerAdapter).toHaveBeenCalledTimes(2);
		expect(registeredPaths.size).toBe(webRouteCount);
		await Promise.all(routeDisposers.map((dispose) => dispose()));
	});

	it("applies composition capability defaults before an optional settings service exists", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockResolvedValue(undefined);
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockResolvedValue(undefined);
		vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
		const registration = Object.assign(vi.fn(), { replace: vi.fn() });
		const registerSearchProvider = vi.fn(() => vi.fn());
		const requiredWeb = requiredWebContext();
		const child = {
			get: vi.fn((name: string) => (name === "web" ? { registerSearchProvider } : undefined)),
			effect: vi.fn((setup: () => unknown) => setup()),
		};
		const context = {
			webServer: requiredWeb.webServer,
			logger: () => ({ warn: vi.fn() }),
			emit: vi.fn(),
			effect: vi.fn((setup: () => unknown) => setup()),
			llm: { registerAdapter: vi.fn(() => registration) },
			get: vi.fn(() => undefined),
			inject: vi.fn((services: readonly string[], callback: (ctx: unknown) => void) => {
				if (services.length === 0) return runFiber(() => callback(context));
				if (services.length === 1 && services[0] === "llm") return runFiber(() => callback(context));
				if (services.length === 1 && services[0] === "web") return runFiber(() => callback(child));
				if (services.length === 1 && services[0] === "webServer") return runFiber(() => callback(requiredWeb));
				return runFiber();
			}),
		} as unknown as Context;

		apply(context, { capabilities: { codexSearch: true, searchResults: 3 } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(registerSearchProvider).toHaveBeenCalledOnce();
	});

	it("registers both subscription search providers with independent capability flags", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockResolvedValue(undefined);
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockResolvedValue(undefined);
		vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
		const registration = Object.assign(vi.fn(), { replace: vi.fn() });
		const registered: string[] = [];
		const registerSearchProvider = vi.fn((provider: { readonly id: string }) => {
			registered.push(provider.id);
			return vi.fn();
		});
		const requiredWeb = requiredWebContext();
		const child = {
			get: vi.fn((name: string) => (name === "web" ? { registerSearchProvider } : undefined)),
			effect: vi.fn((setup: () => unknown) => setup()),
		};
		const context = {
			webServer: requiredWeb.webServer,
			logger: () => ({ warn: vi.fn() }),
			emit: vi.fn(),
			effect: vi.fn((setup: () => unknown) => setup()),
			llm: { registerAdapter: vi.fn(() => registration) },
			get: vi.fn(() => undefined),
			inject: vi.fn((services: readonly string[], callback: (ctx: unknown) => void) => {
				if (services.length === 0) return runFiber(() => callback(context));
				if (services.length === 1 && services[0] === "llm") return runFiber(() => callback(context));
				if (services.length === 1 && services[0] === "web") return runFiber(() => callback(child));
				if (services.length === 1 && services[0] === "webServer") return runFiber(() => callback(requiredWeb));
				return runFiber();
			}),
		} as unknown as Context;

		apply(context, { capabilities: { codexSearch: true, kimiSearch: true, searchResults: 3 } });
		await new Promise<void>((resolve) => setImmediate(resolve));

		// Two distinct provider ids, one per subscription, both published.
		expect(registerSearchProvider).toHaveBeenCalledTimes(2);
		expect([...registered].sort()).toEqual(["codex-oauth-search", "kimi-oauth-search"]);
	});

	it("releases an obsolete settings watcher before reinjection and restores composition defaults on dispose", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockResolvedValue(undefined);
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockResolvedValue(undefined);
		vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
		const registration = Object.assign(vi.fn(), { replace: vi.fn() });
		const searchReleases: ReturnType<typeof vi.fn>[] = [];
		const registerSearchProvider = vi.fn(() => {
			const release = vi.fn();
			searchReleases.push(release);
			return release;
		});
		const requiredWeb = requiredWebContext();
		let settingsInjection: ((ctx: Context) => void) | undefined;
		const webCtx = {
			get: vi.fn((service: string) => (service === "web" ? { registerSearchProvider } : undefined)),
			effect: vi.fn((setup: () => unknown) => setup()),
		} as unknown as Context;
		const context = {
			logger: () => ({ warn: vi.fn() }),
			emit: vi.fn(),
			effect: vi.fn(),
			llm: { registerAdapter: vi.fn(() => registration) },
			get: vi.fn(() => undefined),
			inject: vi.fn((services: readonly string[], callback: (ctx: Context) => void) => {
				if (services.length === 0) return runFiber(() => callback(context));
				if (services.length === 1 && services[0] === "llm") return runFiber(() => callback(context));
				if (services.length === 1 && services[0] === "settings") {
					settingsInjection = callback;
					return runFiber();
				}
				if (services.length === 1 && services[0] === "web") return runFiber(() => callback(webCtx));
				if (services.length === 1 && services[0] === "webServer") return runFiber(() => callback(requiredWeb));
				return runFiber();
			}),
		} as unknown as Context;

		apply(context, { capabilities: { codexSearch: false } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settingsInjection).toBeDefined();
		expect(registerSearchProvider).not.toHaveBeenCalled();

		const attach = (live: ReturnType<typeof liveSettings>): (() => void) => {
			let release = (): void => undefined;
			const child = {
				get: vi.fn((service: string) => (service === "settings" ? live.service : undefined)),
				effect: vi.fn((setup: () => () => void) => {
					release = setup();
				}),
				inject: vi.fn(),
			} as unknown as Context;
			settingsInjection!(child);
			return () => release();
		};

		const first = liveSettings({ codexSearch: true });
		attach(first);
		expect(first.watcherCount()).toBe(1);
		expect(registerSearchProvider).toHaveBeenCalledOnce();

		const second = liveSettings({ codexSearch: false });
		const releaseSecond = attach(second);
		expect(first.watcherCount()).toBe(0);
		expect(searchReleases[0]).toHaveBeenCalledOnce();
		first.set({ codexSearch: true });
		expect(registerSearchProvider).toHaveBeenCalledOnce();

		second.set({ codexSearch: true });
		expect(registerSearchProvider).toHaveBeenCalledTimes(2);
		releaseSecond();
		expect(second.watcherCount()).toBe(0);
		expect(searchReleases[1]).toHaveBeenCalledOnce();
	});

	it("follows document events for a context-derived entry id and releases them across settings churn", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockResolvedValue(undefined);
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockResolvedValue(undefined);
		vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
		const entryNamespace = "custom-oauth-entry";
		const registration = Object.assign(vi.fn(), { replace: vi.fn() });
		const searchReleases: ReturnType<typeof vi.fn>[] = [];
		const registerSearchProvider = vi.fn(() => {
			const release = vi.fn();
			searchReleases.push(release);
			return release;
		});
		const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();
		const webServerCtx = {
			webServer: {
				register: vi.fn((route: { path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }) => {
					routes.set(route.path, route.handler);
					return () => {
						routes.delete(route.path);
					};
				}),
			},
			get: vi.fn(() => undefined),
			effect: vi.fn((setup: () => unknown) => setup()),
		} as unknown as Context;
		let settingsInjection: ((ctx: Context) => void) | undefined;
		const webCtx = {
			get: vi.fn((service: string) => (service === "web" ? { registerSearchProvider } : undefined)),
			effect: vi.fn((setup: () => unknown) => setup()),
		} as unknown as Context;
		// The loader entry sits on an ancestor fiber; the owned runtime is an injected child.
		const root = {
			fiber: { entry: { id: "nested/path", options: { id: entryNamespace, name: "dsh-coding-subscription-oauth" } } },
		};
		const context = {
			fiber: { parent: root },
			webServer: webServerCtx.webServer,
			logger: () => ({ warn: vi.fn() }),
			emit: vi.fn(),
			effect: vi.fn((setup: () => unknown) => setup()),
			llm: { registerAdapter: vi.fn(() => registration) },
			get: vi.fn(() => undefined),
			inject: vi.fn((services: readonly string[], callback: (ctx: Context) => void) => {
				if (services.length === 0) return runFiber(() => callback(context));
				if (services.length === 1 && services[0] === "llm") return runFiber(() => callback(context));
				if (services.length === 1 && services[0] === "settings") {
					settingsInjection = callback;
					return runFiber();
				}
				if (services.length === 1 && services[0] === "web") return runFiber(() => callback(webCtx));
				if (services.length === 1 && services[0] === "webServer") return runFiber(() => callback(webServerCtx));
				return runFiber();
			}),
		} as unknown as Context;

		apply(context, { capabilities: { codexSearch: false } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settingsInjection).toBeDefined();
		expect(registerSearchProvider).not.toHaveBeenCalled();

		const attach = () => {
			const entries: Record<string, { capabilities: CapabilitySettingsPatch; revision: number }> = {
				// The hard-coded default id must not be read or written once the loader names the entry.
				"llm-grok-build-oauth": { capabilities: { codexSearch: true }, revision: 50 },
				[entryNamespace]: { capabilities: { codexSearch: false }, revision: 0 },
			};
			const listeners = new Set<(ns: string, revision: number) => void>();
			const emit = (ns: string): void => {
				for (const listener of [...listeners]) listener(ns, entries[ns]!.revision);
			};
			const mutate = vi.fn(async (ns: string, ops: readonly CapabilitySettingsPathOp[], expected?: number) => {
				const entry = entries[ns];
				if (entry === undefined || expected !== entry.revision) throw new Error("rejected write");
				const next: Record<string, unknown> = { ...entry.capabilities };
				for (const op of ops) if (op.path.length === 2) next[op.path[1]!] = op.value;
				entry.capabilities = next as CapabilitySettingsPatch;
				entry.revision++;
				emit(ns);
			});
			const service: CapabilitySettingsService = {
				writable: true,
				describe: () =>
					Object.entries(entries).map(([ns, entry]) => ({
						ns,
						revision: entry.revision,
						value: { capabilities: { ...entry.capabilities } },
						base: { capabilities: {} },
						user: { capabilities: { ...entry.capabilities } },
					})),
				mutate,
			};
			let release = (): void => undefined;
			settingsInjection!({
				get: vi.fn((name: string) => (name === "settings" ? service : undefined)),
				on: vi.fn((event: string, listener: (ns: string, revision: number) => void) => {
					expect(event).toBe("settings/document-updated");
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				}),
				effect: vi.fn((setup: () => () => void) => {
					release = setup();
				}),
				inject: vi.fn(),
			} as unknown as Context);
			return {
				mutate,
				count: () => listeners.size,
				release: () => release(),
				set(ns: string, capabilities: CapabilitySettingsPatch) {
					entries[ns]!.capabilities = capabilities;
					entries[ns]!.revision++;
					emit(ns);
				},
			};
		};

		const first = attach();
		expect(first.count()).toBe(1);
		expect(registerSearchProvider).not.toHaveBeenCalled();
		// Events for another entry never reconcile.
		first.set("llm-grok-build-oauth", { codexSearch: true });
		await Promise.resolve();
		expect(registerSearchProvider).not.toHaveBeenCalled();
		first.set(entryNamespace, { codexSearch: true });
		await Promise.resolve();
		expect(registerSearchProvider).toHaveBeenCalledOnce();

		// Writes address the context-derived entry with its revision.
		const req = Readable.from([JSON.stringify({ expectedRevision: 1, patch: { codexImages: true } })]);
		Object.defineProperties(req, {
			method: { value: "PATCH" },
			headers: { value: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" } },
			socket: { value: { remoteAddress: "127.0.0.1" } },
		});
		const res = { status: 0, body: "", writeHead: vi.fn(), end: vi.fn() };
		res.writeHead.mockImplementation((status: number) => {
			res.status = status;
			return res;
		});
		res.end.mockImplementation((body?: string) => {
			res.body += body ?? "";
			return res;
		});
		await routes.get(CAPABILITY_SETTINGS_PATH)!(req as unknown as IncomingMessage, res as unknown as ServerResponse);
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toMatchObject({ revision: 2, value: { codexSearch: true, codexImages: true } });
		expect(first.mutate).toHaveBeenCalledWith(
			entryNamespace,
			[{ op: "set", path: ["capabilities", "codexImages"], value: true }],
			1,
		);

		const second = attach();
		expect(first.count()).toBe(0);
		expect(second.count()).toBe(1);
		expect(searchReleases[0]).toHaveBeenCalledOnce();
		first.release(); // A late obsolete fiber disposer must not release the new bridge.
		expect(second.count()).toBe(1);
		first.set(entryNamespace, { codexSearch: true });
		await Promise.resolve();
		expect(registerSearchProvider).toHaveBeenCalledOnce();
		second.set(entryNamespace, { codexSearch: true });
		await Promise.resolve();
		expect(registerSearchProvider).toHaveBeenCalledTimes(2);
		second.release();
		expect(second.count()).toBe(0);
		expect(searchReleases[1]).toHaveBeenCalledOnce();
	});

	it("falls back to the plugin name when the inherited loader entry belongs to another plugin", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockResolvedValue(undefined);
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockResolvedValue(undefined);
		vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
		const foreignEntry = "host-plugin-entry";
		const registerSearchProvider = vi.fn(() => vi.fn());
		const webCtx = {
			get: vi.fn((service: string) => (service === "web" ? { registerSearchProvider } : undefined)),
			effect: vi.fn((setup: () => unknown) => setup()),
		} as unknown as Context;
		let settingsInjection: ((ctx: Context) => void) | undefined;
		// Another plugin's ctx.plugin() started this one, so the nearest entry is that plugin's.
		const root = { fiber: { entry: { options: { id: foreignEntry, name: "another-dsh-plugin" } } } };
		const context = {
			fiber: { parent: root },
			webServer: requiredWebContext().webServer,
			logger: () => ({ warn: vi.fn() }),
			emit: vi.fn(),
			effect: vi.fn((setup: () => unknown) => setup()),
			llm: { registerAdapter: vi.fn(() => Object.assign(vi.fn(), { replace: vi.fn() })) },
			get: vi.fn(() => undefined),
			inject: vi.fn((services: readonly string[], callback: (ctx: Context) => void) => {
				if (services.length === 1 && services[0] === "settings") {
					settingsInjection = callback;
					return runFiber();
				}
				if (services.length === 1 && services[0] === "web") return runFiber(() => callback(webCtx));
				if (services.length === 1 && services[0] === "webServer") {
					return runFiber(() => callback(requiredWebContext()));
				}
				if (services.length === 0 || (services.length === 1 && services[0] === "llm")) {
					return runFiber(() => callback(context));
				}
				return runFiber();
			}),
		} as unknown as Context;

		apply(context, { capabilities: { codexSearch: false } });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settingsInjection).toBeDefined();

		const entries: Record<string, { capabilities: CapabilitySettingsPatch; revision: number }> = {
			[foreignEntry]: { capabilities: { codexSearch: false }, revision: 0 },
			"llm-grok-build-oauth": { capabilities: { codexSearch: false }, revision: 0 },
		};
		const listeners = new Set<(ns: string, revision: number) => void>();
		const set = (ns: string, capabilities: CapabilitySettingsPatch): void => {
			entries[ns]!.capabilities = capabilities;
			entries[ns]!.revision++;
			for (const listener of [...listeners]) listener(ns, entries[ns]!.revision);
		};
		const service: CapabilitySettingsService = {
			writable: true,
			describe: () =>
				Object.entries(entries).map(([ns, entry]) => ({
					ns,
					revision: entry.revision,
					value: { capabilities: { ...entry.capabilities } },
				})),
			mutate: vi.fn(async () => undefined),
		};
		settingsInjection!({
			get: vi.fn((name: string) => (name === "settings" ? service : undefined)),
			on: vi.fn((_event: string, listener: (ns: string, revision: number) => void) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			}),
			effect: vi.fn((setup: () => unknown) => setup()),
			inject: vi.fn(),
		} as unknown as Context);

		set(foreignEntry, { codexSearch: true });
		await Promise.resolve();
		expect(registerSearchProvider).not.toHaveBeenCalled();
		set("llm-grok-build-oauth", { codexSearch: true });
		await Promise.resolve();
		expect(registerSearchProvider).toHaveBeenCalledOnce();
	});

	it("aborts the Imagine client before asynchronous media cleanup during injected-service teardown", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockResolvedValue(undefined);
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockResolvedValue(undefined);
		vi.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog").mockResolvedValue(undefined);
		const order: string[] = [];
		const originalDispose = GrokImagineClient.prototype.dispose;
		vi.spyOn(GrokImagineClient.prototype, "dispose").mockImplementation(function disposeImagine(
			this: GrokImagineClient,
		) {
			order.push("dispose");
			originalDispose.call(this);
		});
		vi.spyOn(MediaStore.prototype, "cleanup").mockImplementation(async () => {
			order.push("cleanup");
			return { expiredArtifacts: 0, removedObjects: 0 };
		});
		const effects: Array<{ label?: string; setup: () => unknown }> = [];
		const pending: Promise<unknown>[] = [];
		const attachments = {
			imageLimits: {
				maxImageBytes: 1024,
				maxImagesPerMessage: 4,
				maxMessageImageBytes: 4096,
				mediaTypes: ["image/png"],
			},
			validateImage: async () => undefined,
			saveImage: async () => ({
				attachmentId: `sha256:${"ab".repeat(32)}`,
				mediaType: "image/png",
				bytes: 1,
				width: 1,
				height: 1,
			}),
			readImage: async () => {
				throw new Error("not used");
			},
		};
		const services: Record<string, unknown> = {
			tools: { register: vi.fn(() => vi.fn()) },
			attachments,
			credentials: { resolve: async () => undefined },
			webServer: { register: vi.fn(() => vi.fn()) },
		};
		const toolCtx = {
			...services,
			get: vi.fn((service: string) => services[service]),
			effect: vi.fn((setup: () => unknown, label?: string) => {
				effects.push({ setup, ...(label === undefined ? {} : { label }) });
			}),
		} as unknown as Context;
		const registration = Object.assign(vi.fn(), { replace: vi.fn() });
		const context = {
			logger: () => ({ warn: vi.fn() }),
			emit: vi.fn(),
			effect: vi.fn(),
			llm: {
				registerAdapter: vi.fn(() => registration),
				resolveModelInfo: vi.fn(),
			},
			get: vi.fn(() => undefined),
			inject: vi.fn((requested: readonly string[], callback: (ctx: Context) => unknown) => {
				if (requested.length === 0) return runFiber(() => callback(context));
				if (requested.length === 1 && requested[0] === "llm") return runFiber(() => callback(context));
				if (requested.length === 1 && requested[0] === "webServer") return runFiber(() => callback(toolCtx));
				if (requested.join(",") !== "tools,attachments,credentials,webServer") return runFiber();
				const fiber = runFiber(() => callback(toolCtx));
				pending.push(fiber.await());
				return fiber;
			}),
		} as unknown as Context;

		apply(context, {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		await Promise.all(pending);
		order.length = 0;
		expect(effects.some((effect) => effect.label?.includes("imagine download routes") === true)).toBe(true);
		const lifetime = effects.find((effect) => effect.label?.includes("Imagine client and media lifetime") === true);
		expect(lifetime).toBeDefined();
		const dispose = lifetime!.setup();
		expect(dispose).toBeTypeOf("function");
		await (dispose as () => void | Promise<void>)();
		expect(order).toEqual(["dispose", "cleanup"]);
	});

	it("contains cache and refresh failures while registering the adapter", async () => {
		vi.spyOn(GrokBuildSession.prototype, "loadCachedCatalog").mockRejectedValue(new Error("grok cache failed"));
		vi.spyOn(OAuthProviderSession.prototype, "loadCachedModels").mockRejectedValue(new Error("oauth cache failed"));
		const refresh = vi
			.spyOn(GrokBuildSession.prototype, "refreshLiveCatalog")
			.mockRejectedValue(new Error("refresh failed"));
		const warn = vi.fn();
		const registration = Object.assign(vi.fn(), { replace: vi.fn() });
		const registerAdapter = vi.fn(() => registration);
		const requiredWeb = requiredWebContext();
		const context = {
			webServer: requiredWeb.webServer,
			logger: () => ({ warn }),
			emit: vi.fn(),
			effect: vi.fn((setup: () => unknown) => setup()),
			llm: { registerAdapter },
			get: vi.fn(() => undefined),
			inject: vi.fn((requested: readonly string[], callback: (ctx: Context) => unknown) => {
				if (requested.length === 0) return runFiber(() => callback(context));
				if (requested.length === 1 && requested[0] === "llm") return runFiber(() => callback(context));
				if (requested.length === 1 && requested[0] === "webServer") return runFiber(() => callback(requiredWeb));
				return runFiber();
			}),
		} as unknown as Context;

		apply(context, {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(registerAdapter).toHaveBeenCalledOnce();

		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(refresh).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith("one or more OAuth model caches could not be loaded; using in-memory fallbacks");
		expect(warn).toHaveBeenCalledWith("background OAuth model catalog initialization failed; using static fallbacks");
	});
});
