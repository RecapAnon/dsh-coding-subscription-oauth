import { describe, expect, it, vi } from "vitest";
import {
	CAPABILITY_SETTINGS_DOCUMENT_EVENT,
	type CapabilitySettingsDescriptor,
	type CapabilitySettingsDocumentEvents,
	type CapabilitySettingsPathOp,
	type CapabilitySettingsScope,
	type CapabilitySettingsService,
	capabilityEntryNamespace,
	createCapabilitySettingsController,
	DEFAULT_CAPABILITY_SETTINGS,
} from "../src/capability-settings.ts";

const ENTRY = "oauth-instance";

/** 0.2.x form host stand-in: one descriptor per profile entry, no register(). */
class FormHost implements CapabilitySettingsService {
	writable = true;
	revision = 0;
	capabilities: Record<string, unknown> = {};
	describeCalls = 0;
	readonly mutate = vi.fn(async (_ns: string, ops: readonly CapabilitySettingsPathOp[], expected?: number) => {
		if (expected !== this.revision) throw new Error("conflict");
		for (const op of ops) {
			if (op.path[0] === "capabilities" && op.path.length === 2) this.capabilities[op.path[1]!] = op.value;
		}
		this.revision++;
	});

	describe(): CapabilitySettingsDescriptor[] {
		this.describeCalls++;
		return [
			{ ns: "another-plugin", value: { capabilities: { codexFast: true } }, revision: 42 },
			{ ns: ENTRY, value: { capabilities: { ...this.capabilities } }, revision: this.revision },
		];
	}

	/** Simulate an edit made outside this controller (Settings UI, another client). */
	external(capabilities: Record<string, unknown>): void {
		this.capabilities = capabilities;
		this.revision++;
	}
}

/** Structural `ctx.on()` event source with listener bookkeeping. */
function eventSource(): CapabilitySettingsDocumentEvents & {
	emit(ns: string, revision: number): void;
	size(): number;
} {
	const listeners = new Set<(ns: string, revision: number) => void>();
	return {
		on: vi.fn((name: string, listener: (ns: string, revision: number) => void) => {
			expect(name).toBe(CAPABILITY_SETTINGS_DOCUMENT_EVENT);
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}),
		emit(ns, revision) {
			for (const listener of [...listeners]) listener(ns, revision);
		},
		size: () => listeners.size,
	};
}

describe("capability settings document events", () => {
	it("reconciles an external edit of the owning entry once per microtask", async () => {
		const host = new FormHost();
		const events = eventSource();
		const controller = createCapabilitySettingsController({
			settings: host,
			entryNamespace: ENTRY,
			documentEvents: events,
		});
		const seen = vi.fn();
		controller.subscribe(seen);
		expect(events.size()).toBe(1);

		host.external({ codexFast: true });
		events.emit(ENTRY, host.revision);
		events.emit(ENTRY, host.revision);
		// Deferred: the host's own describe() may emit synchronously.
		expect(seen).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(seen).toHaveBeenCalledOnce();
		expect(seen.mock.calls[0]![0]).toMatchObject({ revision: 1, value: { codexFast: true } });
		expect(controller.current()).toEqual({ ...DEFAULT_CAPABILITY_SETTINGS, codexFast: true });
	});

	it("publishes an external edit first observed by snapshot() while describe() emits the event", async () => {
		const events = eventSource();
		/** DSH 0.2.0-rc.2 announces a changed document from inside describe(). */
		class EmittingHost extends FormHost {
			private announced = 0;
			override describe(): CapabilitySettingsDescriptor[] {
				const descriptors = super.describe();
				if (this.revision !== this.announced) {
					this.announced = this.revision;
					events.emit(ENTRY, this.revision);
				}
				return descriptors;
			}
		}
		const host = new EmittingHost();
		const controller = createCapabilitySettingsController({
			settings: host,
			entryNamespace: ENTRY,
			documentEvents: events,
		});
		const seen = vi.fn();
		controller.subscribe(seen);

		host.external({ codexFast: true });
		// A route read is the first describe() after the edit, so it raises the event.
		expect(controller.snapshot().value.codexFast).toBe(true);
		expect(controller.current().codexFast).toBe(true);
		expect(seen).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(seen).toHaveBeenCalledOnce();
		expect(seen.mock.calls[0]![0]).toMatchObject({ revision: 1, value: { codexFast: true } });

		// An unchanged reconcile must not deliver the same snapshot again.
		expect(controller.reconcile().value.codexFast).toBe(true);
		await Promise.resolve();
		expect(seen).toHaveBeenCalledOnce();
	});

	it("ignores events for another profile entry", async () => {
		const host = new FormHost();
		const events = eventSource();
		const controller = createCapabilitySettingsController({
			settings: host,
			entryNamespace: ENTRY,
			documentEvents: events,
		});
		const seen = vi.fn();
		controller.subscribe(seen);
		host.external({ codexFast: true });
		const calls = host.describeCalls;
		events.emit("another-plugin", 43);
		await Promise.resolve();
		expect(host.describeCalls).toBe(calls);
		expect(seen).not.toHaveBeenCalled();
	});

	it("releases the event listener on dispose and drops an already queued reconcile", async () => {
		const host = new FormHost();
		const events = eventSource();
		const errors = vi.fn();
		const controller = createCapabilitySettingsController({
			settings: host,
			entryNamespace: ENTRY,
			documentEvents: events,
			onListenerError: errors,
		});
		const seen = vi.fn();
		controller.subscribe(seen);
		host.external({ codexFast: true });
		events.emit(ENTRY, host.revision);
		controller.dispose();
		controller.dispose();
		await Promise.resolve();
		expect(events.size()).toBe(0);
		expect(seen).not.toHaveBeenCalled();
		expect(errors).not.toHaveBeenCalled();
	});

	it("contains a failing reconcile and reports it through onListenerError", async () => {
		const host = new FormHost();
		const events = eventSource();
		const errors = vi.fn();
		const controller = createCapabilitySettingsController({
			settings: host,
			entryNamespace: ENTRY,
			documentEvents: events,
			onListenerError: errors,
		});
		const failure = new Error("reconcile failed");
		vi.spyOn(controller, "reconcile").mockImplementation(() => {
			throw failure;
		});
		events.emit(ENTRY, 1);
		await Promise.resolve();
		expect(errors).toHaveBeenCalledWith(failure);
	});

	it("does not subscribe when a register() watcher already reconciles", () => {
		const scope: CapabilitySettingsScope = {
			get: () => ({}),
			watch: () => () => undefined,
			update: async () => undefined,
			replace: async () => undefined,
		};
		const events = eventSource();
		const controller = createCapabilitySettingsController({
			settings: { writable: true, describe: () => [], register: () => scope },
			documentEvents: events,
		});
		expect(events.on).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("keeps working on hosts without an event API", async () => {
		const host = new FormHost();
		for (const documentEvents of [undefined, {} as CapabilitySettingsDocumentEvents]) {
			const controller = createCapabilitySettingsController({ settings: host, entryNamespace: ENTRY, documentEvents });
			const next = await controller.patch({ codexSearch: true }, host.revision);
			expect(next.value.codexSearch).toBe(true);
			controller.dispose();
		}
	});
});

describe("capability settings expectedRevision", () => {
	it("rejects values that are not non-negative integers before writing", async () => {
		const host = new FormHost();
		const controller = createCapabilitySettingsController({ settings: host, entryNamespace: ENTRY });
		for (const revision of [Number.NaN, -1, 0.5, Number.POSITIVE_INFINITY, { revision: 0 } as unknown as number]) {
			await expect(controller.patch({ codexFast: true }, revision)).rejects.toThrow(
				new TypeError("capability settings expectedRevision must be a non-negative integer"),
			);
			await expect(controller.replace({}, revision)).rejects.toBeInstanceOf(TypeError);
		}
		expect(host.mutate).not.toHaveBeenCalled();
		await controller.patch({ codexFast: true }, 0);
		expect(host.mutate).toHaveBeenCalledOnce();
	});
});

describe("capabilityEntryNamespace", () => {
	it("reads the owning loader entry id through injected child contexts", () => {
		const owner = { fiber: { entry: { id: "nested/path", options: { id: ENTRY } } } };
		const child = { fiber: { parent: { fiber: { parent: owner } } } };
		expect(capabilityEntryNamespace(owner)).toBe(ENTRY);
		expect(capabilityEntryNamespace(child)).toBe(ENTRY);
	});

	it("accepts only non-empty string ids and stops on cycles", () => {
		expect(capabilityEntryNamespace(undefined)).toBeUndefined();
		expect(capabilityEntryNamespace({})).toBeUndefined();
		expect(capabilityEntryNamespace({ fiber: {} })).toBeUndefined();
		expect(capabilityEntryNamespace({ fiber: { entry: { options: { id: "" } } } })).toBeUndefined();
		expect(capabilityEntryNamespace({ fiber: { entry: { options: { id: 7 } } } })).toBeUndefined();
		const cyclic: { fiber: { parent?: unknown } } = { fiber: {} };
		cyclic.fiber.parent = cyclic;
		expect(capabilityEntryNamespace(cyclic)).toBeUndefined();
		const hostile = {
			get fiber(): never {
				throw new Error("torn down");
			},
		};
		expect(capabilityEntryNamespace(hostile)).toBeUndefined();
	});
});
